import type {
  AccountAwareManager,
  ClientContext,
  HealthReporter,
  ManagerLifecycle,
} from "../client/context.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { matchesOrderFilter } from "../internal/filters.ts";
import type {
  Exchange,
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
} from "../types/index.ts";

interface OrderRecord {
  accountId: string;
  exchange: Exchange;
  subscribed: boolean;
  snapshots: Map<string, OrderSnapshot>;
  status: OrderDataStatus;
}

function cloneOrderStatus(status: OrderDataStatus): OrderDataStatus {
  return { ...status };
}

export class OrderManagerImpl
  implements
    OrderManager,
    ManagerLifecycle,
    AccountAwareManager,
    HealthReporter<OrderDataStatus>
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
            { accountId: event.accountId, exchange: event.exchange },
            filter,
          ),
        ),
      updates: (filter) =>
        this.orderBus.stream((event) =>
          matchesOrderFilter(
            {
              accountId: event.accountId,
              exchange: event.exchange,
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
    this.context.ensurePrivateCredentials(input.accountId);

    const record = this.getOrCreateRecord(input.accountId, account.exchange);
    record.subscribed = true;
    record.status = {
      ...this.createStatus(input.accountId, account.exchange, "active"),
      ready: true,
      runtimeStatus: "healthy",
      lastReceivedAt: this.context.now(),
      lastReadyAt: this.context.now(),
    };

    const event: OrderSnapshotReplacedEvent = {
      type: "order.snapshot_replaced",
      accountId: record.accountId,
      exchange: record.exchange,
      snapshot: [...record.snapshots.values()],
      ts: this.context.now(),
    };

    this.orderBus.publish(event);
    this.publishStatus(record);
  }

  async unsubscribeOrders(input: UnsubscribeOrdersInput): Promise<void> {
    const record = this.records.get(input.accountId);
    if (!record?.subscribed) {
      return;
    }

    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
      inactiveSince: this.context.now(),
    };
    this.publishStatus(record);
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

  onClientStarted(): void {
    const now = this.context.now();

    for (const [accountId, record] of this.records) {
      if (!record.subscribed) {
        continue;
      }

      const account = this.context.getRegisteredAccount(accountId);
      const creds = account.credentials;
      if (!creds?.apiKey || !creds.secret) {
        continue;
      }

      record.status = {
        ...this.createStatus(accountId, account.exchange, "active"),
        ready: true,
        runtimeStatus: "healthy",
        lastReceivedAt: now,
        lastReadyAt: now,
      };
      this.publishStatus(record);
    }
  }

  onClientStopping(now: number): void {
    for (const record of this.records.values()) {
      if (!record.subscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "inactive",
        runtimeStatus: "stopped",
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
      inactiveSince: now,
    };
    this.publishStatus(record);
    this.records.delete(accountId);
  }

  onCredentialsUpdated(accountId: string, exchange: Exchange): void {
    const record = this.records.get(accountId);
    if (!record?.subscribed) {
      return;
    }

    record.status = this.createStatus(accountId, exchange, "active");
    record.status.ready = true;
    record.status.runtimeStatus = "healthy";
    record.status.lastReadyAt = this.context.now();
    this.publishStatus(record);
  }

  // --- HealthReporter ---

  getStatuses(): OrderDataStatus[] {
    return [...this.records.values()]
      .map((record) => cloneOrderStatus(record.status))
      .sort((left, right) =>
        `${left.exchange}:${left.accountId}`.localeCompare(
          `${right.exchange}:${right.accountId}`,
        ),
      );
  }

  // --- Internal helpers ---

  private getOrCreateRecord(
    accountId: string,
    exchange: Exchange,
  ): OrderRecord {
    const existing = this.records.get(accountId);
    if (existing) {
      return existing;
    }

    const record: OrderRecord = {
      accountId,
      exchange,
      subscribed: false,
      snapshots: new Map(),
      status: this.createStatus(accountId, exchange, "inactive"),
    };

    this.records.set(accountId, record);
    return record;
  }

  private createStatus(
    accountId: string,
    exchange: Exchange,
    activity: "active" | "inactive",
  ): OrderDataStatus {
    return {
      accountId,
      exchange,
      activity,
      ready: false,
      runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
    };
  }

  private publishStatus(record: OrderRecord): void {
    const event: OrderStatusChangedEvent = {
      type: "order.status_changed",
      accountId: record.accountId,
      exchange: record.exchange,
      status: cloneOrderStatus(record.status),
      ts: this.context.now(),
    };

    this.orderStatusBus.publish(event);
    this.context.publishHealthEvent(event);
  }
}
