import type {
  RateLimitBucketDescriptor,
  RateLimitBucketSnapshot,
  RateLimiter,
  RateLimitPlan,
  RateLimitRequestContext,
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
  EndpointRateLimitState,
  ReactiveRateLimiterOptions,
} from "./rate-limiter/types.ts";
import { cloneUsage, usageForBucket } from "./rate-limiter/usage.ts";

const DEFAULT_RATE_LIMIT_MS = 0;
const DEFAULT_BAN_MS = 60_000;
const MIN_RATE_LIMIT_BLOCK_MS = 1;
const DEFAULT_UTILIZATION_TARGET = 0.9;

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

  async beforeRequest(ctx: RateLimitRequestContext): Promise<void> {
    const plan = this.getKnownPlan(ctx);
    if (!plan) {
      await this.sleepForEndpointBlock(ctx.scope);
      return;
    }

    this.rememberPlan(ctx.scope, plan.id);
    while (true) {
      const blockedUntil = this.getPlanBlockedUntil(ctx.scope, plan);
      if (blockedUntil === undefined || blockedUntil <= this.now()) {
        return;
      }

      await this.sleep(Math.max(0, blockedUntil - this.now()));
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
        this.updateBucketUsage(ctx.scope, plan, response.usage);
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
    if (plan) {
      this.rememberPlan(ctx.scope, plan.id);
      if (error.usage) {
        this.updateBucketUsage(ctx.scope, plan, error.usage);
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

  private getPlanBlockedUntil(
    scope: RateLimitScope,
    plan: RateLimitPlan,
  ): number | undefined {
    let blockedUntil: number | undefined;
    for (const bucket of this.getPlanBuckets(plan)) {
      const state = this.getBucketState(scope, bucket);
      if (
        state?.blockedUntil !== undefined &&
        state.blockedUntil > this.now()
      ) {
        blockedUntil = maxOptional(blockedUntil, state.blockedUntil);
      }
    }

    return blockedUntil;
  }

  private updateBucketUsage(
    scope: RateLimitScope,
    plan: RateLimitPlan,
    usage: RateLimitUsage,
  ): void {
    for (const bucket of this.getPlanBuckets(plan)) {
      const used = usageForBucket(usage, bucket);
      if (used === undefined) {
        continue;
      }

      const existing = this.getBucketState(scope, bucket);
      const hasActiveBlock =
        existing?.blockedUntil !== undefined &&
        existing.blockedUntil > this.now();
      this.updateBucketState(scope, bucket, {
        used,
        state: hasActiveBlock ? existing.state : "ok",
      });
    }
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

  private getBucketState(
    scope: RateLimitScope,
    bucket: RateLimitBucketDescriptor,
  ): BucketRateLimitState | undefined {
    return this.bucketStates.get(bucketStateKey(scope, bucket));
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
    for (const bucket of this.getPlanBuckets(plan)) {
      const state = this.getBucketState(scope, bucket);
      if (!state) {
        continue;
      }

      snapshots.push(this.createBucketSnapshot(bucket, state));
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
