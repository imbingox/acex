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
  snapshots: Map<string, OrderSnapshot>;
  status: OrderDataStatus;
}

function cloneOrderStatus(status: OrderDataStatus): OrderDataStatus {
  return { ...status };
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

  return Boolean(
    input.clientOrderId &&
      candidate.clientOrderId === input.clientOrderId &&
      (!candidate.orderId || !input.orderId),
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
  private readonly orderBus = new AsyncEventBus<OrderEvent>();
  private readonly orderStatusBus =
    new AsyncEventBus<OrderStatusChangedEvent>();
  private readonly records = new Map<string, OrderRecord>();

  constructor(context: ClientContext) {
    this.context = context;

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

    for (const snapshot of record.snapshots.values()) {
      if (input.orderId && input.clientOrderId) {
        if (
          shouldMatchOrderIdentity(snapshot, {
            symbol: input.symbol,
            orderId: input.orderId,
          }) &&
          shouldMatchOrderIdentity(snapshot, {
            symbol: input.symbol,
            clientOrderId: input.clientOrderId,
          })
        ) {
          return snapshot;
        }
        continue;
      }

      if (
        input.orderId &&
        shouldMatchOrderIdentity(snapshot, {
          symbol: input.symbol,
          orderId: input.orderId,
        })
      ) {
        return snapshot;
      }

      if (
        input.clientOrderId &&
        shouldMatchOrderIdentity(snapshot, {
          symbol: input.symbol,
          clientOrderId: input.clientOrderId,
        })
      ) {
        return snapshot;
      }
    }

    return undefined;
  }

  getOpenOrders(accountId: string, symbol?: string): OrderSnapshot[] {
    const record = this.records.get(accountId);
    if (!record) {
      return [];
    }

    return [...record.snapshots.values()].filter((snapshot) => {
      if (symbol && snapshot.symbol !== symbol) {
        return false;
      }

      return isOpenOrder(snapshot);
    });
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
      ready: record.snapshots.size > 0,
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

    const disappeared = [...record.snapshots.values()].filter((order) => {
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

    const orderedSnapshots = [...record.snapshots.values()];
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
      snapshots: new Map(),
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
    const lookupKey = getOrderLookupKey(update);
    if (lookupKey) {
      const byPrimaryKey = record.snapshots.get(lookupKey);
      if (byPrimaryKey) {
        return byPrimaryKey;
      }
    }

    for (const snapshot of record.snapshots.values()) {
      if (shouldMatchStoredOrderIdentity(snapshot, update)) {
        return snapshot;
      }
    }

    return undefined;
  }

  private setSnapshot(
    snapshots: Map<string, OrderSnapshot>,
    snapshot: OrderSnapshot,
  ): void {
    const previousKeys: string[] = [];
    for (const [key, existing] of snapshots.entries()) {
      if (shouldMatchStoredOrderIdentity(existing, snapshot)) {
        previousKeys.push(key);
      }
    }
    for (const key of previousKeys) {
      snapshots.delete(key);
    }

    if (snapshot.orderId) {
      snapshots.set(
        `symbol:${snapshot.symbol}:order:${snapshot.orderId}`,
        snapshot,
      );
      return;
    }

    if (snapshot.clientOrderId) {
      snapshots.set(
        `symbol:${snapshot.symbol}:client:${snapshot.clientOrderId}`,
        snapshot,
      );
    }
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
    this.setSnapshot(record.snapshots, snapshot);
    return snapshot;
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
    this.setSnapshot(record.snapshots, snapshot);
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
