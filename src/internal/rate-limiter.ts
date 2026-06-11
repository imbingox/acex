import type {
  RateLimitBucketDescriptor,
  RateLimitBucketSnapshot,
  RateLimiter,
  RateLimitPlan,
  RateLimitPriority,
  RateLimitRequestContext,
  RateLimitReservation,
  RateLimitResponseContext,
  RateLimitScope,
  RateLimitSnapshot,
  RateLimitTopology,
  RateLimitTopologyRegistry,
  RateLimitTransportErrorContext,
  RateLimitUsage,
} from "../types/index.ts";
import { aggregateBucketSnapshots } from "./rate-limiter/snapshot.ts";
import {
  bucketStateKey,
  maxOptional,
  nextRateLimitState,
  nextRetryAfterMs,
  scopeKey,
  windowEndMs,
  windowStartMs,
} from "./rate-limiter/state.ts";
import {
  bucketDescriptorsEqual,
  cloneBucketDescriptor,
  clonePlan,
  plansEqual,
  uniqueStrings,
  validateBucketDescriptor,
  validatePlan,
} from "./rate-limiter/topology.ts";
import type {
  BucketRateLimitState,
  BudgetRateLimitReservation,
  EndpointRateLimitState,
  ReactiveRateLimiterOptions,
} from "./rate-limiter/types.ts";
import { cloneUsage, usageForBucket } from "./rate-limiter/usage.ts";

const DEFAULT_RATE_LIMIT_MS = 0;
const DEFAULT_BAN_MS = 60_000;
const MIN_RATE_LIMIT_BLOCK_MS = 1;
const DEFAULT_UTILIZATION_TARGET = 0.9;

interface PlanBucketCost {
  bucket: RateLimitBucketDescriptor;
  cost: number;
  stateKey: string;
}

type AdmissionResult =
  | {
      admitted: true;
      reservation: BudgetRateLimitReservation;
    }
  | {
      admitted: false;
      retryAt: number;
    };

export class BudgetRateLimiter
  implements RateLimiter, RateLimitTopologyRegistry
{
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultRateLimitMs: number;
  private readonly defaultBanMs: number;
  private readonly utilizationTarget: number;
  private readonly endpointStates = new Map<string, EndpointRateLimitState>();
  private readonly bucketDescriptors = new Map<
    string,
    RateLimitBucketDescriptor
  >();
  private readonly plans = new Map<string, RateLimitPlan>();
  private readonly bucketStates = new Map<string, BucketRateLimitState>();
  private readonly lastPlanIdByScope = new Map<string, string>();

  constructor(options: ReactiveRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.defaultRateLimitMs =
      options.defaultRateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.defaultBanMs = options.defaultBanMs ?? DEFAULT_BAN_MS;
    this.utilizationTarget = normalizeUtilizationTarget(
      options.utilizationTarget,
    );
  }

  registerRateLimitTopology(topology: RateLimitTopology): void {
    const nextBuckets = new Map(this.bucketDescriptors);

    for (const bucket of topology.buckets) {
      validateBucketDescriptor(bucket);
      const existing = nextBuckets.get(bucket.id);
      if (existing) {
        if (!bucketDescriptorsEqual(existing, bucket)) {
          throw new Error(
            `Conflicting rate limit bucket descriptor: ${bucket.id}`,
          );
        }
        continue;
      }

      nextBuckets.set(bucket.id, cloneBucketDescriptor(bucket));
    }

    const nextPlans = new Map(this.plans);
    for (const plan of topology.plans) {
      validatePlan(plan, nextBuckets);
      const existing = nextPlans.get(plan.id);
      if (existing) {
        if (!plansEqual(existing, plan)) {
          throw new Error(`Conflicting rate limit plan: ${plan.id}`);
        }
        continue;
      }

      nextPlans.set(plan.id, clonePlan(plan));
    }

    this.bucketDescriptors.clear();
    for (const [id, bucket] of nextBuckets) {
      this.bucketDescriptors.set(id, bucket);
    }

    this.plans.clear();
    for (const [id, plan] of nextPlans) {
      this.plans.set(id, plan);
    }
  }

  async beforeRequest(
    ctx: RateLimitRequestContext,
  ): Promise<RateLimitReservation | undefined> {
    const plan = this.getKnownPlan(ctx);
    if (!plan) {
      await this.sleepForEndpointBlock(ctx.scope);
      return;
    }

    this.rememberPlan(ctx.scope, plan.id);
    while (true) {
      const admission = this.tryAdmit(
        ctx.scope,
        plan,
        this.resolvePriority(ctx, plan),
      );
      if (admission.admitted) {
        return admission.reservation;
      }

      await this.sleep(Math.max(0, admission.retryAt - this.now()));
    }
  }

  afterResponse(
    ctx: RateLimitRequestContext,
    response: RateLimitResponseContext,
  ): void {
    const plan = this.getKnownPlan(ctx);
    if (plan) {
      this.rememberPlan(ctx.scope, plan.id);
      if (response.usage) {
        this.updateBucketUsage(
          ctx.scope,
          plan,
          response.usage,
          response.reservation,
        );
      }
    }

    if (response.usage) {
      const existing = this.getEndpointState(ctx.scope);
      const hasActiveBlock =
        existing?.blockedUntil !== undefined &&
        existing.blockedUntil > this.now();
      this.updateEndpointState(ctx.scope, {
        usage: cloneUsage(response.usage),
        state: hasActiveBlock ? existing.state : "ok",
      });
    }
  }

  onTransportError(
    ctx: RateLimitRequestContext,
    error: RateLimitTransportErrorContext,
  ): void {
    const plan = this.getKnownPlan(ctx);
    if (error.requestNotSent) {
      this.refundReservation(error.reservation);
    }

    if (plan) {
      this.rememberPlan(ctx.scope, plan.id);
      if (error.usage) {
        this.updateBucketUsage(ctx.scope, plan, error.usage, error.reservation);
      }
    }

    if (error.usage) {
      this.updateEndpointState(ctx.scope, {
        usage: cloneUsage(error.usage),
      });
    }

    if (error.status !== 429 && error.status !== 418) {
      return;
    }

    if (!plan) {
      this.blockEndpoint(ctx.scope, error);
      return;
    }

    const affectedBuckets = this.getAffectedBuckets(plan, error.status);
    if (affectedBuckets.length === 0) {
      this.blockEndpoint(ctx.scope, error);
      return;
    }

    for (const bucket of affectedBuckets) {
      this.blockBucket(ctx.scope, bucket, error);
    }
  }

  getSnapshot(scope: RateLimitScope): RateLimitSnapshot | undefined {
    const endpointState = this.getEndpointState(scope);
    const bucketSnapshots = this.getBucketSnapshots(scope);
    if (!endpointState && bucketSnapshots.length === 0) {
      return undefined;
    }

    const endpointSnapshot = endpointState
      ? this.createEndpointSnapshot(scope, endpointState)
      : {
          scope: { ...scope },
          state: "ok" as const,
        };

    const aggregate = aggregateBucketSnapshots(
      endpointSnapshot,
      bucketSnapshots,
    );

    return {
      ...endpointSnapshot,
      ...aggregate,
      buckets: bucketSnapshots.length > 0 ? bucketSnapshots : undefined,
    };
  }

  private async sleepForEndpointBlock(scope: RateLimitScope): Promise<void> {
    while (true) {
      const snapshot = this.getSnapshot(scope);
      if (!snapshot?.blockedUntil || snapshot.blockedUntil <= this.now()) {
        return;
      }

      await this.sleep(Math.max(0, snapshot.blockedUntil - this.now()));
    }
  }

  private getKnownPlan(
    ctx: RateLimitRequestContext,
  ): RateLimitPlan | undefined {
    return ctx.planId ? this.plans.get(ctx.planId) : undefined;
  }

  private rememberPlan(scope: RateLimitScope, planId: string): void {
    this.lastPlanIdByScope.set(scopeKey(scope), planId);
  }

  private resolvePriority(
    ctx: RateLimitRequestContext,
    plan: RateLimitPlan,
  ): RateLimitPriority {
    return ctx.priority ?? plan.priority ?? "normal";
  }

  private tryAdmit(
    scope: RateLimitScope,
    plan: RateLimitPlan,
    priority: RateLimitPriority,
  ): AdmissionResult {
    const now = this.now();
    const bucketCosts = this.getPlanBucketCosts(scope, plan);
    let retryAt: number | undefined;

    for (const bucketCost of bucketCosts) {
      const state = this.rolloverBucketState(bucketCost, now);
      if (state.blockedUntil !== undefined && state.blockedUntil > now) {
        retryAt = maxOptional(retryAt, state.blockedUntil);
        continue;
      }

      if (bucketCost.cost <= 0) {
        continue;
      }

      const limit = this.effectiveLimit(bucketCost.bucket, priority);
      const used = state.used ?? 0;
      if (used + bucketCost.cost > limit) {
        retryAt = maxOptional(
          retryAt,
          windowEndMs(state.windowStartMs ?? 0, bucketCost.bucket.intervalMs),
        );
      }
    }

    if (retryAt !== undefined && retryAt > now) {
      return {
        admitted: false,
        retryAt,
      };
    }

    const reservationBuckets = bucketCosts.map((bucketCost) => {
      const state = this.rolloverBucketState(bucketCost, now);
      if (bucketCost.cost > 0) {
        this.updateBucketState(scope, bucketCost.bucket, {
          used: (state.used ?? 0) + bucketCost.cost,
          windowStartMs: state.windowStartMs,
          state: "ok",
        });
      }

      return {
        bucketId: bucketCost.bucket.id,
        stateKey: bucketCost.stateKey,
        cost: bucketCost.cost,
        windowStartMs:
          state.windowStartMs ??
          windowStartMs(now, bucketCost.bucket.intervalMs),
      };
    });

    return {
      admitted: true,
      reservation: {
        admittedAt: now,
        planId: plan.id,
        priority,
        buckets: reservationBuckets,
      },
    };
  }

  private getPlanBucketCosts(
    scope: RateLimitScope,
    plan: RateLimitPlan,
  ): PlanBucketCost[] {
    const bucketCosts: PlanBucketCost[] = [];
    const costByBucketId = new Map<string, number>();
    for (const cost of plan.costs) {
      costByBucketId.set(
        cost.bucketId,
        (costByBucketId.get(cost.bucketId) ?? 0) + cost.cost,
      );
    }

    for (const [bucketId, cost] of costByBucketId) {
      const bucket = this.bucketDescriptors.get(bucketId);
      if (!bucket) {
        continue;
      }

      bucketCosts.push({
        bucket,
        cost,
        stateKey: bucketStateKey(scope, bucket),
      });
    }

    return bucketCosts;
  }

  private rolloverBucketState(
    bucketCost: PlanBucketCost,
    now: number,
  ): BucketRateLimitState {
    const currentWindowStart = windowStartMs(now, bucketCost.bucket.intervalMs);
    const existing = this.bucketStates.get(bucketCost.stateKey);
    if (
      existing?.windowStartMs !== undefined &&
      existing.windowStartMs >= currentWindowStart
    ) {
      return existing;
    }

    const next: BucketRateLimitState = {
      blockedUntil: existing?.blockedUntil,
      retryAfterMs: existing?.retryAfterMs,
      state:
        existing?.blockedUntil !== undefined && existing.blockedUntil > now
          ? existing.state
          : "ok",
      updatedAt: now,
      used: existing?.windowStartMs === undefined ? existing?.used : 0,
      windowStartMs: currentWindowStart,
    };
    this.bucketStates.set(bucketCost.stateKey, next);
    return next;
  }

  private effectiveLimit(
    bucket: RateLimitBucketDescriptor,
    _priority: RateLimitPriority,
  ): number {
    return Math.floor(
      bucket.limit * (bucket.utilizationTarget ?? this.utilizationTarget),
    );
  }

  private updateBucketUsage(
    scope: RateLimitScope,
    plan: RateLimitPlan,
    usage: RateLimitUsage,
    reservation: RateLimitReservation | undefined,
  ): void {
    for (const bucket of this.getPlanBuckets(plan)) {
      const used = usageForBucket(usage, bucket);
      if (used === undefined) {
        continue;
      }

      const stateKey = bucketStateKey(scope, bucket);
      const reservationBucket = this.findReservationBucket(
        reservation,
        bucket.id,
        stateKey,
      );
      if (
        this.isBudgetRateLimitReservation(reservation) &&
        !reservationBucket
      ) {
        continue;
      }

      const existing = this.bucketStates.get(stateKey);
      if (
        reservationBucket &&
        existing?.windowStartMs !== undefined &&
        existing.windowStartMs > reservationBucket.windowStartMs
      ) {
        continue;
      }

      const now = this.now();
      const currentWindowStart = windowStartMs(now, bucket.intervalMs);
      const windowRolled =
        existing?.windowStartMs !== undefined &&
        existing.windowStartMs < currentWindowStart;
      const nextWindowStart = windowRolled
        ? currentWindowStart
        : (existing?.windowStartMs ?? currentWindowStart);
      const nextUsed = windowRolled
        ? used
        : Math.max(existing?.used ?? 0, used);
      const hasActiveBlock =
        existing?.blockedUntil !== undefined && existing.blockedUntil > now;
      this.updateBucketState(scope, bucket, {
        used: nextUsed,
        windowStartMs: nextWindowStart,
        state: hasActiveBlock ? existing.state : "ok",
      });
    }
  }

  private findReservationBucket(
    reservation: RateLimitReservation | undefined,
    bucketId: string,
    stateKey: string,
  ): BudgetRateLimitReservation["buckets"][number] | undefined {
    if (!this.isBudgetRateLimitReservation(reservation)) {
      return undefined;
    }

    return reservation.buckets.find(
      (bucket) => bucket.bucketId === bucketId && bucket.stateKey === stateKey,
    );
  }

  private refundReservation(
    reservation: RateLimitReservation | undefined,
  ): void {
    if (!this.isBudgetRateLimitReservation(reservation)) {
      return;
    }

    for (const reservedBucket of reservation.buckets) {
      if (reservedBucket.cost <= 0) {
        continue;
      }

      const state = this.bucketStates.get(reservedBucket.stateKey);
      if (!state || state.windowStartMs !== reservedBucket.windowStartMs) {
        continue;
      }

      this.bucketStates.set(reservedBucket.stateKey, {
        ...state,
        used: Math.max(0, (state.used ?? 0) - reservedBucket.cost),
        updatedAt: this.now(),
      });
    }
  }

  private isBudgetRateLimitReservation(
    reservation: RateLimitReservation | undefined,
  ): reservation is BudgetRateLimitReservation {
    return (
      !!reservation &&
      typeof (reservation as BudgetRateLimitReservation).admittedAt ===
        "number" &&
      Array.isArray((reservation as BudgetRateLimitReservation).buckets)
    );
  }

  private getAffectedBuckets(
    plan: RateLimitPlan,
    status: 429 | 418,
  ): RateLimitBucketDescriptor[] {
    const buckets = this.getPlanBuckets(plan);
    if (status === 418) {
      return buckets.filter((bucket) => bucket.kind === "request_weight");
    }

    const positiveCostBucketIds = uniqueStrings(
      plan.costs.filter((cost) => cost.cost > 0).map((cost) => cost.bucketId),
    );
    const bucketIds =
      positiveCostBucketIds.length > 0
        ? positiveCostBucketIds
        : uniqueStrings(plan.costs.map((cost) => cost.bucketId));

    const onlyBucketId = bucketIds[0];
    if (bucketIds.length === 1 && onlyBucketId !== undefined) {
      const bucket = this.bucketDescriptors.get(onlyBucketId);
      return bucket ? [bucket] : [];
    }

    return buckets;
  }

  private getPlanBuckets(plan: RateLimitPlan): RateLimitBucketDescriptor[] {
    const buckets: RateLimitBucketDescriptor[] = [];
    const seen = new Set<string>();
    for (const cost of plan.costs) {
      if (seen.has(cost.bucketId)) {
        continue;
      }
      seen.add(cost.bucketId);
      const bucket = this.bucketDescriptors.get(cost.bucketId);
      if (bucket) {
        buckets.push(bucket);
      }
    }

    return buckets;
  }

  private blockEndpoint(
    scope: RateLimitScope,
    error: RateLimitTransportErrorContext,
  ): void {
    const now = this.now();
    const isBan = error.status === 418;
    const retryAfterMs = this.resolveRetryAfterMs(isBan, error.retryAfterMs);
    const blockedUntil = now + retryAfterMs;

    this.updateEndpointState(scope, {
      blockedUntil,
      retryAfterMs,
      state: isBan ? "banned" : "rate_limited",
    });
  }

  private blockBucket(
    scope: RateLimitScope,
    bucket: RateLimitBucketDescriptor,
    error: RateLimitTransportErrorContext,
  ): void {
    const now = this.now();
    const isBan = error.status === 418;
    const retryAfterMs = this.resolveRetryAfterMs(isBan, error.retryAfterMs);
    const blockedUntil = now + retryAfterMs;

    this.updateBucketState(scope, bucket, {
      blockedUntil,
      retryAfterMs,
      state: isBan ? "banned" : "rate_limited",
    });
  }

  private resolveRetryAfterMs(
    isBan: boolean,
    retryAfterMs: number | undefined,
  ): number {
    return Math.max(
      MIN_RATE_LIMIT_BLOCK_MS,
      retryAfterMs ?? (isBan ? this.defaultBanMs : this.defaultRateLimitMs),
    );
  }

  private getEndpointState(
    scope: RateLimitScope,
  ): EndpointRateLimitState | undefined {
    return this.endpointStates.get(scopeKey(scope));
  }

  private updateEndpointState(
    scope: RateLimitScope,
    patch: Partial<EndpointRateLimitState>,
  ): void {
    const existing = this.getEndpointState(scope);
    const nextBlockedUntil = maxOptional(
      existing?.blockedUntil,
      patch.blockedUntil,
    );
    const patchWinsBlock =
      patch.blockedUntil !== undefined &&
      (existing?.blockedUntil === undefined ||
        patch.blockedUntil > existing.blockedUntil);
    const nextState = nextRateLimitState(
      existing?.state,
      patch.state,
      patchWinsBlock,
      nextBlockedUntil,
    );

    this.endpointStates.set(scopeKey(scope), {
      usage: patch.usage ?? existing?.usage,
      blockedUntil: nextBlockedUntil,
      retryAfterMs: nextRetryAfterMs(existing, patch, patchWinsBlock),
      state: nextState ?? "ok",
      updatedAt: this.now(),
    });
  }

  private updateBucketState(
    scope: RateLimitScope,
    bucket: RateLimitBucketDescriptor,
    patch: Partial<BucketRateLimitState>,
  ): void {
    const key = bucketStateKey(scope, bucket);
    const existing = this.bucketStates.get(key);
    const nextBlockedUntil = maxOptional(
      existing?.blockedUntil,
      patch.blockedUntil,
    );
    const patchWinsBlock =
      patch.blockedUntil !== undefined &&
      (existing?.blockedUntil === undefined ||
        patch.blockedUntil > existing.blockedUntil);
    const nextState = nextRateLimitState(
      existing?.state,
      patch.state,
      patchWinsBlock,
      nextBlockedUntil,
    );

    this.bucketStates.set(key, {
      used: patch.used ?? existing?.used,
      windowStartMs: patch.windowStartMs ?? existing?.windowStartMs,
      blockedUntil: nextBlockedUntil,
      retryAfterMs: nextRetryAfterMs(existing, patch, patchWinsBlock),
      state: nextState ?? "ok",
      updatedAt: this.now(),
    });
  }

  private createEndpointSnapshot(
    scope: RateLimitScope,
    state: EndpointRateLimitState,
  ): RateLimitSnapshot {
    const now = this.now();
    const blockedUntil =
      state.blockedUntil !== undefined && state.blockedUntil > now
        ? state.blockedUntil
        : undefined;
    const runtimeState =
      blockedUntil === undefined && state.state !== "ok" ? "ok" : state.state;

    return {
      scope: { ...scope },
      usage: state.usage ? cloneUsage(state.usage) : undefined,
      blockedUntil,
      retryAfterMs: blockedUntil ? state.retryAfterMs : undefined,
      state: runtimeState,
      updatedAt: state.updatedAt,
    };
  }

  private getBucketSnapshots(scope: RateLimitScope): RateLimitBucketSnapshot[] {
    const planId = this.lastPlanIdByScope.get(scopeKey(scope));
    const plan = planId ? this.plans.get(planId) : undefined;
    if (!plan) {
      return [];
    }

    const snapshots: RateLimitBucketSnapshot[] = [];
    for (const bucketCost of this.getPlanBucketCosts(scope, plan)) {
      const state = this.rolloverBucketState(bucketCost, this.now());

      snapshots.push(this.createBucketSnapshot(bucketCost.bucket, state));
    }

    return snapshots;
  }

  private createBucketSnapshot(
    bucket: RateLimitBucketDescriptor,
    state: BucketRateLimitState,
  ): RateLimitBucketSnapshot {
    const now = this.now();
    const blockedUntil =
      state.blockedUntil !== undefined && state.blockedUntil > now
        ? state.blockedUntil
        : undefined;
    const runtimeState =
      blockedUntil === undefined && state.state !== "ok" ? "ok" : state.state;

    return {
      bucketId: bucket.id,
      kind: bucket.kind,
      limit: bucket.limit,
      intervalMs: bucket.intervalMs,
      utilizationTarget: bucket.utilizationTarget ?? this.utilizationTarget,
      used: state.used,
      windowStartMs: state.windowStartMs,
      windowEndMs:
        state.windowStartMs !== undefined
          ? windowEndMs(state.windowStartMs, bucket.intervalMs)
          : undefined,
      blockedUntil,
      retryAfterMs: blockedUntil ? state.retryAfterMs : undefined,
      state: runtimeState,
      updatedAt: state.updatedAt,
    };
  }
}

export class ReactiveRateLimiter extends BudgetRateLimiter {}

function normalizeUtilizationTarget(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_UTILIZATION_TARGET;
  }
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error("rateLimit.utilizationTarget must be > 0 and <= 1");
  }
  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
