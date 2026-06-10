import type { OrderSnapshot } from "../../types/index.ts";
import {
  isSystemClientOrderId,
  shouldMatchStoredOrderIdentity,
} from "./identity.ts";
import type { OrderLocation, OrderRecord, OrderTable } from "./model.ts";
import { isOpenOrder } from "./snapshot.ts";

export interface SetSnapshotResult {
  location?: OrderLocation;
  trimmedSnapshots: OrderSnapshot[];
}

export interface SetSnapshotOptions {
  maxClosedOrdersPerSymbol: number;
  previousLocation?: OrderLocation;
}

export interface LocalOrderResolution {
  localOrderId?: string;
  source?: "exact" | "pending" | "provisional" | "preferred";
}

export function getSnapshotAtLocation(
  record: OrderRecord,
  location: OrderLocation,
): OrderSnapshot | undefined {
  return getOrderTable(record, location.table)
    .get(location.symbol)
    ?.get(location.localOrderId);
}

export function getSnapshotByLocalOrderId(
  record: OrderRecord,
  localOrderId: string,
): OrderSnapshot | undefined {
  const location = record.localOrderLocations.get(localOrderId);
  return location ? getSnapshotAtLocation(record, location) : undefined;
}

export function getOrderTable(
  record: OrderRecord,
  table: OrderTable,
): Map<string, Map<string, OrderSnapshot>> {
  return table === "open" ? record.openOrders : record.closedOrders;
}

function getOrCreateSymbolOrders(
  table: Map<string, Map<string, OrderSnapshot>>,
  symbol: string,
): Map<string, OrderSnapshot> {
  const existing = table.get(symbol);
  if (existing) {
    return existing;
  }

  const created = new Map<string, OrderSnapshot>();
  table.set(symbol, created);
  return created;
}

function getOrCreateOrderIdSymbolIndex(
  record: OrderRecord,
  symbol: string,
): Map<string, string> {
  const existing = record.orderIdIndex.get(symbol);
  if (existing) {
    return existing;
  }

  const created = new Map<string, string>();
  record.orderIdIndex.set(symbol, created);
  return created;
}

export function getLocalOrderIdForVenueOrderId(
  record: OrderRecord,
  symbol: string,
  orderId: string,
): string | undefined {
  return record.orderIdIndex.get(symbol)?.get(orderId);
}

export function getLocationByLocalOrderId(
  record: OrderRecord,
  localOrderId: string,
): OrderLocation | undefined {
  return record.localOrderLocations.get(localOrderId);
}

export function getExistingSnapshot(
  record: OrderRecord,
  update: { symbol: string; orderId?: string; clientOrderId?: string },
): OrderSnapshot | undefined {
  const location = getExistingSnapshotLocation(record, update);
  return location ? getSnapshotAtLocation(record, location) : undefined;
}

export function getExistingSnapshotLocation(
  record: OrderRecord,
  update: { symbol: string; orderId?: string; clientOrderId?: string },
): OrderLocation | undefined {
  const resolution = resolveLocalOrderIdForUpdate(record, update);
  return resolution.localOrderId
    ? record.localOrderLocations.get(resolution.localOrderId)
    : undefined;
}

export function resolveLocalOrderIdForUpdate(
  record: OrderRecord,
  update: { symbol: string; orderId?: string; clientOrderId?: string },
  options: {
    preferredLocalOrderId?: string;
    pendingLocalOrderId?: string;
  } = {},
): LocalOrderResolution {
  if (update.orderId) {
    const exact = getLocalOrderIdForVenueOrderId(
      record,
      update.symbol,
      update.orderId,
    );
    if (exact) {
      return { localOrderId: exact, source: "exact" };
    }
  }

  if (options.preferredLocalOrderId) {
    return {
      localOrderId: options.preferredLocalOrderId,
      source: "preferred",
    };
  }

  if (options.pendingLocalOrderId) {
    return { localOrderId: options.pendingLocalOrderId, source: "pending" };
  }

  if (update.clientOrderId && !isSystemClientOrderId(update.clientOrderId)) {
    for (const localOrderId of record.clientOrderIdIndex.get(
      update.clientOrderId,
    ) ?? []) {
      const snapshot = getSnapshotByLocalOrderId(record, localOrderId);
      if (snapshot && shouldMatchStoredOrderIdentity(snapshot, update)) {
        return { localOrderId, source: "provisional" };
      }
    }
  }

  return {};
}

export function getSnapshotsForOrderId(
  record: OrderRecord,
  orderId: string,
): OrderSnapshot[] {
  return getSnapshotsForLocalOrderIds(
    record,
    record.orderIdOnlyIndex.get(orderId),
  );
}

export function getSnapshotsForClientOrderId(
  record: OrderRecord,
  clientOrderId: string,
): OrderSnapshot[] {
  return getSnapshotsForLocalOrderIds(
    record,
    record.clientOrderIdIndex.get(clientOrderId),
  );
}

export function getSnapshotsForLocalOrderIds(
  record: OrderRecord,
  localOrderIds?: Iterable<string>,
): OrderSnapshot[] {
  if (!localOrderIds) {
    return [];
  }

  const snapshots: OrderSnapshot[] = [];
  for (const localOrderId of localOrderIds) {
    const snapshot = getSnapshotByLocalOrderId(record, localOrderId);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  return snapshots;
}

export function getOpenOrderSnapshots(
  record: OrderRecord,
  symbol?: string,
): OrderSnapshot[] {
  if (symbol) {
    return [...(record.openOrders.get(symbol)?.values() ?? [])];
  }

  return getSnapshotsInTable(record.openOrders);
}

export function getAllSnapshots(record: OrderRecord): OrderSnapshot[] {
  return [
    ...getSnapshotsInTable(record.openOrders),
    ...getSnapshotsInTable(record.closedOrders),
  ];
}

export function getSnapshotsInTable(
  table: Map<string, Map<string, OrderSnapshot>>,
): OrderSnapshot[] {
  const snapshots: OrderSnapshot[] = [];
  for (const symbolOrders of table.values()) {
    snapshots.push(...symbolOrders.values());
  }

  return snapshots;
}

export function getSnapshotCount(record: OrderRecord): number {
  return (
    getSnapshotCountInTable(record.openOrders) +
    getSnapshotCountInTable(record.closedOrders)
  );
}

export function getSnapshotCountInTable(
  table: Map<string, Map<string, OrderSnapshot>>,
): number {
  let size = 0;
  for (const symbolOrders of table.values()) {
    size += symbolOrders.size;
  }

  return size;
}

function addLocalOrderIdToSetIndex(
  index: Map<string, Set<string>>,
  key: string,
  localOrderId: string,
): void {
  const localOrderIds = index.get(key);
  if (localOrderIds) {
    localOrderIds.add(localOrderId);
    return;
  }

  index.set(key, new Set([localOrderId]));
}

function removeLocalOrderIdFromSetIndex(
  index: Map<string, Set<string>>,
  key: string,
  localOrderId: string,
): void {
  const localOrderIds = index.get(key);
  if (!localOrderIds) {
    return;
  }

  localOrderIds.delete(localOrderId);

  if (localOrderIds.size === 0) {
    index.delete(key);
  }
}

export function selectLatestSnapshot(
  snapshots: OrderSnapshot[],
): OrderSnapshot | undefined {
  let latest: OrderSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (!latest) {
      latest = snapshot;
      continue;
    }

    const snapshotOpen = isOpenOrder(snapshot);
    const latestOpen = isOpenOrder(latest);
    if (snapshotOpen !== latestOpen) {
      // Open candidate has absolute priority: current active order takes
      // precedence over historical terminal state (when clientOrderId is
      // reused, the old order is already closed).
      if (snapshotOpen) {
        latest = snapshot;
      }
      continue;
    }

    // Both open or both closed: take the latest by updatedAt.
    // seq must not be used -- seq is a per-order version number and is not
    // comparable across orders (e.g. different orders that reuse a cid).
    if (snapshot.updatedAt > latest.updatedAt) {
      latest = snapshot;
    }
  }

  return latest;
}

export function isVenueClientOrderIdInUseForOpenOrder(
  record: OrderRecord,
  venueClientOrderId: string,
): boolean {
  for (const localOrderId of record.clientOrderIdIndex.get(
    venueClientOrderId,
  ) ?? []) {
    const location = record.localOrderLocations.get(localOrderId);
    if (location?.table === "open") {
      return true;
    }
  }

  return false;
}

export function setSnapshot(
  record: OrderRecord,
  localOrderId: string,
  snapshot: OrderSnapshot,
  options: SetSnapshotOptions,
): SetSnapshotResult {
  if (!snapshot.orderId && !snapshot.clientOrderId) {
    return { trimmedSnapshots: [] };
  }

  const currentLocation =
    options.previousLocation ?? record.localOrderLocations.get(localOrderId);
  if (currentLocation) {
    return moveSnapshot(record, currentLocation, localOrderId, snapshot, {
      maxClosedOrdersPerSymbol: options.maxClosedOrdersPerSymbol,
    });
  }

  return insertSnapshot(record, localOrderId, snapshot, {
    maxClosedOrdersPerSymbol: options.maxClosedOrdersPerSymbol,
  });
}

function insertSnapshot(
  record: OrderRecord,
  localOrderId: string,
  snapshot: OrderSnapshot,
  options: { maxClosedOrdersPerSymbol: number },
): SetSnapshotResult {
  const existingLocation = record.localOrderLocations.get(localOrderId);
  if (existingLocation) {
    deleteSnapshot(record, existingLocation);
  }

  const location: OrderLocation = {
    table: isOpenOrder(snapshot) ? "open" : "closed",
    symbol: snapshot.symbol,
    localOrderId,
  };

  const table = getOrderTable(record, location.table);
  const symbolOrders = getOrCreateSymbolOrders(table, location.symbol);
  symbolOrders.set(localOrderId, snapshot);
  record.localOrderLocations.set(localOrderId, location);

  if (snapshot.orderId) {
    const symbolIndex = getOrCreateOrderIdSymbolIndex(record, snapshot.symbol);
    symbolIndex.set(snapshot.orderId, localOrderId);
    addLocalOrderIdToSetIndex(
      record.orderIdOnlyIndex,
      snapshot.orderId,
      localOrderId,
    );
  }

  if (snapshot.clientOrderId) {
    addLocalOrderIdToSetIndex(
      record.clientOrderIdIndex,
      snapshot.clientOrderId,
      localOrderId,
    );
  }

  const trimmedSnapshots = trimClosedOrdersForSymbol(record, location, {
    maxClosedOrdersPerSymbol: options.maxClosedOrdersPerSymbol,
  });
  return { location, trimmedSnapshots };
}

function deleteSnapshot(
  record: OrderRecord,
  location: OrderLocation,
): OrderSnapshot | undefined {
  const snapshot = getSnapshotAtLocation(record, location);
  if (!snapshot) {
    return undefined;
  }

  const table = getOrderTable(record, location.table);
  const symbolOrders = table.get(location.symbol);
  symbolOrders?.delete(location.localOrderId);
  if (symbolOrders?.size === 0) {
    table.delete(location.symbol);
  }
  record.localOrderLocations.delete(location.localOrderId);

  if (snapshot.orderId) {
    const symbolIndex = record.orderIdIndex.get(location.symbol);
    if (
      symbolIndex?.get(snapshot.orderId) &&
      symbolIndex.get(snapshot.orderId) === location.localOrderId
    ) {
      symbolIndex.delete(snapshot.orderId);
    }
    if (symbolIndex?.size === 0) {
      record.orderIdIndex.delete(location.symbol);
    }
    removeLocalOrderIdFromSetIndex(
      record.orderIdOnlyIndex,
      snapshot.orderId,
      location.localOrderId,
    );
  }

  if (snapshot.clientOrderId) {
    removeLocalOrderIdFromSetIndex(
      record.clientOrderIdIndex,
      snapshot.clientOrderId,
      location.localOrderId,
    );
  }

  return snapshot;
}

function moveSnapshot(
  record: OrderRecord,
  previousLocation: OrderLocation,
  localOrderId: string,
  snapshot: OrderSnapshot,
  options: { maxClosedOrdersPerSymbol: number },
): SetSnapshotResult {
  deleteSnapshot(record, previousLocation);
  return insertSnapshot(record, localOrderId, snapshot, {
    maxClosedOrdersPerSymbol: options.maxClosedOrdersPerSymbol,
  });
}

function trimClosedOrdersForSymbol(
  record: OrderRecord,
  location: OrderLocation,
  options: { maxClosedOrdersPerSymbol: number },
): OrderSnapshot[] {
  if (location.table !== "closed") {
    return [];
  }

  let symbolOrders = record.closedOrders.get(location.symbol);
  if (!symbolOrders || symbolOrders.size <= options.maxClosedOrdersPerSymbol) {
    return [];
  }

  const trimmedSnapshots: OrderSnapshot[] = [];
  const trimBatchSize = Math.max(
    1,
    Math.floor(options.maxClosedOrdersPerSymbol / 10),
  );
  while (symbolOrders && symbolOrders.size > options.maxClosedOrdersPerSymbol) {
    const keys = symbolOrders.keys();
    for (let deleted = 0; deleted < trimBatchSize; deleted += 1) {
      const next = keys.next();
      if (next.done) {
        break;
      }
      const deletedSnapshot = deleteSnapshot(record, {
        table: "closed",
        symbol: location.symbol,
        localOrderId: next.value,
      });
      if (deletedSnapshot) {
        trimmedSnapshots.push(deletedSnapshot);
      }
    }
    symbolOrders = record.closedOrders.get(location.symbol);
  }

  return trimmedSnapshots;
}
