import type {
  RateLimiter,
  RateLimitRequestContext,
  RateLimitResponseContext,
  RateLimitScope,
  RateLimitSnapshot,
  RateLimitTransportErrorContext,
  RateLimitUsage,
} from "../types/index.ts";

interface ReactiveRateLimiterOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly defaultRateLimitMs?: number;
  readonly defaultBanMs?: number;
}

interface RateLimitState {
  usage?: RateLimitUsage;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: RateLimitSnapshot["state"];
  updatedAt?: number;
}

const DEFAULT_RATE_LIMIT_MS = 0;
const DEFAULT_BAN_MS = 60_000;

export class ReactiveRateLimiter implements RateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultRateLimitMs: number;
  private readonly defaultBanMs: number;
  private readonly states = new Map<string, RateLimitState>();

  constructor(options: ReactiveRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.defaultRateLimitMs =
      options.defaultRateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.defaultBanMs = options.defaultBanMs ?? DEFAULT_BAN_MS;
  }

  async beforeRequest(ctx: RateLimitRequestContext): Promise<void> {
    const snapshot = this.getSnapshot(ctx.scope);
    if (!snapshot?.blockedUntil || snapshot.blockedUntil <= this.now()) {
      return;
    }

    await this.sleep(Math.max(0, snapshot.blockedUntil - this.now()));
  }

  afterResponse(
    ctx: RateLimitRequestContext,
    response: RateLimitResponseContext,
  ): void {
    if (response.usage) {
      const existing = this.getState(ctx.scope);
      const hasActiveBlock =
        existing?.blockedUntil !== undefined &&
        existing.blockedUntil > this.now();
      this.updateState(ctx.scope, {
        usage: cloneUsage(response.usage),
        state: hasActiveBlock ? existing.state : "ok",
      });
    }
  }

  onTransportError(
    ctx: RateLimitRequestContext,
    error: RateLimitTransportErrorContext,
  ): void {
    if (error.usage) {
      this.updateState(ctx.scope, {
        usage: cloneUsage(error.usage),
      });
    }

    if (error.status !== 429 && error.status !== 418) {
      return;
    }

    const now = this.now();
    const isBan = error.status === 418;
    const retryAfterMs =
      error.retryAfterMs ??
      (isBan ? this.defaultBanMs : this.defaultRateLimitMs);
    const blockedUntil =
      retryAfterMs > 0
        ? now + retryAfterMs
        : this.getState(ctx.scope)?.blockedUntil;

    this.updateState(ctx.scope, {
      blockedUntil,
      retryAfterMs,
      state: isBan ? "banned" : "rate_limited",
    });
  }

  getSnapshot(scope: RateLimitScope): RateLimitSnapshot | undefined {
    const state = this.getState(scope);
    if (!state) {
      return undefined;
    }

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

  private getState(scope: RateLimitScope): RateLimitState | undefined {
    return this.states.get(scopeKey(scope));
  }

  private updateState(
    scope: RateLimitScope,
    patch: Partial<RateLimitState>,
  ): void {
    const existing = this.getState(scope);
    const nextBlockedUntil = maxOptional(
      existing?.blockedUntil,
      patch.blockedUntil,
    );
    const nextState =
      patch.state ??
      (nextBlockedUntil !== undefined
        ? (existing?.state ?? "ok")
        : existing?.state);

    this.states.set(scopeKey(scope), {
      usage: patch.usage ?? existing?.usage,
      blockedUntil: nextBlockedUntil,
      retryAfterMs: patch.retryAfterMs ?? existing?.retryAfterMs,
      state: nextState ?? "ok",
      updatedAt: this.now(),
    });
  }
}

function scopeKey(scope: RateLimitScope): string {
  return [scope.venue, scope.accountId ?? "", scope.endpointKey].join("\0");
}

function cloneUsage(usage: RateLimitUsage): RateLimitUsage {
  return {
    weight: usage.weight ? { ...usage.weight } : undefined,
    orderCount: usage.orderCount ? { ...usage.orderCount } : undefined,
  };
}

function maxOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
