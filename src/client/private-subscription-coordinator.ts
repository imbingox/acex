import type {
  PrivateUserDataAdapter,
  StreamHandle,
} from "../adapters/types.ts";
import { AcexError } from "../errors.ts";
import type { AccountRuntimeOptions, Exchange } from "../types/index.ts";
import type {
  ClientContext,
  PrivateAccountDataConsumer,
  PrivateOrderDataConsumer,
  RegisteredAccountRecord,
} from "./context.ts";

interface PrivateSubscriptionRecord {
  accountId: string;
  exchange: Exchange;
  accountSubscribed: boolean;
  ordersSubscribed: boolean;
  accountReady: boolean;
  orderReady: boolean;
  stream?: StreamHandle;
  startPromise?: Promise<void>;
  reconcilePromise?: Promise<void>;
}

const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_STREAM_RECONNECT_MAX_DELAY_MS = 10_000;
const DEFAULT_LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1_000;

export class PrivateSubscriptionCoordinator {
  private readonly context: ClientContext;
  private readonly adapter: PrivateUserDataAdapter;
  private readonly accountConsumer: PrivateAccountDataConsumer;
  private readonly orderConsumer: PrivateOrderDataConsumer;
  private readonly streamOpenTimeoutMs: number;
  private readonly streamReconnectDelayMs: number;
  private readonly streamReconnectMaxDelayMs: number;
  private readonly listenKeyKeepAliveMs: number;
  private readonly records = new Map<string, PrivateSubscriptionRecord>();

  constructor(
    context: ClientContext,
    adapter: PrivateUserDataAdapter,
    accountConsumer: PrivateAccountDataConsumer,
    orderConsumer: PrivateOrderDataConsumer,
    options: AccountRuntimeOptions = {},
  ) {
    this.context = context;
    this.adapter = adapter;
    this.accountConsumer = accountConsumer;
    this.orderConsumer = orderConsumer;
    this.streamOpenTimeoutMs =
      options.streamOpenTimeoutMs ?? DEFAULT_STREAM_OPEN_TIMEOUT_MS;
    this.streamReconnectDelayMs =
      options.streamReconnectDelayMs ?? DEFAULT_STREAM_RECONNECT_DELAY_MS;
    this.streamReconnectMaxDelayMs =
      options.streamReconnectMaxDelayMs ??
      DEFAULT_STREAM_RECONNECT_MAX_DELAY_MS;
    this.listenKeyKeepAliveMs =
      options.listenKeyKeepAliveMs ?? DEFAULT_LISTEN_KEY_KEEPALIVE_MS;
  }

  async subscribeAccountFeed(accountId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const record = this.getOrCreateRecord(account);
    const needsPending = !record.stream && !record.startPromise;
    record.accountSubscribed = true;
    if (needsPending) {
      this.accountConsumer.onPrivateAccountPending(accountId, record.exchange);
    }

    try {
      await this.ensureStream(record, account);
      await this.bootstrapAccount(record, account);
    } catch (error) {
      record.accountSubscribed = false;
      this.closeIfUnused(record);
      throw error;
    }
  }

  unsubscribeAccountFeed(accountId: string): void {
    const record = this.records.get(accountId);
    if (!record) {
      return;
    }

    record.accountSubscribed = false;
    this.closeIfUnused(record);
  }

  async subscribeOrderFeed(accountId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const record = this.getOrCreateRecord(account);
    const needsPending = !record.stream && !record.startPromise;
    record.ordersSubscribed = true;
    if (needsPending) {
      this.orderConsumer.onPrivateOrderPending(accountId, record.exchange);
    }

    try {
      await this.ensureStream(record, account);
      await this.bootstrapOrders(record, account);
    } catch (error) {
      record.ordersSubscribed = false;
      this.closeIfUnused(record);
      throw error;
    }
  }

  unsubscribeOrderFeed(accountId: string): void {
    const record = this.records.get(accountId);
    if (!record) {
      return;
    }

    record.ordersSubscribed = false;
    this.closeIfUnused(record);
  }

  onClientStarted(): void {
    for (const record of this.records.values()) {
      if (!this.isActive(record)) {
        continue;
      }

      if (record.accountSubscribed) {
        this.accountConsumer.onPrivateAccountPending(
          record.accountId,
          record.exchange,
        );
      }
      if (record.ordersSubscribed) {
        this.orderConsumer.onPrivateOrderPending(
          record.accountId,
          record.exchange,
        );
      }

      void this.resumeRecord(record);
    }
  }

  onClientStopping(): void {
    for (const record of this.records.values()) {
      this.closeStream(record);
    }
  }

  onAccountRemoved(accountId: string): void {
    const record = this.records.get(accountId);
    if (!record) {
      return;
    }

    this.closeStream(record);
    this.records.delete(accountId);
  }

  onCredentialsUpdated(accountId: string): void {
    const record = this.records.get(accountId);
    if (!record || !this.isActive(record)) {
      return;
    }

    if (record.accountSubscribed) {
      this.accountConsumer.onPrivateAccountPending(accountId, record.exchange);
    }
    if (record.ordersSubscribed) {
      this.orderConsumer.onPrivateOrderPending(accountId, record.exchange);
    }

    void this.resumeRecord(record);
  }

  private async resumeRecord(record: PrivateSubscriptionRecord): Promise<void> {
    const account = this.getAccount(record.accountId);
    this.closeStream(record);

    try {
      await this.ensureStream(record, account);
      if (record.accountSubscribed) {
        await this.bootstrapAccount(record, account);
      }
      if (record.ordersSubscribed) {
        await this.bootstrapOrders(record, account);
      }
    } catch {
      // Errors are already published to the runtime error bus.
    }
  }

  private getAccount(accountId: string): RegisteredAccountRecord {
    const account = this.context.getRegisteredAccount(accountId);
    if (account.exchange !== this.adapter.exchange) {
      throw new AcexError(
        "EXCHANGE_NOT_SUPPORTED",
        `Exchange is not supported yet: ${account.exchange}`,
      );
    }

    return account;
  }

  private getOrCreateRecord(
    account: RegisteredAccountRecord,
  ): PrivateSubscriptionRecord {
    const existing = this.records.get(account.accountId);
    if (existing) {
      return existing;
    }

    const record: PrivateSubscriptionRecord = {
      accountId: account.accountId,
      exchange: account.exchange,
      accountSubscribed: false,
      ordersSubscribed: false,
      accountReady: false,
      orderReady: false,
    };

    this.records.set(account.accountId, record);
    return record;
  }

  private isActive(record: PrivateSubscriptionRecord): boolean {
    return record.accountSubscribed || record.ordersSubscribed;
  }

  private closeIfUnused(record: PrivateSubscriptionRecord): void {
    if (this.isActive(record)) {
      return;
    }

    this.closeStream(record);
    this.records.delete(record.accountId);
  }

  private closeStream(record: PrivateSubscriptionRecord): void {
    record.stream?.close();
    record.stream = undefined;
  }

  private async ensureStream(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
  ): Promise<void> {
    if (record.stream) {
      return;
    }

    if (!record.startPromise) {
      record.startPromise = this.startStream(record, account);
    }

    try {
      await record.startPromise;
    } finally {
      if (record.startPromise) {
        record.startPromise = undefined;
      }
    }
  }

  private async startStream(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
  ): Promise<void> {
    const credentials = account.credentials;
    if (!credentials) {
      throw new AcexError(
        "CREDENTIALS_MISSING",
        `Account credentials are required for private subscriptions: ${account.accountId}`,
      );
    }

    const stream = this.adapter.createPrivateStream(
      credentials,
      {
        onAccountUpdate: (update) => {
          if (!record.accountSubscribed) {
            return;
          }

          record.accountReady = true;
          this.accountConsumer.onPrivateAccountUpdate(
            record.accountId,
            record.exchange,
            update,
          );
        },
        onOrderUpdate: (update) => {
          if (!record.ordersSubscribed) {
            return;
          }

          record.orderReady = true;
          this.orderConsumer.onPrivateOrderUpdate(
            record.accountId,
            record.exchange,
            update,
          );
        },
        onDisconnected: () => {
          if (record.accountSubscribed) {
            this.accountConsumer.onPrivateAccountStreamState(
              record.accountId,
              record.exchange,
              {
                runtimeStatus: "reconnecting",
                ready: record.accountReady,
                reason: "ws_disconnected",
              },
            );
          }
          if (record.ordersSubscribed) {
            this.orderConsumer.onPrivateOrderStreamState(
              record.accountId,
              record.exchange,
              {
                runtimeStatus: "reconnecting",
                ready: record.orderReady,
                reason: "ws_disconnected",
              },
            );
          }
        },
        onReconnected: () => {
          if (!record.reconcilePromise) {
            record.reconcilePromise = this.reconcileRecord(record)
              .catch(() => {})
              .finally(() => {
                record.reconcilePromise = undefined;
              });
          }
        },
        onError: (error) => {
          this.context.publishRuntimeError("adapter", error, {
            accountId: record.accountId,
            exchange: record.exchange,
          });
        },
      },
      {
        openTimeoutMs: this.streamOpenTimeoutMs,
        reconnectDelayMs: this.streamReconnectDelayMs,
        reconnectMaxDelayMs: this.streamReconnectMaxDelayMs,
        listenKeyKeepAliveMs: this.listenKeyKeepAliveMs,
        now: () => this.context.now(),
      },
      account.options,
    );

    record.stream = stream;

    try {
      await stream.ready;
    } catch (error) {
      this.closeStream(record);
      const runtimeError =
        error instanceof Error
          ? error
          : new Error("Failed to open Binance private stream");
      this.context.publishRuntimeError("adapter", runtimeError, {
        accountId: record.accountId,
        exchange: record.exchange,
      });

      if (record.accountSubscribed) {
        this.accountConsumer.onPrivateAccountStreamState(
          record.accountId,
          record.exchange,
          {
            runtimeStatus: "degraded",
            ready: record.accountReady,
            reason: "ws_disconnected",
          },
        );
      }
      if (record.ordersSubscribed) {
        this.orderConsumer.onPrivateOrderStreamState(
          record.accountId,
          record.exchange,
          {
            runtimeStatus: "degraded",
            ready: record.orderReady,
            reason: "ws_disconnected",
          },
        );
      }

      throw runtimeError;
    }
  }

  private async reconcileRecord(
    record: PrivateSubscriptionRecord,
  ): Promise<void> {
    const account = this.getAccount(record.accountId);

    if (record.accountSubscribed) {
      this.accountConsumer.onPrivateAccountPending(
        record.accountId,
        record.exchange,
      );
      await this.bootstrapAccount(record, account);
    }

    if (record.ordersSubscribed) {
      this.orderConsumer.onPrivateOrderPending(
        record.accountId,
        record.exchange,
      );
      await this.bootstrapOrders(record, account);
    }
  }

  private async bootstrapAccount(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
  ): Promise<void> {
    try {
      const bootstrap = await this.adapter.bootstrapAccount(
        account.credentials ?? {},
        account.options,
      );
      if (!record.accountSubscribed) {
        return;
      }

      record.accountReady = true;
      this.accountConsumer.onPrivateAccountBootstrap(
        record.accountId,
        record.exchange,
        bootstrap,
      );
    } catch (error) {
      record.accountReady = false;
      this.context.publishRuntimeError(
        "adapter",
        error instanceof Error
          ? error
          : new Error("Failed to bootstrap Binance private account state"),
        {
          accountId: record.accountId,
          exchange: record.exchange,
        },
      );
      this.accountConsumer.onPrivateAccountStreamState(
        record.accountId,
        record.exchange,
        {
          runtimeStatus: "degraded",
          ready: false,
          reason: "auth_failed",
        },
      );
      throw new AcexError(
        "ACCOUNT_BOOTSTRAP_FAILED",
        `Failed to bootstrap account data: ${record.accountId}`,
      );
    }
  }

  private async bootstrapOrders(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
  ): Promise<void> {
    try {
      const snapshots = await this.adapter.bootstrapOpenOrders(
        account.credentials ?? {},
        account.options,
      );
      if (!record.ordersSubscribed) {
        return;
      }

      record.orderReady = true;
      this.orderConsumer.onPrivateOrderBootstrap(
        record.accountId,
        record.exchange,
        snapshots,
      );
    } catch (error) {
      record.orderReady = false;
      this.context.publishRuntimeError(
        "adapter",
        error instanceof Error
          ? error
          : new Error("Failed to bootstrap Binance private order state"),
        {
          accountId: record.accountId,
          exchange: record.exchange,
        },
      );
      this.orderConsumer.onPrivateOrderStreamState(
        record.accountId,
        record.exchange,
        {
          runtimeStatus: "degraded",
          ready: false,
          reason: "auth_failed",
        },
      );
      throw new AcexError(
        "ORDER_BOOTSTRAP_FAILED",
        `Failed to bootstrap order data: ${record.accountId}`,
      );
    }
  }
}
