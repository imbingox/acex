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
import {
  cloneOrderStatus,
  createOrderDataStatus,
  normalizeMaxClosedOrdersPerSymbol,
  successfulStatus,
} from "./order/data-status.ts";
import {
  getOrderLookupKeys,
  isSystemClientOrderId,
  SDK_CLIENT_ORDER_ID_PREFIX,
  shouldMatchOrderQuery,
  VENUE_CLIENT_ORDER_ID_PATTERN,
} from "./order/identity.ts";
import type {
  OrderLocation,
  OrderManagerOptions,
  OrderRecord,
} from "./order/model.ts";
import { createSnapshot, isOpenOrder } from "./order/snapshot.ts";
import {
  getAllSnapshots,
  getExistingSnapshot,
  getLocalOrderIdForVenueOrderId,
  getLocationByLocalOrderId,
  getOpenOrderSnapshots,
  getSnapshotAtLocation,
  getSnapshotByLocalOrderId,
  getSnapshotCount,
  getSnapshotsForClientOrderId,
  getSnapshotsForOrderId,
  isVenueClientOrderIdInUseForOpenOrder,
  resolveLocalOrderIdForUpdate,
  selectLatestSnapshot,
  setSnapshot,
} from "./order/store.ts";

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
      const requestStartedAt = this.context.now();
      const update = await this.context.createOrder(commandInput);
      const snapshot = this.applyCommandUpdate(
        input.accountId,
        account.venue,
        update,
        { localOrderId, requestStartedAt },
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
      const requestStartedAt = this.context.now();
      const update = await this.context.cancelOrder(input);
      return this.applyCommandUpdate(input.accountId, account.venue, update, {
        requestStartedAt,
      });
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
      const requestStartedAt = this.context.now();
      const updates = await this.context.cancelAllOrders(input);
      return this.applyCommandUpdates(input.accountId, account.venue, updates, {
        requestStartedAt,
      });
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
      const localOrderId = getLocalOrderIdForVenueOrderId(
        record,
        input.symbol,
        input.orderId,
      );
      const snapshot = localOrderId
        ? getSnapshotByLocalOrderId(record, localOrderId)
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
      return selectLatestSnapshot(
        getSnapshotsForOrderId(record, input.orderId).filter((snapshot) =>
          shouldMatchOrderQuery(snapshot, input),
        ),
      );
    }

    if (input.clientOrderId) {
      return selectLatestSnapshot(
        getSnapshotsForClientOrderId(record, input.clientOrderId).filter(
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

    return getOpenOrderSnapshots(record, symbol);
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
      ...createOrderDataStatus(accountId, venue, "active"),
      ready: getSnapshotCount(record) > 0,
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
      const current = getExistingSnapshot(record, update);
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

    const disappeared = getOpenOrderSnapshots(record).filter((order) => {
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

    const orderedSnapshots = getAllSnapshots(record);
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
      status: createOrderDataStatus(accountId, venue, "inactive"),
    };

    this.records.set(accountId, record);
    return record;
  }

  private resolveLocalOrderIdForUpdate(
    record: OrderRecord,
    update: { symbol: string; orderId?: string; clientOrderId?: string },
    preferredLocalOrderId?: string,
  ): {
    localOrderId?: string;
    source?: "exact" | "pending" | "provisional" | "preferred";
  } {
    const pending =
      update.clientOrderId === undefined
        ? undefined
        : record.pendingClientOrderIdIndex.get(update.clientOrderId);

    return resolveLocalOrderIdForUpdate(record, update, {
      preferredLocalOrderId,
      pendingLocalOrderId:
        pending?.symbol === update.symbol ? pending.localOrderId : undefined,
    });
  }

  private writeSnapshot(
    record: OrderRecord,
    localOrderId: string,
    snapshot: OrderSnapshot,
    previousLocation?: OrderLocation,
  ): boolean {
    if (!snapshot.orderId && !snapshot.clientOrderId) {
      this.warnDroppedUnkeyedTerminalOrder(record, snapshot);
      return false;
    }

    const result = setSnapshot(record, localOrderId, snapshot, {
      maxClosedOrdersPerSymbol: this.maxClosedOrdersPerSymbol,
      previousLocation,
    });
    if (!result.location) {
      return false;
    }

    this.warnSystemClientOrderIdOnlyClaim(record, snapshot);
    this.warnProvisionalTerminalOrder(record, snapshot);
    return true;
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
      !isSystemClientOrderId(snapshot.clientOrderId)
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
    // Terminal order missing orderId but carrying clientOrderId: stored under a
    // provisional client key and warned. The adapter contract requires terminal
    // updates to carry orderId (see adapter-contract.md); clientOrderId alone
    // cannot guarantee a stable unique primary key.
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

  private applyUpdateToRecord(
    record: OrderRecord,
    accountId: string,
    venue: Venue,
    update: RawOrderUpdate,
    options: { requestStartedAt?: number; preserveStatus?: boolean } = {},
  ): OrderSnapshot | undefined {
    const resolution = this.resolveLocalOrderIdForUpdate(record, update);
    const localOrderId = resolution.localOrderId ?? this.generateLocalOrderId();
    const previousLocation = getLocationByLocalOrderId(record, localOrderId);
    const previous = previousLocation
      ? getSnapshotAtLocation(record, previousLocation)
      : undefined;
    if (
      !shouldApplyWatermarkedUpdate(previous, update, {
        requestStartedAt: options.requestStartedAt,
        source: options.requestStartedAt === undefined ? "stream" : "rest",
      })
    ) {
      return undefined;
    }

    const snapshot = createSnapshot(accountId, venue, update, previous);
    const written = this.writeSnapshot(
      record,
      localOrderId,
      snapshot,
      previousLocation,
    );
    if (written && resolution.source === "pending" && update.clientOrderId) {
      this.clearPendingClientOrderClaim(
        record,
        update.clientOrderId,
        localOrderId,
      );
    }

    return written ? snapshot : undefined;
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
          isVenueClientOrderIdInUseForOpenOrder(options.record, candidate)) ||
        options?.record?.pendingClientOrderIdIndex.has(candidate) ||
        !VENUE_CLIENT_ORDER_ID_PATTERN.test(candidate)
      ) {
        continue;
      }

      return candidate;
    }
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
    options: { localOrderId?: string; requestStartedAt?: number } = {},
  ): OrderSnapshot {
    const record = this.getOrCreateRecord(accountId, venue);
    const resolution = this.resolveLocalOrderIdForUpdate(
      record,
      update,
      options.localOrderId,
    );
    const localOrderId = resolution.localOrderId ?? this.generateLocalOrderId();
    const previousLocation = getLocationByLocalOrderId(record, localOrderId);
    const previous = previousLocation
      ? getSnapshotAtLocation(record, previousLocation)
      : undefined;
    if (
      previous &&
      !shouldApplyWatermarkedUpdate(previous, update, {
        requestStartedAt: options.requestStartedAt,
        source: "command",
      })
    ) {
      return previous;
    }

    const snapshot = createSnapshot(accountId, venue, update, previous);
    this.writeSnapshot(record, localOrderId, snapshot, previousLocation);
    return snapshot;
  }

  private applyCommandUpdates(
    accountId: string,
    venue: Venue,
    updates: RawOrderUpdate[],
    options: { requestStartedAt?: number } = {},
  ): OrderSnapshot[] {
    return updates.map((update) =>
      this.applyCommandUpdate(accountId, venue, update, options),
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
