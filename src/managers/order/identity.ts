import type { OrderSnapshot } from "../../types/index.ts";

export const SDK_CLIENT_ORDER_ID_PREFIX = "acex-";
export const VENUE_CLIENT_ORDER_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,32}$/;

const SDK_CLIENT_ORDER_ID_ENTROPY_LENGTH = 4;
const SDK_CLIENT_ORDER_ID_ENTROPY_SPACE =
  36 ** SDK_CLIENT_ORDER_ID_ENTROPY_LENGTH;
const sdkClientOrderIdEntropies = new Set<string>();
let sdkClientOrderIdEntropyFallback = 0;

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

export function createSdkClientOrderIdEntropy(): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const entropy = randomBase36Entropy();
    if (!sdkClientOrderIdEntropies.has(entropy)) {
      sdkClientOrderIdEntropies.add(entropy);
      return entropy;
    }
  }

  while (sdkClientOrderIdEntropies.size < SDK_CLIENT_ORDER_ID_ENTROPY_SPACE) {
    const entropy = formatBase36Entropy(sdkClientOrderIdEntropyFallback);
    sdkClientOrderIdEntropyFallback =
      (sdkClientOrderIdEntropyFallback + 1) % SDK_CLIENT_ORDER_ID_ENTROPY_SPACE;
    if (!sdkClientOrderIdEntropies.has(entropy)) {
      sdkClientOrderIdEntropies.add(entropy);
      return entropy;
    }
  }

  return randomBase36Entropy();
}

function randomBase36Entropy(): string {
  const randomValues = new Uint32Array(1);
  globalThis.crypto.getRandomValues(randomValues);
  return formatBase36Entropy(randomValues[0] ?? 0);
}

function formatBase36Entropy(value: number): string {
  return (value % SDK_CLIENT_ORDER_ID_ENTROPY_SPACE)
    .toString(36)
    .padStart(SDK_CLIENT_ORDER_ID_ENTROPY_LENGTH, "0");
}
