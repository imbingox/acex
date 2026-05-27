import BigNumber from "bignumber.js";
import type { RawOrderUpdate } from "../adapters/types.ts";
import type {
  AccountAwareManager,
  ClientContext,
  HealthReporter,
  ManagerLifecycle,
  PrivateOrderDataConsumer,
  PrivateSubscriptionState,
} from "../client/context.ts";
import { AcexError } from "../errors.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { matchesOrderFilter } from "../internal/filters.ts";
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
    if (account.venue === "juplend") {
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
      if (input.orderId && snapshot.orderId === input.orderId) {
        return snapshot;
      }

      if (
        input.clientOrderId &&
        snapshot.clientOrderId === input.clientOrderId
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

      return (
        snapshot.status === "open" || snapshot.status === "partially_filled"
      );
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
    snapshots: RawOrderUpdate[],
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    const nextSnapshots = new Map<string, OrderSnapshot>();
    for (const update of snapshots) {
      const snapshot = this.createSnapshot(
        accountId,
        venue,
        update,
        this.getExistingSnapshot(record, update),
      );
      this.setSnapshot(nextSnapshots, snapshot);
    }

    record.snapshots = nextSnapshots;
    const orderedSnapshots = [...record.snapshots.values()];
    const latestTs = orderedSnapshots.reduce(
      (max, snapshot) => Math.max(max, snapshot.updatedAt),
      0,
    );
    record.status = {
      ...record.status,
      activity: "active",
      ready: true,
      runtimeStatus: "healthy",
      reason: undefined,
      lastReceivedAt: latestTs || record.status.lastReceivedAt,
      lastReadyAt: latestTs || this.context.now(),
      inactiveSince: undefined,
    };

    const event: OrderSnapshotReplacedEvent = {
      type: "order.snapshot_replaced",
      accountId,
      venue,
      snapshot: orderedSnapshots,
      ts: this.context.now(),
    };

    this.orderBus.publish(event);
    this.publishStatus(record);
  }

  onPrivateOrderUpdate(
    accountId: string,
    venue: Venue,
    update: RawOrderUpdate,
  ): void {
    const record = this.getOrCreateRecord(accountId, venue);
    if (!record.subscribed) {
      return;
    }

    const previous = this.getExistingSnapshot(record, update);
    const snapshot = this.createSnapshot(accountId, venue, update, previous);
    this.setSnapshot(record.snapshots, snapshot);

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

    record.status = {
      ...record.status,
      activity: "active",
      ready: true,
      runtimeStatus: "healthy",
      reason: undefined,
      lastReceivedAt: snapshot.receivedAt,
      lastReadyAt: snapshot.updatedAt,
      inactiveSince: undefined,
    };
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
    update: { orderId?: string; clientOrderId?: string },
  ): OrderSnapshot | undefined {
    for (const snapshot of record.snapshots.values()) {
      if (update.orderId && snapshot.orderId === update.orderId) {
        return snapshot;
      }

      if (
        update.clientOrderId &&
        snapshot.clientOrderId === update.clientOrderId
      ) {
        return snapshot;
      }
    }

    return undefined;
  }

  private setSnapshot(
    snapshots: Map<string, OrderSnapshot>,
    snapshot: OrderSnapshot,
  ): void {
    const lookupKey =
      getOrderLookupKey(snapshot) ??
      getOrderLookupKey({
        clientOrderId: snapshot.clientOrderId,
      });
    if (lookupKey) {
      snapshots.set(lookupKey, snapshot);
    }
  }

  private createSnapshot(
    accountId: string,
    venue: Venue,
    input: RawOrderUpdate,
    previous?: OrderSnapshot,
  ): OrderSnapshot {
    const amount = new BigNumber(input.amount);
    const filled = new BigNumber(input.filled);
    const remaining =
      input.remaining === undefined
        ? amount.minus(filled)
        : new BigNumber(input.remaining);

    return {
      accountId,
      venue,
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      status: input.status,
      price:
        input.price === undefined
          ? previous?.price
          : new BigNumber(input.price),
      triggerPrice:
        input.triggerPrice === undefined
          ? previous?.triggerPrice
          : new BigNumber(input.triggerPrice),
      amount,
      filled,
      remaining,
      reduceOnly: input.reduceOnly ?? previous?.reduceOnly,
      positionSide: input.positionSide ?? previous?.positionSide,
      avgFillPrice:
        input.avgFillPrice === undefined
          ? previous?.avgFillPrice
          : new BigNumber(input.avgFillPrice),
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      seq: (previous?.seq ?? 0) + 1,
    };
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
    const error = new AcexError(code, message);
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
    return new AcexError(code, message);
  }
}
