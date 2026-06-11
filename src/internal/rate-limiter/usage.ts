import type {
  RateLimitBucketDescriptor,
  RateLimitUsage,
} from "../../types/index.ts";

export function cloneUsage(usage: RateLimitUsage): RateLimitUsage {
  return {
    weight: usage.weight ? { ...usage.weight } : undefined,
    orderCount: usage.orderCount ? { ...usage.orderCount } : undefined,
  };
}

export function usageForBucket(
  usage: RateLimitUsage,
  bucket: RateLimitBucketDescriptor,
): number | undefined {
  const intervalKey = intervalKeyFromMs(bucket.intervalMs);
  if (!intervalKey) {
    return undefined;
  }

  if (bucket.kind === "request_weight") {
    return usage.weight?.[intervalKey];
  }

  if (bucket.kind === "orders") {
    return usage.orderCount?.[intervalKey];
  }

  return undefined;
}

function intervalKeyFromMs(intervalMs: number): string | undefined {
  const units: Array<readonly [suffix: string, ms: number]> = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ];

  for (const [suffix, ms] of units) {
    if (intervalMs >= ms && intervalMs % ms === 0) {
      return `${intervalMs / ms}${suffix}`;
    }
  }

  return undefined;
}
