import type {
  FetchOrderRequest,
  PrivateUserDataAdapter,
  RawOpenOrdersSnapshot,
  StreamHandle,
} from "../adapters/types.ts";
import {
  AcexError,
  buildAcexErrorDetails,
  formatAcexErrorMessage,
} from "../errors.ts";
import { isTransportError } from "../internal/http-client.ts";
import type {
  AccountRuntimeOptions,
  BinanceAccountRuntimeOptions,
  OrderRuntimeOptions,
  OrderSnapshot,
  PrivateRuntimeReason,
  Venue,
} from "../types/index.ts";
import type {
  ClientContext,
  ExpiredPendingOrderClaim,
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
  accountSubscriptionGeneration: number;
  orderSubscriptionGeneration: number;
  privateReconcileTimer?: ReturnType<typeof setTimeout>;
  privateReconcilePromise?: Promise<void>;
  privateReconcileGeneration: number;
  privateReconcileDirty: boolean;
  privateReconcilePendingPreserveStatus: boolean;
  privateReconcilePollRequested: boolean;
  privateReconcilePollGeneration?: number;
  startPromise?: Promise<void>;
}

interface BinanceCoordinatorOptionsSnapshot {
  riskPollIntervalMs: number;
  privateReconcileIntervalMs: number | undefined;
  privateStreamStaleAfterMs: number;
  listenKeyKeepAliveMs: number;
}

const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_STREAM_RECONNECT_MAX_DELAY_MS = 10_000;
const DEFAULT_LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1_000;
const DEFAULT_PRIVATE_STREAM_STALE_AFTER_MS = 65 * 60_000;
const DEFAULT_BINANCE_RISK_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BINANCE_PRIVATE_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_PENDING_CLAIM_TTL_MS = 90_000;
const MAX_ORDER_TERMINAL_BACKFILLS_PER_RECONCILE = 20;
const MAX_ORDER_TERMINAL_BACKFILL_CONCURRENCY = 4;

function normalizePositiveInterval(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function normalizeReconcileInterval(
  value: number | undefined,
  fallback: number,
): number | undefined {
  if (value === 0) {
    return undefined;
  }

  return normalizePositiveInterval(value, fallback);
}

function normalizeBinanceCoordinatorOptions(
  options: BinanceAccountRuntimeOptions | undefined,
): BinanceCoordinatorOptionsSnapshot {
  return {
    riskPollIntervalMs: normalizePositiveInterval(
      options?.riskPollIntervalMs,
      DEFAULT_BINANCE_RISK_POLL_INTERVAL_MS,
    ),
    privateReconcileIntervalMs: normalizeReconcileInterval(
      options?.privateReconcileIntervalMs,
      DEFAULT_BINANCE_PRIVATE_RECONCILE_INTERVAL_MS,
    ),
    privateStreamStaleAfterMs: normalizePositiveInterval(
      options?.privateStreamStaleAfterMs,
      DEFAULT_PRIVATE_STREAM_STALE_AFTER_MS,
    ),
    listenKeyKeepAliveMs: normalizePositiveInterval(
      options?.listenKeyKeepAliveMs,
      DEFAULT_LISTEN_KEY_KEEPALIVE_MS,
    ),
  };
}

function transportReason(
  error: unknown,
  fallback: PrivateRuntimeReason,
): PrivateRuntimeReason {
  return isTransportError(error) && error.kind === "rate_limited"
    ? "rate_limited"
    : fallback;
}

export class PrivateSubscriptionCoordinator {
  private readonly context: ClientContext;
  private readonly adapters: Map<Venue, PrivateUserDataAdapter>;
  private readonly accountConsumer: PrivateAccountDataConsumer;
  private readonly orderConsumer: PrivateOrderDataConsumer;
  private readonly streamOpenTimeoutMs: number;
  private readonly streamReconnectDelayMs: number;
  private readonly streamReconnectMaxDelayMs: number;
  private readonly binanceOptions: BinanceCoordinatorOptionsSnapshot;
  private readonly pendingClaimTtlMs: number;
  private readonly records = new Map<string, PrivateSubscriptionRecord>();

  constructor(
    context: ClientContext,
    adapters: PrivateUserDataAdapter[],
    accountConsumer: PrivateAccountDataConsumer,
    orderConsumer: PrivateOrderDataConsumer,
    options: AccountRuntimeOptions = {},
    orderOptions: OrderRuntimeOptions = {},
  ) {
    this.context = context;
    this.binanceOptions = normalizeBinanceCoordinatorOptions(
      options.venues?.binance,
    );
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
    this.pendingClaimTtlMs = normalizePositiveInterval(
      orderOptions.pendingClaimTtlMs,
      DEFAULT_PENDING_CLAIM_TTL_MS,
    );
  }

  async subscribeAccountFeed(accountId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const record = this.getOrCreateRecord(account);
    const needsPending = !record.stream && !record.startPromise;
    record.accountSubscribed = true;
    const generation = record.privateReconcileGeneration;
    const accountGeneration = record.accountSubscriptionGeneration;
    if (needsPending) {
      this.accountConsumer.onPrivateAccountPending(accountId, record.venue);
    }

    try {
      const adapter = this.getAdapter(record.venue);
      if (adapter.accountCapabilities.updates === "polling") {
        await this.bootstrapAccount(
          record,
          account,
          generation,
          accountGeneration,
        );
        if (
          !this.shouldContinueAccountBootstrap(
            record,
            generation,
            accountGeneration,
          )
        ) {
          return;
        }
        await this.ensureStream(record, account);
        if (
          !this.shouldContinueAccountBootstrap(
            record,
            generation,
            accountGeneration,
          )
        ) {
          return;
        }
        this.ensurePrivateReconcilePolling(record);
      } else {
        await this.ensureStream(record, account);
        if (
          !this.shouldContinueAccountBootstrap(
            record,
            generation,
            accountGeneration,
          )
        ) {
          return;
        }
        await this.bootstrapAccount(
          record,
          account,
          generation,
          accountGeneration,
        );
        if (
          !this.shouldContinueAccountBootstrap(
            record,
            generation,
            accountGeneration,
          )
        ) {
          return;
        }
        this.ensureAccountRefreshPolling(record);
        this.ensurePrivateReconcilePolling(record);
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
    record.accountSubscriptionGeneration += 1;
    this.stopAccountRefreshPolling(record);
    this.restartPrivateReconcilePolling(record);
    this.closeIfUnused(record);
  }

  async subscribeOrderFeed(accountId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const record = this.getOrCreateRecord(account);
    const needsPending = !record.stream && !record.startPromise;
    record.ordersSubscribed = true;
    const generation = record.privateReconcileGeneration;
    const orderGeneration = record.orderSubscriptionGeneration;
    if (needsPending) {
      this.orderConsumer.onPrivateOrderPending(accountId, record.venue);
    }

    try {
      await this.ensureStream(record, account);
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }
      await this.bootstrapOrders(record, account, generation, orderGeneration);
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }
      this.ensurePrivateReconcilePolling(record);
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
    record.orderSubscriptionGeneration += 1;
    this.restartPrivateReconcilePolling(record);
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
      this.stopPrivateReconcilePolling(record);
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
    this.stopPrivateReconcilePolling(record);
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
    this.stopPrivateReconcilePolling(record);
    const generation = record.privateReconcileGeneration;
    const accountGeneration = record.accountSubscriptionGeneration;
    const orderGeneration = record.orderSubscriptionGeneration;

    try {
      const adapter = this.getAdapter(record.venue);
      if (
        adapter.accountCapabilities.updates === "polling" &&
        record.accountSubscribed
      ) {
        await this.bootstrapAccount(
          record,
          account,
          generation,
          accountGeneration,
        );
        if (
          this.shouldContinueAccountBootstrap(
            record,
            generation,
            accountGeneration,
          )
        ) {
          await this.ensureStream(record, account);
          if (
            this.shouldContinueAccountBootstrap(
              record,
              generation,
              accountGeneration,
            )
          ) {
            this.ensurePrivateReconcilePolling(record);
          }
        }
      } else {
        await this.ensureStream(record, account);
        if (
          this.shouldContinueAccountBootstrap(
            record,
            generation,
            accountGeneration,
          )
        ) {
          await this.bootstrapAccount(
            record,
            account,
            generation,
            accountGeneration,
          );
        }
        if (
          this.shouldContinueAccountBootstrap(
            record,
            generation,
            accountGeneration,
          )
        ) {
          this.ensureAccountRefreshPolling(record);
          this.ensurePrivateReconcilePolling(record);
        }
      }
      if (
        this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        await this.bootstrapOrders(
          record,
          account,
          generation,
          orderGeneration,
        );
      }
      if (
        this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        this.ensurePrivateReconcilePolling(record);
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
        { details: buildAcexErrorDetails({ venue: account.venue }) },
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
        { details: buildAcexErrorDetails({ venue }) },
      );
    }

    return adapter;
  }

  private getAccountRefreshIntervalMs(
    record: PrivateSubscriptionRecord,
  ): number | undefined {
    if (record.venue !== "binance") {
      return undefined;
    }

    return this.binanceOptions.riskPollIntervalMs;
  }

  private getPrivateReconcileIntervalMs(
    record: PrivateSubscriptionRecord,
  ): number | undefined {
    if (record.venue !== "binance") {
      return undefined;
    }

    return this.binanceOptions.privateReconcileIntervalMs;
  }

  private getPrivateStreamStaleAfterMs(
    record: PrivateSubscriptionRecord,
  ): number {
    if (record.venue !== "binance") {
      return DEFAULT_PRIVATE_STREAM_STALE_AFTER_MS;
    }

    return this.binanceOptions.privateStreamStaleAfterMs;
  }

  private getListenKeyKeepAliveMs(record: PrivateSubscriptionRecord): number {
    if (record.venue !== "binance") {
      return DEFAULT_LISTEN_KEY_KEEPALIVE_MS;
    }

    return this.binanceOptions.listenKeyKeepAliveMs;
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
      accountSubscriptionGeneration: 0,
      orderSubscriptionGeneration: 0,
      privateReconcileGeneration: 0,
      privateReconcileDirty: false,
      privateReconcilePendingPreserveStatus: true,
      privateReconcilePollRequested: false,
    };

    this.records.set(account.accountId, record);
    return record;
  }

  private isActive(record: PrivateSubscriptionRecord): boolean {
    return record.accountSubscribed || record.ordersSubscribed;
  }

  private shouldContinueAccountBootstrap(
    record: PrivateSubscriptionRecord,
    generation: number,
    accountGeneration: number,
  ): boolean {
    return (
      record.accountSubscribed &&
      generation === record.privateReconcileGeneration &&
      accountGeneration === record.accountSubscriptionGeneration
    );
  }

  private shouldContinueOrderBootstrap(
    record: PrivateSubscriptionRecord,
    generation: number,
    orderGeneration: number,
  ): boolean {
    return (
      record.ordersSubscribed &&
      generation === record.privateReconcileGeneration &&
      orderGeneration === record.orderSubscriptionGeneration
    );
  }

  private closeIfUnused(record: PrivateSubscriptionRecord): void {
    if (this.isActive(record)) {
      return;
    }

    this.stopAccountRefreshPolling(record);
    this.stopPrivateReconcilePolling(record);
    this.closeStream(record);
    this.records.delete(record.accountId);
  }

  private closeStream(record: PrivateSubscriptionRecord): void {
    record.stream?.close();
    record.stream = undefined;
  }

  private ensureAccountRefreshPolling(record: PrivateSubscriptionRecord): void {
    const intervalMs = this.getAccountRefreshIntervalMs(record);
    if (
      intervalMs === undefined ||
      typeof this.getAdapter(record.venue).refreshAccount !== "function" ||
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
    const intervalMs = this.getAccountRefreshIntervalMs(record);
    if (
      intervalMs === undefined ||
      typeof this.getAdapter(record.venue).refreshAccount !== "function" ||
      !record.accountSubscribed
    ) {
      return;
    }

    const generation = record.accountRefreshGeneration;
    record.accountRefreshTimer = setTimeout(() => {
      record.accountRefreshTimer = undefined;
      if (
        generation !== record.accountRefreshGeneration ||
        typeof this.getAdapter(record.venue).refreshAccount !== "function" ||
        !record.accountSubscribed
      ) {
        return;
      }

      let latestAccount: RegisteredAccountRecord;
      try {
        latestAccount = this.getAccount(record.accountId);
      } catch (error) {
        this.handleAccountRefreshLookupError(record, error);
        return;
      }

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
          if (
            record.accountSubscribed &&
            typeof this.getAdapter(record.venue).refreshAccount === "function"
          ) {
            this.scheduleAccountRefreshPoll(record);
          }
        });
    }, intervalMs);
  }

  private hasPrivateReconcileCapability(
    record: PrivateSubscriptionRecord,
  ): boolean {
    const adapter = this.getAdapter(record.venue);
    return (
      (record.accountSubscribed &&
        (typeof adapter.reconcileAccount === "function" ||
          typeof adapter.bootstrapAccount === "function")) ||
      (record.ordersSubscribed && typeof adapter.fetchOpenOrders === "function")
    );
  }

  private ensurePrivateReconcilePolling(
    record: PrivateSubscriptionRecord,
  ): void {
    const intervalMs = this.getPrivateReconcileIntervalMs(record);
    if (
      intervalMs === undefined ||
      !this.isActive(record) ||
      !this.hasPrivateReconcileCapability(record) ||
      record.privateReconcileTimer
    ) {
      return;
    }

    this.schedulePrivateReconcilePoll(record);
  }

  private restartPrivateReconcilePolling(
    record: PrivateSubscriptionRecord,
  ): void {
    if (record.privateReconcileTimer) {
      clearTimeout(record.privateReconcileTimer);
      record.privateReconcileTimer = undefined;
    }
    this.ensurePrivateReconcilePolling(record);
  }

  private stopPrivateReconcilePolling(record: PrivateSubscriptionRecord): void {
    record.privateReconcileGeneration += 1;
    if (record.privateReconcileTimer) {
      clearTimeout(record.privateReconcileTimer);
      record.privateReconcileTimer = undefined;
    }
    record.privateReconcileDirty = false;
    record.privateReconcilePendingPreserveStatus = true;
    record.privateReconcilePollRequested = false;
    record.privateReconcilePollGeneration = undefined;
  }

  private schedulePrivateReconcilePoll(
    record: PrivateSubscriptionRecord,
  ): void {
    const intervalMs = this.getPrivateReconcileIntervalMs(record);
    if (
      intervalMs === undefined ||
      !this.isActive(record) ||
      !this.hasPrivateReconcileCapability(record)
    ) {
      return;
    }

    const generation = record.privateReconcileGeneration;
    record.privateReconcileTimer = setTimeout(() => {
      record.privateReconcileTimer = undefined;
      if (
        generation !== record.privateReconcileGeneration ||
        this.getPrivateReconcileIntervalMs(record) === undefined ||
        !this.isActive(record) ||
        !this.hasPrivateReconcileCapability(record)
      ) {
        return;
      }

      try {
        this.getAccount(record.accountId);
      } catch (error) {
        this.handlePrivateReconcileLookupError(record, error);
        return;
      }

      this.requestPrivateReconcile(record, {
        preserveStatus: true,
        source: "poll",
        generation,
      });
    }, intervalMs);
  }

  private handlePrivateReconcileLookupError(
    record: PrivateSubscriptionRecord,
    error: unknown,
  ): void {
    this.stopPrivateReconcilePolling(record);
    if (error instanceof AcexError && error.code === "ACCOUNT_NOT_FOUND") {
      return;
    }

    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error(`Failed to load ${record.venue} account for reconcile`),
      {
        accountId: record.accountId,
        venue: record.venue,
      },
    );
  }

  private handleAccountRefreshLookupError(
    record: PrivateSubscriptionRecord,
    error: unknown,
  ): void {
    this.stopAccountRefreshPolling(record);
    if (error instanceof AcexError && error.code === "ACCOUNT_NOT_FOUND") {
      return;
    }

    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error(`Failed to load ${record.venue} account for risk refresh`),
      {
        accountId: record.accountId,
        venue: record.venue,
      },
    );
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

    const requestStartedAt = this.context.now();
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
        { preserveStatus: true, requestStartedAt },
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
          reason: transportReason(error, "http_failed"),
        },
      );
    }
  }

  private async reconcilePrivateData(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    preserveStatus: boolean,
  ): Promise<void> {
    const accountGeneration = record.accountSubscriptionGeneration;
    const orderGeneration = record.orderSubscriptionGeneration;

    await Promise.all([
      this.reconcileAccount(
        record,
        account,
        generation,
        accountGeneration,
        preserveStatus,
      ),
      this.reconcileOrders(
        record,
        account,
        generation,
        orderGeneration,
        preserveStatus,
      ),
    ]);
  }

  private async reconcileAccount(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    accountGeneration: number,
    preserveStatus: boolean,
  ): Promise<void> {
    const adapter = this.getAdapter(record.venue);
    if (
      !this.shouldContinueAccountBootstrap(
        record,
        generation,
        accountGeneration,
      )
    ) {
      return;
    }

    const requestStartedAt = this.context.now();
    try {
      const snapshot = adapter.reconcileAccount
        ? await adapter.reconcileAccount(account.credentials ?? {}, {
            ...account.options,
            accountId: account.accountId,
          })
        : await adapter.bootstrapAccount(account.credentials ?? {}, {
            ...account.options,
            accountId: account.accountId,
          });
      if (
        !this.shouldContinueAccountBootstrap(
          record,
          generation,
          accountGeneration,
        )
      ) {
        return;
      }

      record.accountReady = true;
      this.accountConsumer.onPrivateAccountReconcile(
        record.accountId,
        record.venue,
        snapshot,
        {
          requestStartedAt,
          preserveStatus,
        },
      );
    } catch (error) {
      if (
        !this.shouldContinueAccountBootstrap(
          record,
          generation,
          accountGeneration,
        )
      ) {
        return;
      }

      this.context.publishRuntimeError(
        "adapter",
        error instanceof Error
          ? error
          : new Error(
              `Failed to reconcile ${record.venue} private account state`,
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
          reason: transportReason(error, "http_failed"),
        },
      );
    }
  }

  private async reconcileOrders(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    orderGeneration: number,
    preserveStatus: boolean,
  ): Promise<void> {
    const adapter = this.getAdapter(record.venue);
    if (
      !adapter.fetchOpenOrders ||
      !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
    ) {
      return;
    }

    const requestStartedAt = this.context.now();
    try {
      const snapshot = await adapter.fetchOpenOrders(
        account.credentials ?? {},
        {
          ...account.options,
          accountId: account.accountId,
        },
      );
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      record.orderReady = true;
      const disappeared = this.orderConsumer.onPrivateOrderReconcile(
        record.accountId,
        record.venue,
        snapshot,
        {
          requestStartedAt,
          preserveStatus,
        },
      );
      await this.backfillDisappearedOrders(
        record,
        account,
        generation,
        orderGeneration,
        disappeared,
      );
      await this.reconcileExpiredPendingOrderClaims(
        record,
        account,
        generation,
        orderGeneration,
      );
    } catch (error) {
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      this.handleOrderReconcileError(record, error);
    }
  }

  private async backfillDisappearedOrders(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    orderGeneration: number,
    disappeared: OrderSnapshot[],
  ): Promise<void> {
    const adapter = this.getAdapter(record.venue);
    if (!adapter.fetchOrder || disappeared.length === 0) {
      return;
    }

    const pending = disappeared
      .filter((order) => order.orderId || order.clientOrderId)
      .slice(0, MAX_ORDER_TERMINAL_BACKFILLS_PER_RECONCILE);
    if (pending.length === 0) {
      return;
    }

    let cursor = 0;
    const workers = Array.from(
      {
        length: Math.min(
          MAX_ORDER_TERMINAL_BACKFILL_CONCURRENCY,
          pending.length,
        ),
      },
      async () => {
        while (cursor < pending.length) {
          if (
            !this.shouldContinueOrderBootstrap(
              record,
              generation,
              orderGeneration,
            )
          ) {
            return;
          }

          const order = pending[cursor];
          cursor += 1;
          if (!order) {
            continue;
          }
          await this.backfillDisappearedOrder(
            record,
            account,
            generation,
            orderGeneration,
            order,
          );
        }
      },
    );

    await Promise.all(workers);
  }

  private async backfillDisappearedOrder(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    orderGeneration: number,
    order: OrderSnapshot,
  ): Promise<void> {
    const adapter = this.getAdapter(record.venue);
    if (
      !adapter.fetchOrder ||
      !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
    ) {
      return;
    }

    const requestStartedAt = this.context.now();
    try {
      let request: FetchOrderRequest;
      if (order.orderId) {
        request = {
          symbol: order.symbol,
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
        };
      } else if (order.clientOrderId) {
        request = {
          symbol: order.symbol,
          clientOrderId: order.clientOrderId,
        };
      } else {
        return;
      }

      const update = await adapter.fetchOrder(
        account.credentials ?? {},
        request,
        { ...account.options, accountId: account.accountId },
      );
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      if (!update) {
        this.orderConsumer.onPrivateOrderConfirmedMissing(
          record.accountId,
          record.venue,
          order,
        );
        return;
      }

      this.orderConsumer.onPrivateOrderUpdate(
        record.accountId,
        record.venue,
        update,
        {
          requestStartedAt,
        },
      );
    } catch (error) {
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      this.handleOrderReconcileError(record, error);
    }
  }

  private async reconcileExpiredPendingOrderClaims(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    orderGeneration: number,
  ): Promise<void> {
    const adapter = this.getAdapter(record.venue);
    if (
      !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
    ) {
      return;
    }

    if (!adapter.fetchOrder) {
      // Pending createOrder claims can only be retired after the venue confirms
      // the clientOrderId is absent. Adapters without fetchOrder keep claims.
      return;
    }

    const expiredClaims = this.orderConsumer.getExpiredPrivateOrderClaims(
      record.accountId,
      this.context.now(),
      this.pendingClaimTtlMs,
    );
    for (const claim of expiredClaims) {
      await this.reconcileExpiredPendingOrderClaim(
        record,
        account,
        generation,
        orderGeneration,
        claim,
      );
    }
  }

  private async reconcileExpiredPendingOrderClaim(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    orderGeneration: number,
    claim: ExpiredPendingOrderClaim,
  ): Promise<void> {
    const adapter = this.getAdapter(record.venue);
    if (
      !adapter.fetchOrder ||
      !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
    ) {
      return;
    }

    const requestStartedAt = this.context.now();
    try {
      const update = await adapter.fetchOrder(
        account.credentials ?? {},
        {
          symbol: claim.symbol,
          clientOrderId: claim.venueClientOrderId,
        },
        { ...account.options, accountId: account.accountId },
      );
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      if (!update) {
        this.orderConsumer.onPrivateOrderClaimNotFound(
          record.accountId,
          record.venue,
          claim,
        );
        return;
      }

      this.orderConsumer.onPrivateOrderUpdate(
        record.accountId,
        record.venue,
        update,
        {
          requestStartedAt,
        },
      );
    } catch (error) {
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      this.handleOrderReconcileError(record, error);
    }
  }

  private handleOrderReconcileError(
    record: PrivateSubscriptionRecord,
    error: unknown,
  ): void {
    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error(`Failed to reconcile ${record.venue} private order state`),
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
        ready: record.orderReady,
        reason: transportReason(error, "http_failed"),
      },
    );
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
    const adapter = this.getAdapter(record.venue);
    const credentials = account.credentials;
    if (adapter.accountCapabilities.credentialsRequired && !credentials) {
      throw new AcexError(
        "CREDENTIALS_MISSING",
        `Account credentials are required for private subscriptions: ${account.accountId}`,
        {
          details: buildAcexErrorDetails({
            accountId: account.accountId,
            venue: account.venue,
          }),
        },
      );
    }

    const stream = adapter.createPrivateStream(
      credentials ?? {},
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
        onFreshnessChange: (_freshness, reason) => {
          if (record.accountSubscribed) {
            this.accountConsumer.onPrivateAccountStreamState(
              record.accountId,
              record.venue,
              {
                runtimeStatus: "reconnecting",
                ready: record.accountReady,
                reason,
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
                reason,
              },
            );
          }
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
          this.requestImmediateReconcile(record);
        },
        requestReconcile: () => {
          this.requestImmediateReconcile(record);
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
                reason: transportReason(error, "http_failed"),
              },
            );
          }
        },
      },
      {
        openTimeoutMs: this.streamOpenTimeoutMs,
        reconnectDelayMs: this.streamReconnectDelayMs,
        reconnectMaxDelayMs: this.streamReconnectMaxDelayMs,
        listenKeyKeepAliveMs: this.getListenKeyKeepAliveMs(record),
        staleAfterMs: this.getPrivateStreamStaleAfterMs(record),
        now: () => this.context.now(),
      },
      { ...account.options, accountId: account.accountId },
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
    preserveStatus: boolean,
  ): Promise<void> {
    const account = this.getAccount(record.accountId);
    const generation = record.privateReconcileGeneration;

    if (!preserveStatus && record.accountSubscribed) {
      this.accountConsumer.onPrivateAccountPending(
        record.accountId,
        record.venue,
      );
    }

    if (!preserveStatus && record.ordersSubscribed) {
      this.orderConsumer.onPrivateOrderPending(record.accountId, record.venue);
    }

    await this.reconcilePrivateData(
      record,
      account,
      generation,
      preserveStatus,
    );
  }

  private requestImmediateReconcile(record: PrivateSubscriptionRecord): void {
    this.requestPrivateReconcile(record, {
      preserveStatus: false,
      source: "immediate",
    });
  }

  private requestPrivateReconcile(
    record: PrivateSubscriptionRecord,
    request: {
      preserveStatus: boolean;
      source: "immediate" | "poll";
      generation?: number;
    },
  ): void {
    if (!this.isActive(record) || !this.hasPrivateReconcileCapability(record)) {
      return;
    }

    if (
      request.source === "poll" &&
      (request.generation !== record.privateReconcileGeneration ||
        this.getPrivateReconcileIntervalMs(record) === undefined)
    ) {
      return;
    }

    if (record.privateReconcileDirty) {
      record.privateReconcilePendingPreserveStatus =
        record.privateReconcilePendingPreserveStatus && request.preserveStatus;
    } else {
      record.privateReconcileDirty = true;
      record.privateReconcilePendingPreserveStatus = request.preserveStatus;
    }

    if (request.source === "poll") {
      record.privateReconcilePollRequested = true;
      record.privateReconcilePollGeneration = record.privateReconcileGeneration;
    }

    if (record.privateReconcilePromise) {
      return;
    }

    this.startPrivateReconcileDrain(record);
  }

  private startPrivateReconcileDrain(record: PrivateSubscriptionRecord): void {
    const promise = Promise.resolve().then(() =>
      this.drainPrivateReconcileRequests(record),
    );
    record.privateReconcilePromise = promise.finally(() =>
      this.finalizePrivateReconcileDrain(record),
    );
  }

  private finalizePrivateReconcileDrain(
    record: PrivateSubscriptionRecord,
  ): void {
    record.privateReconcilePromise = undefined;

    if (record.privateReconcileDirty && this.isActive(record)) {
      this.startPrivateReconcileDrain(record);
      return;
    }

    const shouldSchedulePoll =
      record.privateReconcilePollRequested &&
      record.privateReconcilePollGeneration ===
        record.privateReconcileGeneration;

    record.privateReconcileDirty = false;
    record.privateReconcilePendingPreserveStatus = true;
    record.privateReconcilePollRequested = false;
    record.privateReconcilePollGeneration = undefined;

    if (shouldSchedulePoll) {
      this.ensurePrivateReconcilePolling(record);
    }
  }

  private async drainPrivateReconcileRequests(
    record: PrivateSubscriptionRecord,
  ): Promise<void> {
    while (record.privateReconcileDirty && this.isActive(record)) {
      const preserveStatus = record.privateReconcilePendingPreserveStatus;
      record.privateReconcileDirty = false;
      record.privateReconcilePendingPreserveStatus = true;

      try {
        await this.reconcileRecord(record, preserveStatus);
      } catch (error) {
        this.handlePrivateReconcileLookupError(record, error);
      }
    }
  }

  private async bootstrapAccount(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    accountGeneration: number,
  ): Promise<void> {
    if (
      !this.shouldContinueAccountBootstrap(
        record,
        generation,
        accountGeneration,
      )
    ) {
      return;
    }

    try {
      const adapter = this.getAdapter(record.venue);
      const bootstrap = await adapter.bootstrapAccount(
        account.credentials ?? {},
        { ...account.options, accountId: account.accountId },
      );
      if (
        !this.shouldContinueAccountBootstrap(
          record,
          generation,
          accountGeneration,
        )
      ) {
        return;
      }

      record.accountReady = true;
      this.accountConsumer.onPrivateAccountBootstrap(
        record.accountId,
        record.venue,
        bootstrap,
      );
    } catch (error) {
      if (
        !this.shouldContinueAccountBootstrap(
          record,
          generation,
          accountGeneration,
        )
      ) {
        return;
      }

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
          reason: transportReason(
            error,
            this.getAdapter(record.venue).accountCapabilities
              .credentialsRequired
              ? "auth_failed"
              : "http_failed",
          ),
        },
      );
      const details = buildAcexErrorDetails(
        {
          accountId: record.accountId,
          venue: record.venue,
        },
        error,
      );
      throw new AcexError(
        "ACCOUNT_BOOTSTRAP_FAILED",
        formatAcexErrorMessage(
          `Failed to bootstrap account data: ${record.accountId}`,
          details,
        ),
        {
          cause: error,
          details,
        },
      );
    }
  }

  private async bootstrapOrders(
    record: PrivateSubscriptionRecord,
    account: RegisteredAccountRecord,
    generation: number,
    orderGeneration: number,
  ): Promise<void> {
    if (
      !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
    ) {
      return;
    }

    const adapter = this.getAdapter(record.venue);
    if (!adapter.fetchOpenOrders) {
      try {
        const requestStartedAt = this.context.now();
        const orders = await adapter.bootstrapOpenOrders(
          account.credentials ?? {},
          { ...account.options, accountId: account.accountId },
        );
        const snapshot: RawOpenOrdersSnapshot = {
          orders,
          snapshotReceivedAt:
            orders.reduce(
              (latest, order) => Math.max(latest, order.receivedAt),
              0,
            ) || this.context.now(),
        };
        if (
          !this.shouldContinueOrderBootstrap(
            record,
            generation,
            orderGeneration,
          )
        ) {
          return;
        }

        record.orderReady = true;
        const disappeared = this.orderConsumer.onPrivateOrderBootstrap(
          record.accountId,
          record.venue,
          snapshot,
          {
            requestStartedAt,
          },
        );
        await this.backfillDisappearedOrders(
          record,
          account,
          generation,
          orderGeneration,
          disappeared,
        );
        return;
      } catch (error) {
        if (
          !this.shouldContinueOrderBootstrap(
            record,
            generation,
            orderGeneration,
          )
        ) {
          return;
        }

        this.handleBootstrapOrdersError(record, error);
        return;
      }
    }

    const requestStartedAt = this.context.now();
    try {
      const snapshot = await adapter.fetchOpenOrders(
        account.credentials ?? {},
        {
          ...account.options,
          accountId: account.accountId,
        },
      );
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      record.orderReady = true;
      const disappeared = this.orderConsumer.onPrivateOrderBootstrap(
        record.accountId,
        record.venue,
        snapshot,
        {
          requestStartedAt,
        },
      );
      await this.backfillDisappearedOrders(
        record,
        account,
        generation,
        orderGeneration,
        disappeared,
      );
    } catch (error) {
      if (
        !this.shouldContinueOrderBootstrap(record, generation, orderGeneration)
      ) {
        return;
      }

      this.handleBootstrapOrdersError(record, error);
    }
  }

  private handleBootstrapOrdersError(
    record: PrivateSubscriptionRecord,
    error: unknown,
  ): never {
    record.orderReady = false;
    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error(`Failed to bootstrap ${record.venue} private order state`),
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
        reason: transportReason(error, "auth_failed"),
      },
    );
    const details = buildAcexErrorDetails(
      {
        accountId: record.accountId,
        venue: record.venue,
      },
      error,
    );
    throw new AcexError(
      "ORDER_BOOTSTRAP_FAILED",
      formatAcexErrorMessage(
        `Failed to bootstrap order data: ${record.accountId}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
  }
}
