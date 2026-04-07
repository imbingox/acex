import { AcexError, type AcexErrorCode } from "../errors.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { AccountManagerImpl } from "../managers/account-manager.ts";
import { MarketManagerImpl } from "../managers/market-manager.ts";
import { OrderManagerImpl } from "../managers/order-manager.ts";
import type {
  AccountCredentials,
  AccountDataStatus,
  AccountEvent,
  AccountEventStreams,
  AccountManager,
  AccountSnapshot,
  AccountStatusChangedEvent,
  AcexClient,
  AcexInternalError,
  ClientEventStreams,
  ClientHealthSnapshot,
  ClientStatus,
  ClientStatusChangedEvent,
  CreateClientOptions,
  Exchange,
  FundingRateSnapshot,
  FundingRateUpdatedEvent,
  HealthEvent,
  HealthEventFilter,
  L1Book,
  L1BookUpdatedEvent,
  MarketEvent,
  MarketEventStreams,
  MarketManager,
  MarketStatusChangedEvent,
  OrderDataStatus,
  OrderEvent,
  OrderEventStreams,
  OrderManager,
  OrderStatusChangedEvent,
  RegisterAccountInput,
  RegisterAccountResult,
  StopOptions,
} from "../types/index.ts";
import {
  type AccountRecord,
  cloneAccountStatus,
  cloneMarketStatus,
  cloneOrderStatus,
  hasPrivateCredentials,
  type MarketRecord,
  marketKey,
  matchesAccountFilter,
  matchesHealthFilter,
  matchesMarketFilter,
  matchesOrderFilter,
  mergeCredentials,
  type OrderRecord,
  type RegisteredAccountRecord,
  sortByJson,
} from "./records.ts";

class ClientEventStreamsImpl implements ClientEventStreams {
  constructor(
    private readonly healthBus: AsyncEventBus<HealthEvent>,
    private readonly errorBus: AsyncEventBus<AcexInternalError>,
  ) {}

  errors(): AsyncIterable<AcexInternalError> {
    return this.errorBus.stream();
  }

  health(filter?: HealthEventFilter): AsyncIterable<HealthEvent> {
    return this.healthBus.stream((event) => matchesHealthFilter(event, filter));
  }
}

export class AcexClientImpl implements AcexClient {
  readonly market: MarketManager;
  readonly account: AccountManager;
  readonly order: OrderManager;
  readonly events: ClientEventStreams;

  private status: ClientStatus = "idle";
  private readonly healthBus = new AsyncEventBus<HealthEvent>();
  private readonly errorBus = new AsyncEventBus<AcexInternalError>();
  private readonly marketBus = new AsyncEventBus<MarketEvent>();
  private readonly marketStatusBus =
    new AsyncEventBus<MarketStatusChangedEvent>();
  private readonly accountBus = new AsyncEventBus<AccountEvent>();
  private readonly accountStatusBus =
    new AsyncEventBus<AccountStatusChangedEvent>();
  private readonly orderBus = new AsyncEventBus<OrderEvent>();
  private readonly orderStatusBus =
    new AsyncEventBus<OrderStatusChangedEvent>();

  private readonly registeredAccounts = new Map<
    string,
    RegisteredAccountRecord
  >();
  private readonly marketRecords = new Map<string, MarketRecord>();
  private readonly accountRecords = new Map<string, AccountRecord>();
  private readonly orderRecords = new Map<string, OrderRecord>();

  constructor(_options: CreateClientOptions = {}) {
    this.market = new MarketManagerImpl(this);
    this.account = new AccountManagerImpl(this);
    this.order = new OrderManagerImpl(this);
    this.events = new ClientEventStreamsImpl(this.healthBus, this.errorBus);
  }

  getStatus(): ClientStatus {
    return this.status;
  }

  getHealth(): ClientHealthSnapshot {
    return {
      clientStatus: this.status,
      markets: sortByJson(
        [...this.marketRecords.values()].map((record) =>
          cloneMarketStatus(record.status),
        ),
      ),
      accounts: sortByJson(
        [...this.accountRecords.values()].map((record) =>
          cloneAccountStatus(record.status),
        ),
      ),
      orders: sortByJson(
        [...this.orderRecords.values()].map((record) =>
          cloneOrderStatus(record.status),
        ),
      ),
      updatedAt: this.now(),
    };
  }

  async registerAccount(
    input: RegisterAccountInput,
  ): Promise<RegisterAccountResult> {
    if (this.registeredAccounts.has(input.accountId)) {
      throw this.createError(
        "ACCOUNT_ALREADY_EXISTS",
        `Account already exists: ${input.accountId}`,
        { accountId: input.accountId, exchange: input.exchange },
      );
    }

    this.registeredAccounts.set(input.accountId, {
      accountId: input.accountId,
      exchange: input.exchange,
      credentials: input.credentials,
      options: input.options,
    });

    return {
      accountId: input.accountId,
      exchange: input.exchange,
    };
  }

  async updateAccountCredentials(
    accountId: string,
    credentials: AccountCredentials,
  ): Promise<void> {
    const account = this.registeredAccounts.get(accountId);
    if (!account) {
      throw this.createError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
        {
          accountId,
        },
      );
    }

    account.credentials = mergeCredentials(account.credentials, credentials);

    if (this.status !== "running") {
      return;
    }

    const accountRecord = this.accountRecords.get(accountId);
    if (accountRecord?.subscribed) {
      accountRecord.status = this.createAccountStatus(
        accountId,
        account.exchange,
        "active",
      );
      accountRecord.status.ready = Boolean(accountRecord.snapshot);
      accountRecord.status.runtimeStatus = "healthy";
      accountRecord.status.lastReadyAt =
        accountRecord.snapshot?.updatedAt ?? this.now();
      this.publishAccountStatus(accountRecord);
    }

    const orderRecord = this.orderRecords.get(accountId);
    if (orderRecord?.subscribed) {
      orderRecord.status = this.createOrderStatus(
        accountId,
        account.exchange,
        "active",
      );
      orderRecord.status.ready = true;
      orderRecord.status.runtimeStatus = "healthy";
      orderRecord.status.lastReadyAt = this.now();
      this.publishOrderStatus(orderRecord);
    }
  }

  async removeAccount(accountId: string): Promise<void> {
    const account = this.registeredAccounts.get(accountId);
    if (!account) {
      throw this.createError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
        {
          accountId,
        },
      );
    }

    const now = this.now();
    const accountRecord = this.accountRecords.get(accountId);
    if (accountRecord) {
      accountRecord.subscribed = false;
      accountRecord.status = {
        ...accountRecord.status,
        activity: "inactive",
        runtimeStatus: "stopped",
        inactiveSince: now,
      };
      this.publishAccountStatus(accountRecord);
      this.accountRecords.delete(accountId);
    }

    const orderRecord = this.orderRecords.get(accountId);
    if (orderRecord) {
      orderRecord.subscribed = false;
      orderRecord.status = {
        ...orderRecord.status,
        activity: "inactive",
        runtimeStatus: "stopped",
        inactiveSince: now,
      };
      this.publishOrderStatus(orderRecord);
      this.orderRecords.delete(accountId);
    }

    this.registeredAccounts.delete(accountId);
  }

  async start(): Promise<void> {
    if (this.status === "running") {
      return;
    }

    this.setClientStatus("starting");
    this.setClientStatus("running");
    this.reactivateSubscriptions();
  }

  async stop(_options?: StopOptions): Promise<void> {
    if (this.status === "stopped" || this.status === "idle") {
      if (this.status !== "stopped") {
        this.setClientStatus("stopped");
      }
      return;
    }

    this.setClientStatus("stopping");

    const now = this.now();

    for (const record of this.marketRecords.values()) {
      if (!record.l1BookSubscribed && !record.fundingRateSubscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "inactive",
        inactiveSince: now,
      };
      this.publishMarketStatus(record);
    }

    for (const record of this.accountRecords.values()) {
      if (!record.subscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "inactive",
        runtimeStatus: "stopped",
        inactiveSince: now,
      };
      this.publishAccountStatus(record);
    }

    for (const record of this.orderRecords.values()) {
      if (!record.subscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "inactive",
        runtimeStatus: "stopped",
        inactiveSince: now,
      };
      this.publishOrderStatus(record);
    }

    this.setClientStatus("stopped");
  }

  assertStarted(): void {
    if (this.status !== "running") {
      throw this.createError(
        "CLIENT_NOT_STARTED",
        "Client must be started before subscribing to data",
      );
    }
  }

  getOrCreateMarketRecord(input: {
    exchange: Exchange;
    symbol: string;
  }): MarketRecord {
    const key = marketKey(input);
    const existing = this.marketRecords.get(key);
    if (existing) {
      return existing;
    }

    const record: MarketRecord = {
      exchange: input.exchange,
      symbol: input.symbol,
      l1BookSubscribed: false,
      fundingRateSubscribed: false,
      status: {
        exchange: input.exchange,
        symbol: input.symbol,
        activity: "inactive",
        ready: false,
      },
    };

    this.marketRecords.set(key, record);
    return record;
  }

  getMarketRecord(input: {
    exchange: Exchange;
    symbol: string;
  }): MarketRecord | undefined {
    return this.marketRecords.get(marketKey(input));
  }

  getRegisteredAccount(accountId: string): RegisteredAccountRecord {
    const account = this.registeredAccounts.get(accountId);
    if (!account) {
      throw this.createError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
        {
          accountId,
        },
      );
    }

    return account;
  }

  getOrCreateAccountRecord(
    accountId: string,
    exchange: Exchange,
  ): AccountRecord {
    const existing = this.accountRecords.get(accountId);
    if (existing) {
      return existing;
    }

    const record: AccountRecord = {
      accountId,
      exchange,
      subscribed: false,
      status: this.createAccountStatus(accountId, exchange, "inactive"),
    };

    this.accountRecords.set(accountId, record);
    return record;
  }

  getAccountRecord(accountId: string): AccountRecord | undefined {
    return this.accountRecords.get(accountId);
  }

  getOrCreateOrderRecord(accountId: string, exchange: Exchange): OrderRecord {
    const existing = this.orderRecords.get(accountId);
    if (existing) {
      return existing;
    }

    const record: OrderRecord = {
      accountId,
      exchange,
      subscribed: false,
      snapshots: new Map(),
      status: this.createOrderStatus(accountId, exchange, "inactive"),
    };

    this.orderRecords.set(accountId, record);
    return record;
  }

  getOrderRecord(accountId: string): OrderRecord | undefined {
    return this.orderRecords.get(accountId);
  }

  ensurePrivateCredentials(accountId: string): void {
    const account = this.getRegisteredAccount(accountId);
    if (hasPrivateCredentials(account.credentials)) {
      return;
    }

    throw this.createError(
      "CREDENTIALS_MISSING",
      `Account credentials are required for private subscriptions: ${accountId}`,
      {
        accountId,
        exchange: account.exchange,
      },
    );
  }

  createL1Book(exchange: Exchange, symbol: string, previous?: L1Book): L1Book {
    const now = this.now();

    return {
      exchange,
      symbol,
      bidPrice: previous?.bidPrice ?? "0",
      bidSize: previous?.bidSize ?? "0",
      askPrice: previous?.askPrice ?? "0",
      askSize: previous?.askSize ?? "0",
      exchangeTs: now,
      receivedAt: now,
      updatedAt: now,
      version: (previous?.version ?? 0) + 1,
    };
  }

  createFundingRate(
    exchange: Exchange,
    symbol: string,
    previous?: FundingRateSnapshot,
  ): FundingRateSnapshot {
    const now = this.now();

    return {
      exchange,
      symbol,
      fundingRate: previous?.fundingRate ?? "0",
      nextFundingTime: previous?.nextFundingTime,
      markPrice: previous?.markPrice,
      indexPrice: previous?.indexPrice,
      exchangeTs: now,
      receivedAt: now,
      updatedAt: now,
      version: (previous?.version ?? 0) + 1,
    };
  }

  createEmptyAccountSnapshot(
    accountId: string,
    exchange: Exchange,
  ): AccountSnapshot {
    const now = this.now();

    return {
      accountId,
      exchange,
      balances: {},
      positions: [],
      receivedAt: now,
      updatedAt: now,
    };
  }

  createAccountStatus(
    accountId: string,
    exchange: Exchange,
    activity: "active" | "inactive",
  ): AccountDataStatus {
    return {
      accountId,
      exchange,
      activity,
      ready: false,
      runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
    };
  }

  createOrderStatus(
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

  publishMarketEvent(event: MarketEvent): void {
    this.marketBus.publish(event);
  }

  publishMarketStatus(record: MarketRecord): void {
    const event: MarketStatusChangedEvent = {
      type: "market.status_changed",
      exchange: record.exchange,
      symbol: record.symbol,
      status: cloneMarketStatus(record.status),
      ts: this.now(),
    };

    this.marketStatusBus.publish(event);
    this.marketBus.publish(event);
    this.healthBus.publish(event);
  }

  publishAccountEvent(event: AccountEvent): void {
    this.accountBus.publish(event);
  }

  publishAccountStatus(record: AccountRecord): void {
    const event: AccountStatusChangedEvent = {
      type: "account.status_changed",
      accountId: record.accountId,
      exchange: record.exchange,
      status: cloneAccountStatus(record.status),
      ts: this.now(),
    };

    this.accountStatusBus.publish(event);
    this.healthBus.publish(event);
  }

  publishOrderEvent(event: OrderEvent): void {
    this.orderBus.publish(event);
  }

  publishOrderStatus(record: OrderRecord): void {
    const event: OrderStatusChangedEvent = {
      type: "order.status_changed",
      accountId: record.accountId,
      exchange: record.exchange,
      status: cloneOrderStatus(record.status),
      ts: this.now(),
    };

    this.orderStatusBus.publish(event);
    this.healthBus.publish(event);
  }

  marketEvents(): MarketEventStreams {
    return {
      all: (filter) =>
        this.marketBus.stream((event) => matchesMarketFilter(event, filter)),
      fundingRateUpdates: (filter) =>
        this.marketBus.stream(
          (event): event is FundingRateUpdatedEvent =>
            event.type === "funding_rate.updated" &&
            matchesMarketFilter(event, filter),
        ),
      l1BookUpdates: (filter) =>
        this.marketBus.stream(
          (event): event is L1BookUpdatedEvent =>
            event.type === "l1_book.updated" &&
            matchesMarketFilter(event, filter),
        ),
      status: (filter) =>
        this.marketStatusBus.stream((event) =>
          matchesMarketFilter(event, filter),
        ),
    };
  }

  accountEvents(): AccountEventStreams {
    return {
      status: (filter) =>
        this.accountStatusBus.stream((event) =>
          matchesAccountFilter(
            {
              accountId: event.accountId,
              exchange: event.exchange,
            },
            filter,
          ),
        ),
      updates: (filter) =>
        this.accountBus.stream((event) =>
          matchesAccountFilter(
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

  orderEvents(): OrderEventStreams {
    return {
      status: (filter) =>
        this.orderStatusBus.stream((event) =>
          matchesOrderFilter(
            {
              accountId: event.accountId,
              exchange: event.exchange,
            },
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

  now(): number {
    return Date.now();
  }

  private createError(
    code: AcexErrorCode,
    message: string,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): AcexError {
    const error = new AcexError(code, message);
    this.errorBus.publish({
      source: "client",
      ts: this.now(),
      error,
      ...metadata,
    });
    return error;
  }

  private reactivateSubscriptions(): void {
    const now = this.now();

    for (const record of this.marketRecords.values()) {
      if (!record.l1BookSubscribed && !record.fundingRateSubscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "active",
        ready: Boolean(record.l1Book || record.fundingRate),
        freshness: record.status.ready ? "fresh" : undefined,
        lastReadyAt: record.status.lastReadyAt ?? now,
        lastReceivedAt: record.status.lastReceivedAt ?? now,
        inactiveSince: undefined,
      };
      this.publishMarketStatus(record);
    }

    for (const [accountId, record] of this.accountRecords) {
      if (!record.subscribed) {
        continue;
      }

      const account = this.getRegisteredAccount(accountId);
      if (!hasPrivateCredentials(account.credentials)) {
        continue;
      }

      record.snapshot ??= this.createEmptyAccountSnapshot(
        accountId,
        account.exchange,
      );
      record.status = {
        ...this.createAccountStatus(accountId, account.exchange, "active"),
        ready: true,
        runtimeStatus: "healthy",
        lastReceivedAt: now,
        lastReadyAt: record.snapshot.updatedAt,
      };
      this.publishAccountStatus(record);
    }

    for (const [accountId, record] of this.orderRecords) {
      if (!record.subscribed) {
        continue;
      }

      const account = this.getRegisteredAccount(accountId);
      if (!hasPrivateCredentials(account.credentials)) {
        continue;
      }

      record.status = {
        ...this.createOrderStatus(accountId, account.exchange, "active"),
        ready: true,
        runtimeStatus: "healthy",
        lastReceivedAt: now,
        lastReadyAt: now,
      };
      this.publishOrderStatus(record);
    }
  }

  private setClientStatus(status: ClientStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;

    const event: ClientStatusChangedEvent = {
      type: "client.status_changed",
      status,
      ts: this.now(),
    };

    this.healthBus.publish(event);
  }
}
