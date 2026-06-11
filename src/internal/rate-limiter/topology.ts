import type {
  RateLimitBucketDescriptor,
  RateLimitPlan,
} from "../../types/index.ts";

export function validateBucketDescriptor(
  bucket: RateLimitBucketDescriptor,
): void {
  if (!bucket.id) {
    throw new Error("Rate limit bucket descriptor id is required");
  }
  if (!Number.isFinite(bucket.limit) || bucket.limit < 0) {
    throw new Error(`Invalid rate limit bucket limit: ${bucket.id}`);
  }
  if (!Number.isFinite(bucket.intervalMs) || bucket.intervalMs <= 0) {
    throw new Error(`Invalid rate limit bucket interval: ${bucket.id}`);
  }
  if (bucket.reserve) {
    if (!bucket.reserve.priority) {
      throw new Error(
        `Invalid rate limit bucket reserve priority: ${bucket.id}`,
      );
    }
    if (
      !Number.isFinite(bucket.reserve.units) ||
      bucket.reserve.units < 0 ||
      bucket.reserve.units > bucket.limit
    ) {
      throw new Error(`Invalid rate limit bucket reserve units: ${bucket.id}`);
    }
  }
}

export function validatePlan(
  plan: RateLimitPlan,
  buckets: ReadonlyMap<string, RateLimitBucketDescriptor>,
): void {
  if (!plan.id) {
    throw new Error("Rate limit plan id is required");
  }
  for (const cost of plan.costs) {
    if (!buckets.has(cost.bucketId)) {
      throw new Error(
        `Rate limit plan ${plan.id} references unknown bucket: ${cost.bucketId}`,
      );
    }
    if (!Number.isFinite(cost.cost) || cost.cost < 0) {
      throw new Error(`Invalid rate limit cost for plan: ${plan.id}`);
    }
  }
}

export function cloneBucketDescriptor(
  bucket: RateLimitBucketDescriptor,
): RateLimitBucketDescriptor {
  return {
    ...bucket,
    reserve: bucket.reserve ? { ...bucket.reserve } : undefined,
    scope: [...bucket.scope],
  };
}

export function clonePlan(plan: RateLimitPlan): RateLimitPlan {
  return {
    ...plan,
    costs: plan.costs.map((cost) => ({ ...cost })),
  };
}

export function bucketDescriptorsEqual(
  left: RateLimitBucketDescriptor,
  right: RateLimitBucketDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.limit === right.limit &&
    left.intervalMs === right.intervalMs &&
    left.utilizationTarget === right.utilizationTarget &&
    reservesEqual(left.reserve, right.reserve) &&
    arraysEqual(left.scope, right.scope)
  );
}

export function plansEqual(left: RateLimitPlan, right: RateLimitPlan): boolean {
  if (
    left.id !== right.id ||
    left.priority !== right.priority ||
    left.costs.length !== right.costs.length
  ) {
    return false;
  }

  return left.costs.every((cost, index) => {
    const other = right.costs[index];
    if (!other) {
      return false;
    }
    return cost.bucketId === other.bucketId && cost.cost === other.cost;
  });
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function reservesEqual(
  left: RateLimitBucketDescriptor["reserve"],
  right: RateLimitBucketDescriptor["reserve"],
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.priority === right.priority && left.units === right.units;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
