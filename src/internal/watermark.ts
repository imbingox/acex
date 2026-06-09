export const CROSS_CLOCK_WATERMARK_GRACE_MS = 10_000;

export interface WatermarkedRecord {
  exchangeTs?: number;
  receivedAt: number;
}

export interface WatermarkApplyOptions {
  requestStartedAt?: number;
  source?: "command" | "rest" | "stream";
  graceMs?: number;
}

export interface SnapshotDeletionGuard {
  requestStartedAt: number;
  snapshotExchangeTs?: number;
}

export function shouldApplyWatermarkedUpdate(
  current: WatermarkedRecord | undefined,
  incoming: WatermarkedRecord,
  options: WatermarkApplyOptions = {},
): boolean {
  if (!current) {
    return true;
  }

  const graceMs = options.graceMs ?? CROSS_CLOCK_WATERMARK_GRACE_MS;
  const requestStartedAt = options.requestStartedAt;

  if (
    options.source === "rest" &&
    requestStartedAt !== undefined &&
    current.receivedAt > requestStartedAt &&
    (current.exchangeTs === undefined || incoming.exchangeTs === undefined)
  ) {
    return false;
  }

  if (current.exchangeTs !== undefined && incoming.exchangeTs !== undefined) {
    if (incoming.exchangeTs < current.exchangeTs) {
      return false;
    }
    if (incoming.exchangeTs > current.exchangeTs) {
      return true;
    }

    return incoming.receivedAt >= current.receivedAt;
  }

  if (current.exchangeTs !== undefined) {
    if (incoming.receivedAt < current.exchangeTs + graceMs) {
      return false;
    }

    return incoming.receivedAt >= current.receivedAt;
  }

  if (incoming.exchangeTs !== undefined) {
    if (incoming.exchangeTs < current.receivedAt - graceMs) {
      return false;
    }

    return incoming.receivedAt >= current.receivedAt;
  }

  return incoming.receivedAt >= current.receivedAt;
}

export function canDeleteMissingFromSnapshot(
  current: WatermarkedRecord,
  guard: SnapshotDeletionGuard,
): boolean {
  if (current.receivedAt > guard.requestStartedAt) {
    return false;
  }

  return !(
    current.exchangeTs !== undefined &&
    guard.snapshotExchangeTs !== undefined &&
    current.exchangeTs > guard.snapshotExchangeTs
  );
}
