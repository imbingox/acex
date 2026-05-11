import type {
  PrivateUserDataAdapter,
  StreamHandle,
} from "../adapters/types.ts";
import { AcexError } from "../errors.ts";
import type { AccountRuntimeOptions, Venue } from "../types/index.ts";
import type {
  ClientContext,
  PrivateAccountDataConsumer,
  PrivateOrderDataConsumer,
  RegisteredAccountRecord,
} from "./context.ts";

interface PrivateSubscriptionRecord {
  accountId: string;
  venue: Venue;
  accountSubscribed: boolean;
  ordersSubscribed: boolean;
  accountReady: boolean;
  orderReady: boolean;
  stream?: StreamHandle;
  accountRefreshTimer?: ReturnType<typeof setTimeout>;
  accountRefreshInFlight?: Promise<void>;
  accountRefreshGeneration: number;
  startPromise?: Promise<void>;
  reconcilePromise?: Promise<void>;
}

const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_STREAM_RECONNECT_MAX_DELAY_MS = 10_000;
const DEFAULT_LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1_000;
const DEFAULT_BINANCE_RISK_POLL_INTERVAL_MS = 5_000;

export class PrivateSubscriptionCoordinator {
  private readonly context: ClientContext;
  private readonly adapters: Map<Venue, PrivateUserDataAdapter>;
  private readonly accountConsumer: PrivateAccountDataConsumer;
  private readonly orderConsumer: PrivateOrderDataConsumer;
  private readonly streamOpenTimeoutMs: number;
  private readonly streamReconnectDelayMs: number;
  private readonly streamReconnectMaxDelayMs: number;
  private readonly listenKeyKeepAliveMs: number;
  private readonly binanceRiskPollIntervalMs: number;
  private readonly juplendPollIntervalMs?: number;
  private readonly records = new Map<string, PrivateSubscriptionRecord>();

  constructor(
    context: ClientContext,
    adapters: PrivateUserDataAdapter[],
    accountConsumer: PrivateAccountDataConsumer,
    orderConsumer: PrivateOrderDataConsumer,
    options: AccountRuntimeOptions = {},
  ) {
    this.context = context;
    this.adapters = new Map(
      adapters.map((adapter) => [adapter.venue, adapter]),
    );
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
    this.binanceRiskPollIntervalMs =
      options.binance?.riskPollIntervalMs ??
      DEFAULT_BINANCE_RISK_POLL_INTERVAL_MS;
    this.juplendPollIntervalMs = options.juplend?.pollIntervalMs;
  }

  async subscribeAccountFeed(accountId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const record = this.getOrCreateRecord(account);
    const needsPending = !record.stream && !record.startPromise;
    record.accountSubscribed = true;
    if (needsPending) {
      this.accountConsumer.onPrivateAccountPending(accountId, record.venue);
    }

    try {
      if (record.venue === "juplend") {
        await this.bootstrapAccount(record, account);
        await this.ensureStream(record, account);
      } else {
        await this.ensureStream(record, account);
        await this.bootstrapAccount(record, account);
        this.ensureAccountRefreshPolling(record);
      }
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
    this.stopAccountRefreshPolling(record);
    this.closeIfUnused(record);
  }

  async subscribeOrderFeed(accountId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const record = this.getOrCreateRecord(account);
    const needsPending = !record.stream && !record.startPromise;
    record.ordersSubscribed = true;
    if (needsPending) {
      this.orderConsumer.onPrivateOrderPending(accountId, record.venue);
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
          record.venue,
        );
      }
      if (record.ordersSubscribed) {
        this.orderConsumer.onPrivateOrderPending(
          record.accountId,
          record.venue,
        );
      }

      void this.resumeRecord(record);
    }
  }

  onClientStopping(): void {
    for (const record of this.records.values()) {
      this.stopAccountRefreshPolling(record);
      this.closeStream(record);
    }
  }

  onAccountRemoved(accountId: string): void {
    const record = this.records.get(accountId);
    if (!record) {
      return;
    }

    this.closeStream(record);
    this.stopAccountRefreshPolling(record);
    this.records.delete(accountId);
  }

  onCredentialsUpdated(accountId: string): void {
    const record = this.records.get(accountId);
    if (!record || !this.isActive(record)) {
      return;
    }

    if (record.accountSubscribed) {
      this.accountConsumer.onPrivateAccountPending(accountId, record.venue);
    }
    if (record.ordersSubscribed) {
      this.orderConsumer.onPrivateOrderPending(accountId, record.venue);
    }

    void this.resumeRecord(record);
  }

  private async resumeRecord(record: PrivateSubscriptionRecord): Promise<void> {
    const account = this.getAccount(record.accountId);
    this.closeStream(record);
    this.stopAccountRefreshPolling(record);

    try {
      if (record.venue === "juplend" && record.accountSubscribed) {
        await this.bootstrapAccount(record, account);
        await this.ensureStream(record, account);
      } else {
        await this.ensureStream(record, account);
        if (record.accountSubscribed) {
          await this.bootstrapAccount(record, account);
          this.ensureAccountRefreshPolling(record);
        }
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
    if (!this.adapters.has(account.venue)) {
      throw new AcexError(
        "VENUE_NOT_SUPPORTED",
        `Venue is not supported yet: ${account.venue}`,
      );
    }

    return account;
  }

  private getAdapter(venue: Venue): PrivateUserDataAdapter {
    const adapter = this.adapters.get(venue);
    if (!adapter) {
      throw new AcexError(
        "VENUE_NOT_SUPPORTED",
        `Venue is not supported yet: ${venue}`,
      );
    }

    return adapter;
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
      venue: account.venue,
      accountSubscribed: false,
      ordersSubscribed: false,
      accountReady: false,
      orderReady: false,
      accountRefreshGeneration: 0,
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

    this.stopAccountRefreshPolling(record);
    this.closeStream(record);
    this.records.delete(record.accountId);
  }

  private closeStream(record: PrivateSubscriptionRecord): void {
    record.stream?.close();
    record.stream = undefined;
  }

  private ensureAccountRefreshPolling(record: PrivateSubscriptionRecord): void {
    if (
      record.venue !== "binance" ||
      !record.accountSubscribed ||
      record.accountRefreshTimer ||
      record.accountRefreshInFlight
    ) {
      return;
    }

    this.scheduleAccountRefreshPoll(record);
  }

  private stopAccountRefreshPolling(record: PrivateSubscriptionRecord): void {
    record.accountRefreshGeneration += 1;
    if (record.accountRefreshTimer) {
      clearTimeout(record.accountRefreshTimer);
      record.accountRefreshTimer = undefined;
    }
    record.accountRefreshInFlight = undefined;
  }

  private scheduleAccountRefreshPoll(record: PrivateSubscriptionRecord): void {
    if (record.venue !== "binance" || !record.accountSubscribed) {
      return;
    }

    const generation = record.accountRefreshGeneration;
    record.accountRefreshTimer = setTimeout(() => {
      record.accountRefreshTimer = undefined;
      if (
        generation !== record.accountRefreshGeneration ||
        record.venue !== "binance" ||
        !record.accountSubscribed
      ) {
        return;
      }

      const latestAccount = this.getAccount(record.accountId);
      record.accountRefreshInFlight = this.refreshAccount(
        record,
        latestAccount,
        generation,
      )
        .catch(() => {})
        .finally(() => {
          if (generation !== record.accountRefreshGeneration) {
            return;
          }

          record.accountRefreshInFlight = undefined;
          if (record.accountSubscribed && record.venue === "binance") {
            this.scheduleAccountRefreshPoll(record);
          }
        });
    }, this.binanceRiskPollIntervalMs);
  }

  private async refreshAccount(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
  ): Promise<void> {
    const adapter = this.getAdapter(record.venue);
    if (!adapter.refreshAccount) {
      return;
    }

    try {
      const update = await adapter.refreshAccount(account.credentials ?? {}, {
        ...account.options,
        accountId: account.accountId,
      });
      if (
        !record.accountSubscribed ||
        generation !== record.accountRefreshGeneration
      ) {
        return;
      }

      record.accountReady = true;
      this.accountConsumer.onPrivateAccountUpdate(
        record.accountId,
        record.venue,
        update,
        { preserveStatus: true },
      );
    } catch (error) {
      if (
        !record.accountSubscribed ||
        generation !== record.accountRefreshGeneration
      ) {
        return;
      }

      this.context.publishRuntimeError(
        "adapter",
        error instanceof Error
          ? error
          : new Error(
              `Failed to refresh ${record.venue} private account state`,
            ),
        {
          accountId: record.accountId,
          venue: record.venue,
        },
      );
      this.accountConsumer.onPrivateAccountStreamState(
        record.accountId,
        record.venue,
        {
          runtimeStatus: "degraded",
          ready: record.accountReady,
          reason: "http_failed",
        },
      );
    }
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

    const adapter = this.getAdapter(record.venue);
    const stream = adapter.createPrivateStream(
      credentials,
      {
        onAccountSnapshot: (snapshot) => {
          if (!record.accountSubscribed) {
            return;
          }

          record.accountReady = true;
          this.accountConsumer.onPrivateAccountBootstrap(
            record.accountId,
            record.venue,
            snapshot,
          );
        },
        onAccountUpdate: (update) => {
          if (!record.accountSubscribed) {
            return;
          }

          record.accountReady = true;
          this.accountConsumer.onPrivateAccountUpdate(
            record.accountId,
            record.venue,
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
            record.venue,
            update,
          );
        },
        onDisconnected: () => {
          if (record.accountSubscribed) {
            this.accountConsumer.onPrivateAccountStreamState(
              record.accountId,
              record.venue,
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
              record.venue,
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
            venue: record.venue,
          });
          if (record.accountSubscribed) {
            this.accountConsumer.onPrivateAccountStreamState(
              record.accountId,
              record.venue,
              {
                runtimeStatus: "degraded",
                ready: record.accountReady,
                reason: "http_failed",
              },
            );
          }
        },
      },
      {
        openTimeoutMs: this.streamOpenTimeoutMs,
        reconnectDelayMs: this.streamReconnectDelayMs,
        reconnectMaxDelayMs: this.streamReconnectMaxDelayMs,
        listenKeyKeepAliveMs: this.listenKeyKeepAliveMs,
        juplendPollIntervalMs: this.juplendPollIntervalMs,
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
          : new Error(`Failed to open ${record.venue} private stream`);
      this.context.publishRuntimeError("adapter", runtimeError, {
        accountId: record.accountId,
        venue: record.venue,
      });

      if (record.accountSubscribed) {
        this.accountConsumer.onPrivateAccountStreamState(
          record.accountId,
          record.venue,
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
          record.venue,
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
        record.venue,
      );
      await this.bootstrapAccount(record, account);
    }

    if (record.ordersSubscribed) {
      this.orderConsumer.onPrivateOrderPending(record.accountId, record.venue);
      await this.bootstrapOrders(record, account);
    }
  }

  private async bootstrapAccount(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
  ): Promise<void> {
    try {
      const bootstrap = await this.getAdapter(record.venue).bootstrapAccount(
        account.credentials ?? {},
        { ...account.options, accountId: account.accountId },
      );
      if (!record.accountSubscribed) {
        return;
      }

      record.accountReady = true;
      this.accountConsumer.onPrivateAccountBootstrap(
        record.accountId,
        record.venue,
        bootstrap,
      );
    } catch (error) {
      record.accountReady = false;
      this.context.publishRuntimeError(
        "adapter",
        error instanceof Error
          ? error
          : new Error(
              `Failed to bootstrap ${record.venue} private account state`,
            ),
        {
          accountId: record.accountId,
          venue: record.venue,
        },
      );
      this.accountConsumer.onPrivateAccountStreamState(
        record.accountId,
        record.venue,
        {
          runtimeStatus: "degraded",
          ready: false,
          reason: record.venue === "juplend" ? "http_failed" : "auth_failed",
        },
      );
      const reason =
        error instanceof Error && error.message ? ` (${error.message})` : "";
      throw new AcexError(
        "ACCOUNT_BOOTSTRAP_FAILED",
        `Failed to bootstrap account data: ${record.accountId}${reason}`,
      );
    }
  }

  private async bootstrapOrders(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
  ): Promise<void> {
    try {
      const snapshots = await this.getAdapter(record.venue).bootstrapOpenOrders(
        account.credentials ?? {},
        account.options,
      );
      if (!record.ordersSubscribed) {
        return;
      }

      record.orderReady = true;
      this.orderConsumer.onPrivateOrderBootstrap(
        record.accountId,
        record.venue,
        snapshots,
      );
    } catch (error) {
      record.orderReady = false;
      this.context.publishRuntimeError(
        "adapter",
        error instanceof Error
          ? error
          : new Error(
              `Failed to bootstrap ${record.venue} private order state`,
            ),
        {
          accountId: record.accountId,
          venue: record.venue,
        },
      );
      this.orderConsumer.onPrivateOrderStreamState(
        record.accountId,
        record.venue,
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
