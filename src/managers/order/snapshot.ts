import BigNumber from "bignumber.js";
import type { RawOrderUpdate } from "../../adapters/types.ts";
import { toCanonical } from "../../internal/decimal.ts";
import type { OrderSnapshot, Venue } from "../../types/index.ts";

export function createSnapshot(
  accountId: string,
  venue: Venue,
  input: RawOrderUpdate,
  previous?: OrderSnapshot,
): OrderSnapshot {
  const amount = new BigNumber(input.amount);
  const rawFilled = new BigNumber(input.filled);
  const filled = previous
    ? BigNumber.maximum(rawFilled, previous.filled)
    : rawFilled;
  const filledWasClamped = !filled.eq(rawFilled);
  const remaining =
    input.remaining === undefined || filledWasClamped
      ? amount.minus(filled)
      : new BigNumber(input.remaining);

  return {
    accountId,
    venue,
    orderId: input.orderId ?? previous?.orderId,
    clientOrderId: input.clientOrderId ?? previous?.clientOrderId,
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    status: mergeOrderStatus(input, previous),
    price:
      input.price === undefined ? previous?.price : toCanonical(input.price),
    triggerPrice:
      input.triggerPrice === undefined
        ? previous?.triggerPrice
        : toCanonical(input.triggerPrice),
    amount: toCanonical(amount),
    filled: toCanonical(filled),
    remaining: toCanonical(remaining),
    reduceOnly: input.reduceOnly ?? previous?.reduceOnly,
    positionSide: input.positionSide ?? previous?.positionSide,
    avgFillPrice:
      input.avgFillPrice === undefined
        ? previous?.avgFillPrice
        : toCanonical(input.avgFillPrice),
    exchangeTs: input.exchangeTs,
    receivedAt: input.receivedAt,
    updatedAt: input.receivedAt,
    seq: (previous?.seq ?? 0) + 1,
  };
}

export function mergeOrderStatus(
  input: RawOrderUpdate,
  previous?: OrderSnapshot,
): OrderSnapshot["status"] {
  if (!previous) {
    return input.status;
  }

  if (orderPriority(input.status) < orderPriority(previous.status)) {
    return previous.status;
  }

  return input.status;
}

export function isOpenOrder(snapshot: OrderSnapshot): boolean {
  return snapshot.status === "open" || snapshot.status === "partially_filled";
}

export function orderPriority(status: OrderSnapshot["status"]): number {
  switch (status) {
    case "filled":
      return 5;
    case "canceled":
    case "expired":
      return 4;
    case "rejected":
      return 3;
    case "partially_filled":
      return 2;
    case "open":
      return 1;
  }
}
