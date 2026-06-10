import type { OrderDataStatus, Venue } from "../../types/index.ts";

export const DEFAULT_MAX_CLOSED_ORDERS_PER_SYMBOL = 500;

export function cloneOrderStatus(status: OrderDataStatus): OrderDataStatus {
  return { ...status };
}

export function createOrderDataStatus(
  accountId: string,
  venue: Venue,
  activity: "active" | "inactive",
): OrderDataStatus {
  return {
    accountId,
    venue,
    activity,
    ready: false,
    runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
  };
}

export function normalizeMaxClosedOrdersPerSymbol(
  value: number | undefined,
): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_CLOSED_ORDERS_PER_SYMBOL;
}

export function successfulStatus(
  status: OrderDataStatus,
  options: {
    ready?: boolean;
    lastReceivedAt?: number;
    lastReadyAt?: number;
    preserveStatus?: boolean;
  },
): OrderDataStatus {
  const preservesStreamState =
    options.preserveStatus &&
    (status.runtimeStatus === "reconnecting" ||
      status.reason === "ws_disconnected" ||
      status.reason === "heartbeat_timeout");
  const ready = options.ready ?? true;

  return {
    ...status,
    activity: "active",
    ready,
    runtimeStatus: preservesStreamState ? status.runtimeStatus : "healthy",
    reason: preservesStreamState ? status.reason : undefined,
    lastReceivedAt: options.lastReceivedAt ?? status.lastReceivedAt,
    lastReadyAt: ready
      ? (options.lastReadyAt ??
        (options.preserveStatus ? status.lastReadyAt : undefined) ??
        Date.now())
      : status.lastReadyAt,
    inactiveSince: undefined,
  };
}
