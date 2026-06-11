import type {
  RateLimitBucketDescriptor,
  RateLimitScope,
  RateLimitSnapshot,
} from "../../types/index.ts";

export function scopeKey(scope: RateLimitScope): string {
  return [scope.venue, scope.accountId ?? "", scope.endpointKey].join("\0");
}

export function bucketStateKey(
  scope: RateLimitScope,
  bucket: RateLimitBucketDescriptor,
): string {
  return [
    bucket.id,
    ...bucket.scope.map((dimension) => scopeValue(scope, dimension)),
  ].join("\0");
}

function scopeValue(
  scope: RateLimitScope,
  dimension: RateLimitBucketDescriptor["scope"][number],
): string {
  switch (dimension) {
    case "venue":
      return scope.venue;
    case "account":
      return scope.accountId ?? "";
    case "endpoint":
      return scope.endpointKey;
  }
}

export function maxOptional(
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

export function nextRateLimitState(
  existingState: RateLimitSnapshot["state"] | undefined,
  patchState: RateLimitSnapshot["state"] | undefined,
  patchWinsBlock: boolean,
  blockedUntil: number | undefined,
): RateLimitSnapshot["state"] | undefined {
  if (!patchState) {
    return blockedUntil !== undefined ? (existingState ?? "ok") : existingState;
  }
  if (!patchWinsBlock && existingState) {
    return moreSevereState(existingState, patchState);
  }
  return patchState;
}

export function nextRetryAfterMs<T extends { retryAfterMs?: number }>(
  existing: T | undefined,
  patch: Partial<T>,
  patchWinsBlock: boolean,
): number | undefined {
  if (patchWinsBlock) {
    return patch.retryAfterMs ?? existing?.retryAfterMs;
  }
  return existing?.retryAfterMs;
}

function moreSevereState(
  left: RateLimitSnapshot["state"],
  right: RateLimitSnapshot["state"],
): RateLimitSnapshot["state"] {
  return stateSeverity(left) >= stateSeverity(right) ? left : right;
}

export function stateSeverity(state: RateLimitSnapshot["state"]): number {
  switch (state) {
    case "banned":
      return 2;
    case "rate_limited":
      return 1;
    case "ok":
      return 0;
  }
}
