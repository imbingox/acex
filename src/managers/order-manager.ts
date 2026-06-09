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
  orderIdIndex: Map<string, Map<string, OrderLocation>>;
  orderIdOnlyIndex: Map<string, Set<OrderLocation>>;
  clientOrderIdIndex: Map<string, Set<OrderLocation>>;
  status: OrderDataStatus;
}

type OrderTable = "open" | "closed";

interface OrderLocation {
  table: OrderTable;
  symbol: string;
  key: string;
}

interface OrderManagerOptions {
  maxClosedOrdersPerSymbol?: number;
}

const DEFAULT_MAX_CLOSED_ORDERS_PER_SYMBOL = 500;

function cloneOrderStatus(status: OrderDataStatus): OrderDataStatus {
  return { ...status };
}

function normalizeMaxClosedOrdersPerSymbol(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_CLOSED_ORDERS_PER_SYMBOL;
}

function getOrderLookupKey(input: {
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}): string | undefined {
  if (input.orderId) {
    return `symbol:${input.symbol}:order:${input.orderId}`;
  }

  if (input.clientOrderId) {
    return `symbol:${input.symbol}:client:${input.clientOrderId}`;
  }

  return undefined;
}

function getOrderKey(input: {
  orderId?: string;
  clientOrderId?: string;
}): string | undefined {
  if (input.orderId) {
    return `order:${input.orderId}`;
  }

  if (input.clientOrderId) {
    return `client:${input.clientOrderId}`;
  }

  return undefined;
}

function shouldMatchOrderIdentity(
  candidate: OrderSnapshot,
  input: { symbol?: string; orderId?: string; clientOrderId?: string },
): boolean {
  if (input.symbol && candidate.symbol !== input.symbol) {
    return false;
  }

  return Boolean(
    (input.orderId && candidate.orderId === input.orderId) ||
      (input.clientOrderId && candidate.clientOrderId === input.clientOrderId),
  );
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

    try {
      const update = await this.context.createOrder(input);
      return this.applyCommandUpdate(input.accountId, account.venue, update);
    } catch (error) {
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
      const location = this.getOrderIdLocation(
        record,
        input.symbol,
        input.orderId,
      );
      const snapshot = location
        ? this.getSnapshotAtLocation(record, location)
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
        this.getSnapshotsForOrderId(record, input.orderId).filter(
          (snapshot) =>
            shouldMatchOrderIdentity(snapshot, {
              symbol: input.symbol,
              orderId: input.orderId,
            }) &&
            (!input.clientOrderId ||
              shouldMatchOrderIdentity(snapshot, {
                symbol: input.symbol,
                clientOrderId: input.clientOrderId,
              })),
        ),
      );
    }

    if (input.clientOrderId) {
      return this.selectLatestSnapshot(
        this.getSnapshotsForClientOrderId(record, input.clientOrderId).filter(
          (snapshot) =>
            shouldMatchOrderIdentity(snapshot, {
              symbol: input.symbol,
              clientOrderId: input.clientOrderId,
            }),
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
      const lookupKey = getOrderLookupKey(update);
      if (lookupKey) {
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
        const nextLookupKey = getOrderLookupKey(nextSnapshot);
        if (nextLookupKey) {
          openSetKeys.add(nextLookupKey);
        }
      } else if (current) {
        const currentLookupKey = getOrderLookupKey(current);
        if (currentLookupKey) {
          openSetKeys.add(currentLookupKey);
        }
      }
    }

    const disappeared = this.getOpenOrderSnapshots(record).filter((order) => {
      if (!isOpenOrder(order)) {
        return false;
      }

      const lookupKey = getOrderLookupKey(order);
      if (!lookupKey || openSetKeys.has(lookupKey)) {
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
      orderIdIndex: new Map(),
      orderIdOnlyIndex: new Map(),
      clientOrderIdIndex: new Map(),
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
    if (update.orderId) {
      const location = this.getOrderIdLocation(
        record,
        update.symbol,
        update.orderId,
      );
      const snapshot = location
        ? this.getSnapshotAtLocation(record, location)
        : undefined;
      if (snapshot && shouldMatchStoredOrderIdentity(snapshot, update)) {
        return location;
      }
    }

    if (!update.clientOrderId) {
      return undefined;
    }

    for (const location of record.clientOrderIdIndex.get(
      update.clientOrderId,
    ) ?? []) {
      const snapshot = this.getSnapshotAtLocation(record, location);
      if (snapshot && shouldMatchStoredOrderIdentity(snapshot, update)) {
        return location;
      }
    }

    return undefined;
  }

  private setSnapshot(
    record: OrderRecord,
    snapshot: OrderSnapshot,
    previous?: OrderSnapshot,
  ): OrderLocation | undefined {
    const existing = previous ?? this.getExistingSnapshot(record, snapshot);
    const previousLocation = existing
      ? this.getSnapshotLocation(existing)
      : undefined;

    if (previousLocation) {
      return this.moveSnapshot(record, previousLocation, snapshot);
    }

    return this.insertSnapshot(record, snapshot);
  }

  private insertSnapshot(
    record: OrderRecord,
    snapshot: OrderSnapshot,
  ): OrderLocation | undefined {
    const location = this.getSnapshotLocation(snapshot);
    if (!location) {
      this.warnDroppedUnkeyedTerminalOrder(record, snapshot);
      return undefined;
    }

    this.deleteSnapshot(record, location);

    const table = this.getOrderTable(record, location.table);
    const symbolOrders = this.getOrCreateSymbolOrders(table, location.symbol);
    symbolOrders.set(location.key, snapshot);
    this.trimClosedOrdersForSymbol(record, location);

    if (snapshot.orderId) {
      const symbolIndex = this.getOrCreateOrderIdSymbolIndex(
        record,
        snapshot.symbol,
      );
      symbolIndex.set(snapshot.orderId, location);
      this.addLocationToSetIndex(
        record.orderIdOnlyIndex,
        snapshot.orderId,
        location,
      );
    }

    if (snapshot.clientOrderId) {
      this.addLocationToSetIndex(
        record.clientOrderIdIndex,
        snapshot.clientOrderId,
        location,
      );
    }

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
    symbolOrders?.delete(location.key);
    if (symbolOrders?.size === 0) {
      table.delete(location.symbol);
    }

    if (snapshot.orderId) {
      const symbolIndex = record.orderIdIndex.get(location.symbol);
      if (
        symbolIndex?.get(snapshot.orderId) &&
        this.locationsEqual(symbolIndex.get(snapshot.orderId), location)
      ) {
        symbolIndex.delete(snapshot.orderId);
      }
      if (symbolIndex?.size === 0) {
        record.orderIdIndex.delete(location.symbol);
      }
      this.removeLocationFromSetIndex(
        record.orderIdOnlyIndex,
        snapshot.orderId,
        location,
      );
    }

    if (snapshot.clientOrderId) {
      this.removeLocationFromSetIndex(
        record.clientOrderIdIndex,
        snapshot.clientOrderId,
        location,
      );
    }

    return snapshot;
  }

  private moveSnapshot(
    record: OrderRecord,
    previousLocation: OrderLocation,
    snapshot: OrderSnapshot,
  ): OrderLocation | undefined {
    this.deleteSnapshot(record, previousLocation);
    return this.insertSnapshot(record, snapshot);
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
          key: next.value,
        });
      }
      symbolOrders = record.closedOrders.get(location.symbol);
    }
  }

  private getSnapshotLocation(
    snapshot: OrderSnapshot,
  ): OrderLocation | undefined {
    const key = getOrderKey(snapshot);
    if (!key) {
      return undefined;
    }

    return {
      table: isOpenOrder(snapshot) ? "open" : "closed",
      symbol: snapshot.symbol,
      key,
    };
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
      ?.get(location.key);
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
  ): Map<string, OrderLocation> {
    const existing = record.orderIdIndex.get(symbol);
    if (existing) {
      return existing;
    }

    const created = new Map<string, OrderLocation>();
    record.orderIdIndex.set(symbol, created);
    return created;
  }

  private getOrderIdLocation(
    record: OrderRecord,
    symbol: string,
    orderId: string,
  ): OrderLocation | undefined {
    return record.orderIdIndex.get(symbol)?.get(orderId);
  }

  private getSnapshotsForOrderId(
    record: OrderRecord,
    orderId: string,
  ): OrderSnapshot[] {
    return this.getSnapshotsForLocations(
      record,
      record.orderIdOnlyIndex.get(orderId),
    );
  }

  private getSnapshotsForClientOrderId(
    record: OrderRecord,
    clientOrderId: string,
  ): OrderSnapshot[] {
    return this.getSnapshotsForLocations(
      record,
      record.clientOrderIdIndex.get(clientOrderId),
    );
  }

  private getSnapshotsForLocations(
    record: OrderRecord,
    locations?: Iterable<OrderLocation>,
  ): OrderSnapshot[] {
    if (!locations) {
      return [];
    }

    const snapshots: OrderSnapshot[] = [];
    for (const location of locations) {
      const snapshot = this.getSnapshotAtLocation(record, location);
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

  private addLocationToSetIndex(
    index: Map<string, Set<OrderLocation>>,
    key: string,
    location: OrderLocation,
  ): void {
    this.removeLocationFromSetIndex(index, key, location);

    const locations = index.get(key);
    if (locations) {
      locations.add(location);
      return;
    }

    index.set(key, new Set([location]));
  }

  private removeLocationFromSetIndex(
    index: Map<string, Set<OrderLocation>>,
    key: string,
    location: OrderLocation,
  ): void {
    const locations = index.get(key);
    if (!locations) {
      return;
    }

    for (const candidate of locations) {
      if (this.locationsEqual(candidate, location)) {
        locations.delete(candidate);
        break;
      }
    }

    if (locations.size === 0) {
      index.delete(key);
    }
  }

  private locationsEqual(
    left: OrderLocation | undefined,
    right: OrderLocation,
  ): boolean {
    return Boolean(
      left &&
        left.table === right.table &&
        left.symbol === right.symbol &&
        left.key === right.key,
    );
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
    const previous = this.getExistingSnapshot(record, update);
    if (
      !shouldApplyWatermarkedUpdate(previous, update, {
        requestStartedAt: options.requestStartedAt,
        source: options.requestStartedAt === undefined ? "stream" : "rest",
      })
    ) {
      return undefined;
    }

    const snapshot = this.createSnapshot(accountId, venue, update, previous);
    return this.setSnapshot(record, snapshot, previous) ? snapshot : undefined;
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
  ): OrderSnapshot {
    const record = this.getOrCreateRecord(accountId, venue);
    const previous = this.getExistingSnapshot(record, update);
    const snapshot = this.createSnapshot(accountId, venue, update, previous);
    this.setSnapshot(record, snapshot, previous);
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
