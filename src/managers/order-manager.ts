import { cloneOrderStatus } from "../client/records.ts";
import type { AcexClientImpl } from "../client/runtime.ts";
import type {
  GetOrderInput,
  OrderDataStatus,
  OrderEventStreams,
  OrderManager,
  OrderSnapshot,
  OrderSnapshotReplacedEvent,
  SubscribeOrdersInput,
  UnsubscribeOrdersInput,
} from "../types/index.ts";

export class OrderManagerImpl implements OrderManager {
  readonly events: OrderEventStreams;

  constructor(private readonly client: AcexClientImpl) {
    this.events = client.orderEvents();
  }

  async subscribeOrders(input: SubscribeOrdersInput): Promise<void> {
    this.client.assertStarted();
    const account = this.client.getRegisteredAccount(input.accountId);
    this.client.ensurePrivateCredentials(input.accountId);

    const record = this.client.getOrCreateOrderRecord(input.accountId, account.exchange);
    record.subscribed = true;
    record.status = {
      ...this.client.createOrderStatus(input.accountId, account.exchange, "active"),
      ready: true,
      runtimeStatus: "healthy",
      lastReceivedAt: this.client.now(),
      lastReadyAt: this.client.now(),
    };

    const event: OrderSnapshotReplacedEvent = {
      type: "order.snapshot_replaced",
      accountId: record.accountId,
      exchange: record.exchange,
      snapshot: [...record.snapshots.values()],
      ts: this.client.now(),
    };

    this.client.publishOrderEvent(event);
    this.client.publishOrderStatus(record);
  }

  async unsubscribeOrders(input: UnsubscribeOrdersInput): Promise<void> {
    const record = this.client.getOrderRecord(input.accountId);
    if (!record || !record.subscribed) {
      return;
    }

    record.subscribed = false;
    record.status = {
      ...record.status,
      activity: "inactive",
      runtimeStatus: "stopped",
      inactiveSince: this.client.now(),
    };
    this.client.publishOrderStatus(record);
  }

  getOrder(input: GetOrderInput): OrderSnapshot | undefined {
    const record = this.client.getOrderRecord(input.accountId);
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

      if (input.clientOrderId && snapshot.clientOrderId === input.clientOrderId) {
        return snapshot;
      }
    }

    return undefined;
  }

  getOpenOrders(accountId: string, symbol?: string): OrderSnapshot[] {
    const record = this.client.getOrderRecord(accountId);
    if (!record) {
      return [];
    }

    return [...record.snapshots.values()].filter((snapshot) => {
      if (symbol && snapshot.symbol !== symbol) {
        return false;
      }

      return snapshot.status === "open" || snapshot.status === "partially_filled";
    });
  }

  getOrderStatus(accountId: string): OrderDataStatus | undefined {
    const status = this.client.getOrderRecord(accountId)?.status;
    return status ? cloneOrderStatus(status) : undefined;
  }
}
