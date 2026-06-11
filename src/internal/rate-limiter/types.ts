import type { RateLimitSnapshot, RateLimitUsage } from "../../types/index.ts";

export interface ReactiveRateLimiterOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly defaultRateLimitMs?: number;
  readonly defaultBanMs?: number;
  readonly utilizationTarget?: number;
}

export interface EndpointRateLimitState {
  usage?: RateLimitUsage;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: RateLimitSnapshot["state"];
  updatedAt?: number;
}

export interface BucketRateLimitState {
  used?: number;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: RateLimitSnapshot["state"];
  updatedAt?: number;
}
