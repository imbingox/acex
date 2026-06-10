import type { OrderSnapshot } from "../../types/index.ts";

export const SDK_CLIENT_ORDER_ID_PREFIX = "acex-";
export const VENUE_CLIENT_ORDER_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,32}$/;

const SYSTEM_CLIENT_ORDER_ID_PATTERNS = [
  /^adl_autoclose$/,
  /^autoclose-/,
  /^settlement_autoclose-/,
];

export function getOrderLookupKeys(input: {
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}): string[] {
  const keys: string[] = [];
  if (input.orderId) {
    keys.push(`symbol:${input.symbol}:order:${input.orderId}`);
  }

  if (input.clientOrderId) {
    keys.push(`symbol:${input.symbol}:client:${input.clientOrderId}`);
  }

  return keys;
}

export function shouldMatchOrderQuery(
  candidate: OrderSnapshot,
  input: { symbol?: string; orderId?: string; clientOrderId?: string },
): boolean {
  if (input.symbol && candidate.symbol !== input.symbol) {
    return false;
  }

  if (input.orderId && candidate.orderId !== input.orderId) {
    return false;
  }

  if (input.clientOrderId && candidate.clientOrderId !== input.clientOrderId) {
    return false;
  }

  return Boolean(input.orderId || input.clientOrderId);
}

export function shouldMatchStoredOrderIdentity(
  candidate: OrderSnapshot,
  input: { symbol: string; orderId?: string; clientOrderId?: string },
): boolean {
  if (candidate.symbol !== input.symbol) {
    return false;
  }

  if (candidate.orderId && input.orderId) {
    return candidate.orderId === input.orderId;
  }

  // clientOrderId is only a temporary identity for an order that does not yet
  // have an orderId. A candidate that already carries an orderId (including an
  // old order sitting in closed that reused this clientOrderId) must not be
  // merged by a cid-only update; otherwise the stale orderId would be carried
  // forward and pollute closed. When the orderId is later filled in, the
  // candidate still lacks an orderId and matches normally.
  return Boolean(
    input.clientOrderId &&
      candidate.clientOrderId === input.clientOrderId &&
      !candidate.orderId,
  );
}

export function isSystemClientOrderId(clientOrderId: string): boolean {
  return SYSTEM_CLIENT_ORDER_ID_PATTERNS.some((pattern) =>
    pattern.test(clientOrderId),
  );
}
