import BigNumber from "bignumber.js";
import type {
  RawOpenOrdersSnapshot,
  RawOrderUpdate,
} from "../adapters/types.ts";
import type {
  AccountAwareManager,
  ClientContext,
  HealthReporter,
  ManagerLifecycle,
  PrivateOrderDataConsumer,
  PrivateSubscriptionState,
} from "../client/context.ts";
import {
  AcexError,
  buildAcexErrorDetails,
  formatAcexErrorMessage,
} from "../errors.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { toCanonical } from "../internal/decimal.ts";
import { matchesOrderFilter } from "../internal/filters.ts";
import { isTransportError } from "../internal/http-client.ts";
import {
  canDeleteMissingFromSnapshot,
  shouldApplyWatermarkedUpdate,
} from "../internal/watermark.ts";
import type {
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  GetOrderInput,
  OrderDataStatus,
  OrderEvent,
  OrderEventStreams,
  OrderManager,
  OrderSnapshot,
  OrderSnapshotReplacedEvent,
  OrderStatusChangedEvent,
  SubscribeOrdersInput,
  UnsubscribeOrdersInput,
  Venue,
} from "../types/index.ts";

interface OrderRecord {
  accountId: string;
  venue: Venue;
  subscribed: boolean;
  openOrders: Map<string, Map<string, OrderSnapshot>>;
  closedOrders: Map<string, Map<string, OrderSnapshot>>;
  localOrderLocations: Map<string, OrderLocation>;
  orderIdIndex: Map<string, Map<string, string>>;
  orderIdOnlyIndex: Map<string, Set<string>>;
  clientOrderIdIndex: Map<string, Set<string>>;
  pendingClientOrderIdIndex: Map<string, PendingOrderClaim>;
  status: OrderDataStatus;
}

type OrderTable = "open" | "closed";

interface OrderLocation {
  table: OrderTable;
  symbol: string;
  localOrderId: string;
}

interface PendingOrderClaim {
  localOrderId: string;
  symbol: string;
}

interface OrderManagerOptions {
  maxClosedOrdersPerSymbol?: number;
}

const DEFAULT_MAX_CLOSED_ORDERS_PER_SYMBOL = 500;
const SDK_CLIENT_ORDER_ID_PREFIX = "acex-";
const VENUE_CLIENT_ORDER_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,32}$/;

const SYSTEM_CLIENT_ORDER_ID_PATTERNS = [
  /^adl_autoclose$/,
  /^autoclose-/,
  /^settlement_autoclose-/,
];

function cloneOrderStatus(status: OrderDataStatus): OrderDataStatus {
  return { ...status };
}

function normalizeMaxClosedOrdersPerSymbol(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_CLOSED_ORDERS_PER_SYMBOL;
}

function getOrderLookupKeys(input: {
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

function shouldMatchOrderQuery(
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

function shouldMatchStoredOrderIdentity(
  candidate: OrderSnapshot,
  input: { symbol: string; orderId?: string; clientOrderId?: string },
): boolean {
  if (candidate.symbol !== input.symbol) {
    return false;
  }

  if (candidate.orderId && input.orderId) {
    return candidate.orderId === input.orderId;
  }

  // clientOrderId 只作"尚未拿到 orderId 的订单"的临时身份:已带 orderId 的候选
  // (含 clientOrderId 复用后躺在 closed 的旧订单)不得被 cid-only 更新归并,否则会
  // carry-forward 旧 orderId、污染 closed。orderId 后填充时 candidate 仍无 orderId,照常匹配。
  return Boolean(
    input.clientOrderId &&
      candidate.clientOrderId === input.clientOrderId &&
      !candidate.orderId,
  );
}

function successfulStatus(
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

function isOpenOrder(snapshot: OrderSnapshot): boolean {
  return snapshot.status === "open" || snapshot.status === "partially_filled";
}

function orderPriority(status: OrderSnapshot["status"]): number {
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

export class OrderManagerImpl
  implements
    OrderManager,
    ManagerLifecycle,
    AccountAwareManager,
    HealthReporter<OrderDataStatus>,
    PrivateOrderDataConsumer
{
  readonly events: OrderEventStreams;

  private readonly context: ClientContext;
  private readonly maxClosedOrdersPerSymbol: number;
  private readonly orderBus = new AsyncEventBus<OrderEvent>();
  private readonly orderStatusBus =
    new AsyncEventBus<OrderStatusChangedEvent>();
  private readonly records = new Map<string, OrderRecord>();
  private localOrderSequence = 0;

  constructor(context: ClientContext, options: OrderManagerOptions = {}) {
    this.context = context;
    this.maxClosedOrdersPerSymbol = normalizeMaxClosedOrdersPerSymbol(
      options.maxClosedOrdersPerSymbol,
    );

    this.events = {
      status: (filter) =>
        this.orderStatusBus.stream((event) =>
          matchesOrderFilter(
            { accountId: event.accountId, venue: event.venue },
            filter,
          ),
        ),
      updates: (filter) =>
        this.orderBus.stream((event) =>
          matchesOrderFilter(
            {
              accountId: event.accountId,
              venue: event.venue,
              symbol: "symbol" in event ? event.symbol : undefined,
            },
            filter,
          ),
        ),
    };
  }

  // --- OrderManager public API ---

  async subscribeOrders(input: SubscribeOrdersInput): Promise<void> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    if (
      this.context.getPrivateOrderCapabilities(account.venue)?.updates ===
      "unsupported"
    ) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue does not support private order subscriptions: ${account.venue}`,
        { accountId: input.accountId, venue: account.venue },
      );
    }
    this.context.ensurePrivateCredentials(input.accountId);

    const record = this.getOrCreateRecord(input.accountId, account.venue);
    record.subscribed = true;

    try {
      await this.context.subscribePrivateOrderFeed(input.accountId);
    } catch (error) {
      record.subscribed = false;
      throw error;
    }
  }

  async unsubscribeOrders(input: UnsubscribeOrdersInput): Promise<void> {
    const record = this.records.get(input.accountId);
    if (!record?.subscribed) {
      return;
    }

    this.context.unsubscribePrivateOrderFeed(input.accountId);
    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
      reason: undefined,
      inactiveSince: this.context.now(),
    };
    this.publishStatus(record);
  }

  async createOrder(input: CreateOrderInput): Promise<OrderSnapshot> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    this.context.ensurePrivateCredentials(input.accountId);
    this.validateCreateOrderInput(input, account.venue);
    const record = this.getOrCreateRecord(input.accountId, account.venue);
    const localOrderId = this.generateLocalOrderId({
      record,
      avoidOpenClientOrderId: input.clientOrderId === undefined,
    });
    const venueClientOrderId = input.clientOrderId ?? localOrderId;
    this.addPendingClientOrderClaim(
      record,
      input.symbol,
      venueClientOrderId,
      localOrderId,
    );

    try {
      const commandInput: CreateOrderInput = {
        ...input,
        clientOrderId: venueClientOrderId,
      };
      const update = await this.context.createOrder(commandInput);
      const snapshot = this.applyCommandUpdate(
        input.accountId,
        account.venue,
        update,
        { localOrderId },
      );
      this.clearPendingClientOrderClaim(
        record,
        venueClientOrderId,
        localOrderId,
      );
      return snapshot;
    } catch (error) {
      if (!this.shouldRetainPendingClaimAfterCreateError(error)) {
        this.clearPendingClientOrderClaim(
          record,
          venueClientOrderId,
          localOrderId,
        );
      }
      throw this.wrapCommandError(
        "ORDER_CREATE_FAILED",
        `Failed to create order for ${input.accountId}: ${input.symbol}`,
        error,
        {
          accountId: input.accountId,
          venue: account.venue,
          symbol: input.symbol,
        },
      );
    }
  }

  async cancelOrder(input: CancelOrderInput): Promise<OrderSnapshot> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    this.context.ensurePrivateCredentials(input.accountId);
    this.validateCancelOrderInput(input, account.venue);

    try {
      const update = await this.context.cancelOrder(input);
      return this.applyCommandUpdate(input.accountId, account.venue, update);
    } catch (error) {
      throw this.wrapCommandError(
        "ORDER_CANCEL_FAILED",
        `Failed to cancel order for ${input.accountId}: ${input.symbol}`,
        error,
        {
          accountId: input.accountId,
          venue: account.venue,
          symbol: input.symbol,
        },
      );
    }
  }

  async cancelAllOrders(input: CancelAllOrdersInput): Promise<OrderSnapshot[]> {
    this.context.assertStarted();
    const account = this.context.getRegisteredAccount(input.accountId);
    this.context.ensurePrivateCredentials(input.accountId);

    try {
      const updates = await this.context.cancelAllOrders(input);
      return this.applyCommandUpdates(input.accountId, account.venue, updates);
    } catch (error) {
      throw this.wrapCommandError(
        "ORDER_CANCEL_ALL_FAILED",
        `Failed to cancel all orders for ${input.accountId}: ${input.symbol}`,
        error,
        {
          accountId: input.accountId,
          venue: account.venue,
          symbol: input.symbol,
        },
      );
    }
  }

  getOrder(input: GetOrderInput): OrderSnapshot | undefined {
    const record = this.records.get(input.accountId);
    if (!record) {
      return undefined;
    }

    if (!input.orderId && !input.clientOrderId) {
      return undefined;
    }

    if (input.symbol && input.orderId) {
      const localOrderId = this.getLocalOrderIdForVenueOrderId(
        record,
        input.symbol,
        input.orderId,
      );
      const snapshot = localOrderId
        ? this.getSnapshotByLocalOrderId(record, localOrderId)
        : undefined;
      if (!snapshot) {
        return undefined;
      }

      if (
        input.clientOrderId &&
        snapshot.clientOrderId !== input.clientOrderId
      ) {
        return undefined;
      }

      return snapshot;
    }

    if (input.orderId) {
      return this.selectLatestSnapshot(
        this.getSnapshotsForOrderId(record, input.orderId).filter((snapshot) =>
          shouldMatchOrderQuery(snapshot, input),
        ),
      );
    }

    if (input.clientOrderId) {
      return this.selectLatestSnapshot(
        this.getSnapshotsForClientOrderId(record, input.clientOrderId).filter(
          (snapshot) => shouldMatchOrderQuery(snapshot, input),
        ),
      );
    }

    return undefined;
  }

  getOpenOrders(accountId: string, symbol?: string): OrderSnapshot[] {
    const record = this.records.get(accountId);
    if (!record) {
      return [];
    }

    if (symbol) {
      return [...(record.openOrders.get(symbol)?.values() ?? [])];
    }

    return this.getOpenOrderSnapshots(record);
  }

  getOrderStatus(accountId: string): OrderDataStatus | undefined {
    const status = this.records.get(accountId)?.status;
    return status ? cloneOrderStatus(status) : undefined;
  }

  // --- ManagerLifecycle ---

  onClientStarted(): void {}

  onClientStopping(now: number): void {
    for (const record of this.records.values()) {
      if (!record.subscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "inactive",
        runtimeStatus: "stopped",
        reason: undefined,
        inactiveSince: now,
      };
      this.publishStatus(record);
    }
  }

  // --- AccountAwareManager ---

  onAccountRemoved(accountId: string, now: number): void {
    const record = this.records.get(accountId);
    if (!record) {
      return;
    }

    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
      reason: undefined,
      inactiveSince: now,
    };
    this.publishStatus(record);
    this.records.delete(accountId);
  }

  onCredentialsUpdated(accountId: string, venue: Venue): void {
    const record = this.records.get(accountId);
    if (!record?.subscribed) {
      return;
    }

    this.onPrivateOrderPending(accountId, venue);
  }

  // --- PrivateOrderDataConsumer ---

  onPrivateOrderPending(accountId: string, venue: Venue): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    record.status = {
      ...this.createStatus(accountId, venue, "active"),
      ready: this.getSnapshotCount(record) > 0,
      runtimeStatus: "bootstrap_pending",
      reason: undefined,
      lastReceivedAt: record.status.lastReceivedAt,
      lastReadyAt: record.status.lastReadyAt,
      inactiveSince: undefined,
    };
    this.publishStatus(record);
  }

  onPrivateOrderBootstrap(
    accountId: string,
    venue: Venue,
    snapshot: RawOpenOrdersSnapshot,
    options: { requestStartedAt: number; preserveStatus?: boolean },
  ): OrderSnapshot[] {
    return this.onPrivateOrderReconcile(accountId, venue, snapshot, options);
  }

  onPrivateOrderReconcile(
    accountId: string,
    venue: Venue,
    snapshot: RawOpenOrdersSnapshot,
    options: { requestStartedAt: number; preserveStatus?: boolean },
  ): OrderSnapshot[] {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return [];
    }

    const openSetKeys = new Set<string>();
    for (const update of snapshot.orders) {
      for (const lookupKey of getOrderLookupKeys(update)) {
        openSetKeys.add(lookupKey);
      }
      const current = this.getExistingSnapshot(record, update);
      const nextSnapshot = this.applyUpdateToRecord(
        record,
        accountId,
        venue,
        update,
        {
          requestStartedAt: options.requestStartedAt,
          preserveStatus: true,
        },
      );
      if (nextSnapshot) {
        for (const nextLookupKey of getOrderLookupKeys(nextSnapshot)) {
          openSetKeys.add(nextLookupKey);
        }
      } else if (current) {
        for (const currentLookupKey of getOrderLookupKeys(current)) {
          openSetKeys.add(currentLookupKey);
        }
      }
    }

    const disappeared = this.getOpenOrderSnapshots(record).filter((order) => {
      if (!isOpenOrder(order)) {
        return false;
      }

      const lookupKeys = getOrderLookupKeys(order);
      if (
        lookupKeys.length === 0 ||
        lookupKeys.some((lookupKey) => openSetKeys.has(lookupKey))
      ) {
        return false;
      }

      return canDeleteMissingFromSnapshot(order, {
        requestStartedAt: options.requestStartedAt,
        snapshotExchangeTs: snapshot.snapshotExchangeTs,
      });
    });

    const orderedSnapshots = this.getAllSnapshots(record);
    const latestTs = Math.max(
      snapshot.snapshotReceivedAt,
      orderedSnapshots.reduce(
        (max, order) => Math.max(max, order.updatedAt),
        0,
      ),
    );
    record.status = successfulStatus(record.status, {
      preserveStatus: options.preserveStatus,
      lastReceivedAt: latestTs || record.status.lastReceivedAt,
      lastReadyAt: latestTs || this.context.now(),
    });

    const event: OrderSnapshotReplacedEvent = {
      type: "order.snapshot_replaced",
      accountId,
      venue,
      snapshot: orderedSnapshots,
      ts: this.context.now(),
    };

    this.orderBus.publish(event);
    this.publishStatus(record);
    return disappeared;
  }

  getPrivateOpenOrders(accountId: string): OrderSnapshot[] {
    return this.getOpenOrders(accountId);
  }

  onPrivateOrderUpdate(
    accountId: string,
    venue: Venue,
    update: RawOrderUpdate,
    options: { requestStartedAt?: number; preserveStatus?: boolean } = {},
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    const snapshot = this.applyUpdateToRecord(
      record,
      accountId,
      venue,
      update,
      {
        requestStartedAt: options.requestStartedAt,
        preserveStatus: options.preserveStatus,
      },
    );
    if (!snapshot) {
      return;
    }

    const eventType =
      snapshot.status === "filled"
        ? "order.filled"
        : snapshot.status === "rejected"
          ? "order.rejected"
          : snapshot.status === "canceled" || snapshot.status === "expired"
            ? "order.canceled"
            : "order.updated";

    this.orderBus.publish({
      type: eventType,
      accountId,
      venue,
      symbol: snapshot.symbol,
      snapshot,
      ts: this.context.now(),
    });

    record.status = successfulStatus(record.status, {
      preserveStatus: options.preserveStatus,
      lastReceivedAt: snapshot.receivedAt,
      lastReadyAt: snapshot.updatedAt,
    });
    this.publishStatus(record);
  }

  onPrivateOrderStreamState(
    accountId: string,
    venue: Venue,
    state: PrivateSubscriptionState,
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    record.status = {
      ...record.status,
      activity: "active",
      ready: state.ready,
      runtimeStatus: state.runtimeStatus,
      reason: state.reason,
      lastReceivedAt: state.lastReceivedAt ?? record.status.lastReceivedAt,
      lastReadyAt: state.lastReadyAt ?? record.status.lastReadyAt,
      inactiveSince: undefined,
    };
    this.publishStatus(record);
  }

  // --- HealthReporter ---

  getStatuses(): OrderDataStatus[] {
    return [...this.records.values()]
      .map((record) => cloneOrderStatus(record.status))
      .sort((left, right) =>
        `${left.venue}:${left.accountId}`.localeCompare(
          `${right.venue}:${right.accountId}`,
        ),
      );
  }

  // --- Internal helpers ---

  private getOrCreateRecord(accountId: string, venue: Venue): OrderRecord {
    const existing = this.records.get(accountId);
    if (existing) {
      return existing;
    }

    const record: OrderRecord = {
      accountId,
      venue,
      subscribed: false,
      openOrders: new Map(),
      closedOrders: new Map(),
      localOrderLocations: new Map(),
      orderIdIndex: new Map(),
      orderIdOnlyIndex: new Map(),
      clientOrderIdIndex: new Map(),
      pendingClientOrderIdIndex: new Map(),
      status: this.createStatus(accountId, venue, "inactive"),
    };

    this.records.set(accountId, record);
    return record;
  }

  private createStatus(
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

  private getExistingSnapshot(
    record: OrderRecord,
    update: { symbol: string; orderId?: string; clientOrderId?: string },
  ): OrderSnapshot | undefined {
    const location = this.getExistingSnapshotLocation(record, update);
    return location ? this.getSnapshotAtLocation(record, location) : undefined;
  }

  private getExistingSnapshotLocation(
    record: OrderRecord,
    update: { symbol: string; orderId?: string; clientOrderId?: string },
  ): OrderLocation | undefined {
    const resolution = this.resolveLocalOrderIdForUpdate(record, update);
    return resolution.localOrderId
      ? record.localOrderLocations.get(resolution.localOrderId)
      : undefined;
  }

  private resolveLocalOrderIdForUpdate(
    record: OrderRecord,
    update: { symbol: string; orderId?: string; clientOrderId?: string },
    preferredLocalOrderId?: string,
  ): {
    localOrderId?: string;
    source?: "exact" | "pending" | "provisional" | "preferred";
  } {
    if (update.orderId) {
      const exact = this.getLocalOrderIdForVenueOrderId(
        record,
        update.symbol,
        update.orderId,
      );
      if (exact) {
        return { localOrderId: exact, source: "exact" };
      }
    }

    if (preferredLocalOrderId) {
      return { localOrderId: preferredLocalOrderId, source: "preferred" };
    }

    if (update.clientOrderId) {
      const pending = record.pendingClientOrderIdIndex.get(
        update.clientOrderId,
      );
      if (pending?.symbol === update.symbol) {
        return { localOrderId: pending.localOrderId, source: "pending" };
      }
    }

    if (
      update.clientOrderId &&
      !this.isSystemClientOrderId(update.clientOrderId)
    ) {
      for (const localOrderId of record.clientOrderIdIndex.get(
        update.clientOrderId,
      ) ?? []) {
        const snapshot = this.getSnapshotByLocalOrderId(record, localOrderId);
        if (snapshot && shouldMatchStoredOrderIdentity(snapshot, update)) {
          return { localOrderId, source: "provisional" };
        }
      }
    }

    return {};
  }

  private setSnapshot(
    record: OrderRecord,
    localOrderId: string,
    snapshot: OrderSnapshot,
    previousLocation?: OrderLocation,
  ): OrderLocation | undefined {
    if (!snapshot.orderId && !snapshot.clientOrderId) {
      this.warnDroppedUnkeyedTerminalOrder(record, snapshot);
      return undefined;
    }

    const currentLocation =
      previousLocation ?? record.localOrderLocations.get(localOrderId);
    if (currentLocation) {
      return this.moveSnapshot(record, currentLocation, localOrderId, snapshot);
    }

    return this.insertSnapshot(record, localOrderId, snapshot);
  }

  private insertSnapshot(
    record: OrderRecord,
    localOrderId: string,
    snapshot: OrderSnapshot,
  ): OrderLocation | undefined {
    const existingLocation = record.localOrderLocations.get(localOrderId);
    if (existingLocation) {
      this.deleteSnapshot(record, existingLocation);
    }

    const location: OrderLocation = {
      table: isOpenOrder(snapshot) ? "open" : "closed",
      symbol: snapshot.symbol,
      localOrderId,
    };

    const table = this.getOrderTable(record, location.table);
    const symbolOrders = this.getOrCreateSymbolOrders(table, location.symbol);
    symbolOrders.set(localOrderId, snapshot);
    record.localOrderLocations.set(localOrderId, location);

    if (snapshot.orderId) {
      const symbolIndex = this.getOrCreateOrderIdSymbolIndex(
        record,
        snapshot.symbol,
      );
      symbolIndex.set(snapshot.orderId, localOrderId);
      this.addLocalOrderIdToSetIndex(
        record.orderIdOnlyIndex,
        snapshot.orderId,
        localOrderId,
      );
    }

    if (snapshot.clientOrderId) {
      this.addLocalOrderIdToSetIndex(
        record.clientOrderIdIndex,
        snapshot.clientOrderId,
        localOrderId,
      );
    }

    this.trimClosedOrdersForSymbol(record, location);
    this.warnSystemClientOrderIdOnlyClaim(record, snapshot);
    this.warnProvisionalTerminalOrder(record, snapshot);
    return location;
  }

  private deleteSnapshot(
    record: OrderRecord,
    location: OrderLocation,
  ): OrderSnapshot | undefined {
    const snapshot = this.getSnapshotAtLocation(record, location);
    if (!snapshot) {
      return undefined;
    }

    const table = this.getOrderTable(record, location.table);
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
      this.removeLocalOrderIdFromSetIndex(
        record.orderIdOnlyIndex,
        snapshot.orderId,
        location.localOrderId,
      );
    }

    if (snapshot.clientOrderId) {
      this.removeLocalOrderIdFromSetIndex(
        record.clientOrderIdIndex,
        snapshot.clientOrderId,
        location.localOrderId,
      );
    }

    return snapshot;
  }

  private moveSnapshot(
    record: OrderRecord,
    previousLocation: OrderLocation,
    localOrderId: string,
    snapshot: OrderSnapshot,
  ): OrderLocation | undefined {
    this.deleteSnapshot(record, previousLocation);
    return this.insertSnapshot(record, localOrderId, snapshot);
  }

  private trimClosedOrdersForSymbol(
    record: OrderRecord,
    location: OrderLocation,
  ): void {
    if (location.table !== "closed") {
      return;
    }

    let symbolOrders = record.closedOrders.get(location.symbol);
    if (!symbolOrders || symbolOrders.size <= this.maxClosedOrdersPerSymbol) {
      return;
    }

    const trimBatchSize = Math.max(
      1,
      Math.floor(this.maxClosedOrdersPerSymbol / 10),
    );
    while (symbolOrders && symbolOrders.size > this.maxClosedOrdersPerSymbol) {
      const keys = symbolOrders.keys();
      for (let deleted = 0; deleted < trimBatchSize; deleted += 1) {
        const next = keys.next();
        if (next.done) {
          break;
        }
        this.deleteSnapshot(record, {
          table: "closed",
          symbol: location.symbol,
          localOrderId: next.value,
        });
      }
      symbolOrders = record.closedOrders.get(location.symbol);
    }
  }

  private warnDroppedUnkeyedTerminalOrder(
    record: OrderRecord,
    snapshot: OrderSnapshot,
  ): void {
    if (isOpenOrder(snapshot)) {
      return;
    }

    this.context.publishRuntimeError(
      "order",
      new Error(
        "Dropped terminal order update without orderId or clientOrderId",
      ),
      {
        accountId: record.accountId,
        venue: record.venue,
        symbol: snapshot.symbol,
      },
    );
  }

  private warnSystemClientOrderIdOnlyClaim(
    record: OrderRecord,
    snapshot: OrderSnapshot,
  ): void {
    if (
      snapshot.orderId ||
      !snapshot.clientOrderId ||
      !this.isSystemClientOrderId(snapshot.clientOrderId)
    ) {
      return;
    }

    this.context.publishRuntimeError(
      "order",
      new Error(
        "Received system clientOrderId without orderId; cid-only claim is unstable",
      ),
      {
        accountId: record.accountId,
        venue: record.venue,
        symbol: snapshot.symbol,
      },
    );
  }

  private warnProvisionalTerminalOrder(
    record: OrderRecord,
    snapshot: OrderSnapshot,
  ): void {
    // 终态单缺 orderId 但有 clientOrderId: 用 client key provisional 存储并告警。
    // adapter 契约要求终态带 orderId(见 adapter-contract.md);仅 cid 无法保证稳定唯一主键。
    if (snapshot.orderId || isOpenOrder(snapshot) || !snapshot.clientOrderId) {
      return;
    }

    this.context.publishRuntimeError(
      "order",
      new Error(
        "Stored terminal order without orderId using provisional clientOrderId key",
      ),
      {
        accountId: record.accountId,
        venue: record.venue,
        symbol: snapshot.symbol,
      },
    );
  }

  private getSnapshotAtLocation(
    record: OrderRecord,
    location: OrderLocation,
  ): OrderSnapshot | undefined {
    return this.getOrderTable(record, location.table)
      .get(location.symbol)
      ?.get(location.localOrderId);
  }

  private getSnapshotByLocalOrderId(
    record: OrderRecord,
    localOrderId: string,
  ): OrderSnapshot | undefined {
    const location = record.localOrderLocations.get(localOrderId);
    return location ? this.getSnapshotAtLocation(record, location) : undefined;
  }

  private getOrderTable(
    record: OrderRecord,
    table: OrderTable,
  ): Map<string, Map<string, OrderSnapshot>> {
    return table === "open" ? record.openOrders : record.closedOrders;
  }

  private getOrCreateSymbolOrders(
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

  private getOrCreateOrderIdSymbolIndex(
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

  private getLocalOrderIdForVenueOrderId(
    record: OrderRecord,
    symbol: string,
    orderId: string,
  ): string | undefined {
    return record.orderIdIndex.get(symbol)?.get(orderId);
  }

  private getSnapshotsForOrderId(
    record: OrderRecord,
    orderId: string,
  ): OrderSnapshot[] {
    return this.getSnapshotsForLocalOrderIds(
      record,
      record.orderIdOnlyIndex.get(orderId),
    );
  }

  private getSnapshotsForClientOrderId(
    record: OrderRecord,
    clientOrderId: string,
  ): OrderSnapshot[] {
    return this.getSnapshotsForLocalOrderIds(
      record,
      record.clientOrderIdIndex.get(clientOrderId),
    );
  }

  private getSnapshotsForLocalOrderIds(
    record: OrderRecord,
    localOrderIds?: Iterable<string>,
  ): OrderSnapshot[] {
    if (!localOrderIds) {
      return [];
    }

    const snapshots: OrderSnapshot[] = [];
    for (const localOrderId of localOrderIds) {
      const snapshot = this.getSnapshotByLocalOrderId(record, localOrderId);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots;
  }

  private getOpenOrderSnapshots(record: OrderRecord): OrderSnapshot[] {
    return this.getSnapshotsInTable(record.openOrders);
  }

  private getAllSnapshots(record: OrderRecord): OrderSnapshot[] {
    return [
      ...this.getSnapshotsInTable(record.openOrders),
      ...this.getSnapshotsInTable(record.closedOrders),
    ];
  }

  private getSnapshotsInTable(
    table: Map<string, Map<string, OrderSnapshot>>,
  ): OrderSnapshot[] {
    const snapshots: OrderSnapshot[] = [];
    for (const symbolOrders of table.values()) {
      snapshots.push(...symbolOrders.values());
    }

    return snapshots;
  }

  private getSnapshotCount(record: OrderRecord): number {
    return (
      this.getSnapshotCountInTable(record.openOrders) +
      this.getSnapshotCountInTable(record.closedOrders)
    );
  }

  private getSnapshotCountInTable(
    table: Map<string, Map<string, OrderSnapshot>>,
  ): number {
    let size = 0;
    for (const symbolOrders of table.values()) {
      size += symbolOrders.size;
    }

    return size;
  }

  private addLocalOrderIdToSetIndex(
    index: Map<string, Set<string>>,
    key: string,
    localOrderId: string,
  ): void {
    this.removeLocalOrderIdFromSetIndex(index, key, localOrderId);

    const localOrderIds = index.get(key);
    if (localOrderIds) {
      localOrderIds.add(localOrderId);
      return;
    }

    index.set(key, new Set([localOrderId]));
  }

  private removeLocalOrderIdFromSetIndex(
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

  private selectLatestSnapshot(
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
        // open 候选绝对优先:当前活跃订单优于历史终态(clientOrderId 复用时旧单已 closed)
        if (snapshotOpen) {
          latest = snapshot;
        }
        continue;
      }

      // 同为 open 或同为 closed: 取 updatedAt 最新。
      // 不能用 seq —— seq 是单订单版本号,跨订单(如复用 cid 的不同订单)不可比。
      if (snapshot.updatedAt > latest.updatedAt) {
        latest = snapshot;
      }
    }

    return latest;
  }

  private applyUpdateToRecord(
    record: OrderRecord,
    accountId: string,
    venue: Venue,
    update: RawOrderUpdate,
    options: { requestStartedAt?: number; preserveStatus?: boolean } = {},
  ): OrderSnapshot | undefined {
    const resolution = this.resolveLocalOrderIdForUpdate(record, update);
    const localOrderId = resolution.localOrderId ?? this.generateLocalOrderId();
    const previousLocation = record.localOrderLocations.get(localOrderId);
    const previous = previousLocation
      ? this.getSnapshotAtLocation(record, previousLocation)
      : undefined;
    if (
      !shouldApplyWatermarkedUpdate(previous, update, {
        requestStartedAt: options.requestStartedAt,
        source: options.requestStartedAt === undefined ? "stream" : "rest",
      })
    ) {
      return undefined;
    }

    const snapshot = this.createSnapshot(accountId, venue, update, previous);
    const location = this.setSnapshot(
      record,
      localOrderId,
      snapshot,
      previousLocation,
    );
    if (location && resolution.source === "pending" && update.clientOrderId) {
      this.clearPendingClientOrderClaim(
        record,
        update.clientOrderId,
        localOrderId,
      );
    }

    return location ? snapshot : undefined;
  }

  private createSnapshot(
    accountId: string,
    venue: Venue,
    input: RawOrderUpdate,
    previous?: OrderSnapshot,
  ): OrderSnapshot {
    const amount = new BigNumber(input.amount);
    const rawFilled = new BigNumber(input.filled);
    const filled =
      previous &&
      input.exchangeTs !== undefined &&
      previous.exchangeTs === input.exchangeTs
        ? BigNumber.maximum(rawFilled, previous.filled)
        : rawFilled;
    const remaining =
      input.remaining === undefined
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
      status: this.mergeOrderStatus(input, previous),
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

  private mergeOrderStatus(
    input: RawOrderUpdate,
    previous?: OrderSnapshot,
  ): OrderSnapshot["status"] {
    if (!previous) {
      return input.status;
    }

    if (
      input.exchangeTs !== undefined &&
      previous.exchangeTs !== undefined &&
      input.exchangeTs === previous.exchangeTs &&
      orderPriority(input.status) < orderPriority(previous.status)
    ) {
      return previous.status;
    }

    return input.status;
  }

  private publishStatus(record: OrderRecord): void {
    const event: OrderStatusChangedEvent = {
      type: "order.status_changed",
      accountId: record.accountId,
      venue: record.venue,
      status: cloneOrderStatus(record.status),
      ts: this.context.now(),
    };

    this.orderStatusBus.publish(event);
    this.context.publishHealthEvent(event);
  }

  private generateLocalOrderId(options?: {
    record?: OrderRecord;
    avoidOpenClientOrderId?: boolean;
  }): string {
    while (true) {
      const candidate = `${SDK_CLIENT_ORDER_ID_PREFIX}${this.context.now().toString(36)}-${(this.localOrderSequence++).toString(36)}`;
      if (
        (options?.record &&
          options.avoidOpenClientOrderId &&
          this.isVenueClientOrderIdInUseForOpenOrder(
            options.record,
            candidate,
          )) ||
        options?.record?.pendingClientOrderIdIndex.has(candidate) ||
        !VENUE_CLIENT_ORDER_ID_PATTERN.test(candidate)
      ) {
        continue;
      }

      return candidate;
    }
  }

  private isVenueClientOrderIdInUseForOpenOrder(
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

  private addPendingClientOrderClaim(
    record: OrderRecord,
    symbol: string,
    venueClientOrderId: string,
    localOrderId: string,
  ): void {
    record.pendingClientOrderIdIndex.set(venueClientOrderId, {
      localOrderId,
      symbol,
    });
  }

  private clearPendingClientOrderClaim(
    record: OrderRecord,
    venueClientOrderId: string,
    localOrderId: string,
  ): void {
    const pending = record.pendingClientOrderIdIndex.get(venueClientOrderId);
    if (pending?.localOrderId === localOrderId) {
      record.pendingClientOrderIdIndex.delete(venueClientOrderId);
    }
  }

  private shouldRetainPendingClaimAfterCreateError(error: unknown): boolean {
    return isTransportError(error) && error.kind === "timeout";
  }

  private isSystemClientOrderId(clientOrderId: string): boolean {
    return SYSTEM_CLIENT_ORDER_ID_PATTERNS.some((pattern) =>
      pattern.test(clientOrderId),
    );
  }

  private validateCreateOrderInput(
    input: CreateOrderInput,
    venue: Venue,
  ): void {
    if (input.type === "limit" && !input.price) {
      throw this.createError(
        "ORDER_INPUT_INVALID",
        `Limit orders require price: ${input.accountId}`,
        {
          accountId: input.accountId,
          venue,
          symbol: input.symbol,
        },
      );
    }

    if (
      input.clientOrderId !== undefined &&
      !VENUE_CLIENT_ORDER_ID_PATTERN.test(input.clientOrderId)
    ) {
      throw this.createError(
        "ORDER_INPUT_INVALID",
        `clientOrderId must be 1-32 Binance-safe characters: ${input.accountId}`,
        {
          accountId: input.accountId,
          venue,
          symbol: input.symbol,
        },
      );
    }
  }

  private validateCancelOrderInput(
    input: CancelOrderInput,
    venue: Venue,
  ): void {
    if (input.orderId || input.clientOrderId) {
      return;
    }

    throw this.createError(
      "ORDER_INPUT_INVALID",
      `cancelOrder requires orderId or clientOrderId: ${input.accountId}`,
      {
        accountId: input.accountId,
        venue,
        symbol: input.symbol,
      },
    );
  }

  private applyCommandUpdate(
    accountId: string,
    venue: Venue,
    update: RawOrderUpdate,
    options: { localOrderId?: string } = {},
  ): OrderSnapshot {
    const record = this.getOrCreateRecord(accountId, venue);
    const resolution = this.resolveLocalOrderIdForUpdate(
      record,
      update,
      options.localOrderId,
    );
    const localOrderId = resolution.localOrderId ?? this.generateLocalOrderId();
    const previousLocation = record.localOrderLocations.get(localOrderId);
    const previous = previousLocation
      ? this.getSnapshotAtLocation(record, previousLocation)
      : undefined;
    const snapshot = this.createSnapshot(accountId, venue, update, previous);
    this.setSnapshot(record, localOrderId, snapshot, previousLocation);
    return snapshot;
  }

  private applyCommandUpdates(
    accountId: string,
    venue: Venue,
    updates: RawOrderUpdate[],
  ): OrderSnapshot[] {
    return updates.map((update) =>
      this.applyCommandUpdate(accountId, venue, update),
    );
  }

  private createError(
    code:
      | "VENUE_NOT_SUPPORTED"
      | "ORDER_CANCEL_ALL_FAILED"
      | "ORDER_CANCEL_FAILED"
      | "ORDER_CREATE_FAILED"
      | "ORDER_INPUT_INVALID",
    message: string,
    metadata: {
      accountId: string;
      venue: Venue;
      symbol?: string;
    },
  ): AcexError {
    const details = buildAcexErrorDetails(metadata);
    const error = new AcexError(code, message, { details });
    this.context.publishRuntimeError("order", error, metadata);
    return error;
  }

  private wrapCommandError(
    code:
      | "ORDER_CANCEL_ALL_FAILED"
      | "ORDER_CANCEL_FAILED"
      | "ORDER_CREATE_FAILED",
    message: string,
    error: unknown,
    metadata: {
      accountId: string;
      venue: Venue;
      symbol: string;
    },
  ): AcexError {
    if (error instanceof AcexError) {
      return error;
    }

    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error ? error : new Error(message),
      metadata,
    );
    const details = buildAcexErrorDetails(metadata, error);
    return new AcexError(code, formatAcexErrorMessage(message, details), {
      cause: error,
      details,
    });
  }
}
