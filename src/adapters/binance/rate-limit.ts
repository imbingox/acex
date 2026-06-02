import type { RateLimitUsage } from "../../types/index.ts";

const USED_WEIGHT_PREFIX = "x-mbx-used-weight-";
const ORDER_COUNT_PREFIX = "x-mbx-order-count-";

export function parseBinanceRateLimitUsage(
  headers: Headers,
): RateLimitUsage | undefined {
  const weight: Record<string, number> = {};
  const orderCount: Record<string, number> = {};

  for (const name of headers.keys()) {
    const normalizedName = name.toLowerCase();
    if (normalizedName.startsWith(USED_WEIGHT_PREFIX)) {
      const interval = normalizedName.slice(USED_WEIGHT_PREFIX.length);
      const value = parseHeaderNumber(headers.get(name));
      if (interval && value !== undefined) {
        weight[interval] = value;
      }
      continue;
    }

    if (normalizedName.startsWith(ORDER_COUNT_PREFIX)) {
      const interval = normalizedName.slice(ORDER_COUNT_PREFIX.length);
      const value = parseHeaderNumber(headers.get(name));
      if (interval && value !== undefined) {
        orderCount[interval] = value;
      }
    }
  }

  return Object.keys(weight).length > 0 || Object.keys(orderCount).length > 0
    ? {
        weight: Object.keys(weight).length > 0 ? weight : undefined,
        orderCount: Object.keys(orderCount).length > 0 ? orderCount : undefined,
      }
    : undefined;
}

function parseHeaderNumber(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
