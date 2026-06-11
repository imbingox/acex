import { BinanceMarketAdapter } from "../adapters/binance/adapter.ts";
import { BinancePrivateAdapter } from "../adapters/binance/private-adapter.ts";
import { JuplendPrivateAdapter } from "../adapters/juplend/private-adapter.ts";
import type {
  CancelAllOrdersRequest,
  CancelOrderRequest,
  CreateOrderRequest,
  MarketAdapter,
  PrivateUserDataAdapter,
  RawOrderUpdate,
} from "../adapters/types.ts";
import {
  AcexError,
  type AcexErrorCode,
  buildAcexErrorDetails,
  type VenueErrorReason,
} from "../errors.ts";
import type { AsyncEventBusOverflowInfo } from "../internal/async-event-bus.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { matchesHealthFilter } from "../internal/filters.ts";
import { ReactiveRateLimiter } from "../internal/rate-limiter.ts";
import { AccountManagerImpl } from "../managers/account-manager.ts";
import { MarketManagerImpl } from "../managers/market-manager.ts";
import { OrderManagerImpl } from "../managers/order-manager.ts";
import type {
  AccountCredentials,
  AccountManager,
  AcexClient,
  AcexInternalError,
  BufferedEventStreamOptions,
  CancelAllOrdersInput,
  CancelOrderInput,
  ClientEventStreams,
  ClientHealthSnapshot,
  ClientStatus,
  ClientStatusChangedEvent,
  CreateClientOptions,
  CreateOrderInput,
  HealthEvent,
  HealthEventFilter,
  MarketManager,
  OrderManager,
  RegisterAccountInput,
  RegisterAccountResult,
  StopOptions,
  Venue,
  VenueCapabilities,
  VenueOrderCapabilities,
} from "../types/index.ts";
import {
  type ClientContext,
  hasPrivateCredentials,
  mergeCredentials,
  type PrivateAccountDataConsumer,
  type PrivateOrderDataConsumer,
  type RegisteredAccountRecord,
} from "./context.ts";
import { PrivateSubscriptionCoordinator } from "./private-subscription-coordinator.ts";
import {
  getVenueCapabilitiesSnapshot,
  listVenueCapabilitiesSnapshots,
} from "./venue-capabilities.ts";

const activeClients = new Set<AcexClientImpl>();

export function stopAllClientsForTests(): void {
  const clients = [...activeClients];
  activeClients.clear();
  for (const client of clients) {
    void client.stop().catch(() => {
      // Test cleanup should be best-effort and never mask the original failure.
    });
  }
}

class ClientEventStreamsImpl implements ClientEventStreams {
  constructor(
    private readonly healthBus: AsyncEventBus<HealthEvent>,
    private readonly errorBus: AsyncEventBus<AcexInternalError>,
    private readonly onHealthOverflow: (
      info: AsyncEventBusOverflowInfo,
    ) => void,
  ) {}

  errors(
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<AcexInternalError> {
    return this.errorBus.stream(() => true, {
      maxBuffer: options?.maxBuffer,
    });
  }

  health(
    filter?: HealthEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<HealthEvent> {
    return this.healthBus.stream(
      (event) => matchesHealthFilter(event, filter),
      {
        maxBuffer: options?.maxBuffer,
        onOverflow: this.onHealthOverflow,
      },
    );
  }
}

export class AcexClientImpl implements AcexClient, ClientContext {
  readonly market: MarketManager;
  readonly account: AccountManager;
  readonly order: OrderManager;
  readonly events: ClientEventStreams;

  private status: ClientStatus = "idle";
  private readonly healthBus = new AsyncEventBus<HealthEvent>();
  private readonly errorBus = new AsyncEventBus<AcexInternalError>();
  private readonly registeredAccounts = new Map<
    string,
    RegisteredAccountRecord
  >();
  private readonly marketManager: MarketManagerImpl;
  private readonly accountManager: AccountManagerImpl;
  private readonly orderManager: OrderManagerImpl;
  private readonly marketAdapters: Map<Venue, MarketAdapter>;
  private readonly privateAdapters: Map<Venue, PrivateUserDataAdapter>;
  private readonly privateCoordinator: PrivateSubscriptionCoordinator;

  constructor(options: CreateClientOptions = {}) {
    activeClients.add(this);

    const rateLimiter = options.rateLimiter ?? new ReactiveRateLimiter();
    const marketAdapter = new BinanceMarketAdapter({ rateLimiter });
    this.marketAdapters = new Map([[marketAdapter.venue, marketAdapter]]);
    const privateAdapters = [
      new BinancePrivateAdapter({
        signingClock: options.clock,
        rateLimiter,
      }),
      new JuplendPrivateAdapter(
        options.account?.juplend?.rpcUrl,
        options.account?.juplend?.jupApiKey,
        {
          pollIntervalMs: options.account?.juplend?.pollIntervalMs,
        },
      ),
    ];
    this.privateAdapters = new Map(
      privateAdapters.map((adapter) => [adapter.venue, adapter]),
    );

    this.marketManager = new MarketManagerImpl(this, this.marketAdapters, {
      initialL1TimeoutMs: options.market?.l1InitialMessageTimeoutMs,
      l1StaleAfterMs: options.market?.l1StaleAfterMs,
      l1ReconnectDelayMs: options.market?.l1ReconnectDelayMs,
      l1ReconnectMaxDelayMs: options.market?.l1ReconnectMaxDelayMs,
    });
    this.accountManager = new AccountManagerImpl(this);
    this.orderManager = new OrderManagerImpl(this, options.order);
    this.privateCoordinator = new PrivateSubscriptionCoordinator(
      this,
      privateAdapters,
      this.accountManager as PrivateAccountDataConsumer,
      this.orderManager as PrivateOrderDataConsumer,
      options.account,
      options.order,
    );

    this.market = this.marketManager;
    this.account = this.accountManager;
    this.order = this.orderManager;
    this.events = new ClientEventStreamsImpl(
      this.healthBus,
      this.errorBus,
      this.createOverflowHandler("client.health"),
    );
  }

  // --- AcexClient public API ---

  getStatus(): ClientStatus {
    return this.status;
  }

  getHealth(): ClientHealthSnapshot {
    return {
      clientStatus: this.status,
      markets: this.marketManager.getStatuses(),
      accounts: this.accountManager.getStatuses(),
      orders: this.orderManager.getStatuses(),
      updatedAt: this.now(),
    };
  }

  getVenueCapabilities(venue: Venue): VenueCapabilities {
    return getVenueCapabilitiesSnapshot(venue, {
      marketAdapters: this.marketAdapters,
      privateAdapters: this.privateAdapters,
    });
  }

  listVenueCapabilities(): VenueCapabilities[] {
    return listVenueCapabilitiesSnapshots({
      marketAdapters: this.marketAdapters,
      privateAdapters: this.privateAdapters,
    });
  }

  async registerAccount(
    input: RegisterAccountInput,
  ): Promise<RegisterAccountResult> {
    if (this.registeredAccounts.has(input.accountId)) {
      throw this.createError(
        "ACCOUNT_ALREADY_EXISTS",
        `Account already exists: ${input.accountId}`,
        { accountId: input.accountId, venue: input.venue },
      );
    }

    this.registeredAccounts.set(input.accountId, {
      accountId: input.accountId,
      venue: input.venue,
      credentials: input.credentials,
      options: input.options as Record<string, unknown> | undefined,
    });

    return {
      accountId: input.accountId,
      venue: input.venue,
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
        { accountId },
      );
    }

    account.credentials = mergeCredentials(account.credentials, credentials);

    if (this.status !== "running") {
      return;
    }

    this.accountManager.onCredentialsUpdated(accountId, account.venue);
    this.orderManager.onCredentialsUpdated(accountId, account.venue);
    this.privateCoordinator.onCredentialsUpdated(accountId);
  }

  async removeAccount(accountId: string): Promise<void> {
    const account = this.registeredAccounts.get(accountId);
    if (!account) {
      throw this.createError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
        { accountId },
      );
    }

    const now = this.now();
    this.privateCoordinator.onAccountRemoved(accountId);
    this.accountManager.onAccountRemoved(accountId, now);
    this.orderManager.onAccountRemoved(accountId, now);
    this.registeredAccounts.delete(accountId);
  }

  async start(): Promise<void> {
    if (this.status === "running") {
      return;
    }

    this.setClientStatus("starting");
    this.setClientStatus("running");

    this.marketManager.onClientStarted();
    this.accountManager.onClientStarted();
    this.orderManager.onClientStarted();
    this.privateCoordinator.onClientStarted();
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
    this.privateCoordinator.onClientStopping();
    this.marketManager.onClientStopping(now);
    this.accountManager.onClientStopping(now);
    this.orderManager.onClientStopping(now);

    this.setClientStatus("stopped");
  }

  // --- ClientContext ---

  now(): number {
    return Date.now();
  }

  assertStarted(): void {
    if (this.status !== "running") {
      throw this.createError(
        "CLIENT_NOT_STARTED",
        "Client must be started before subscribing to data",
      );
    }
  }

  getRegisteredAccount(accountId: string): RegisteredAccountRecord {
    const account = this.registeredAccounts.get(accountId);
    if (!account) {
      throw this.createError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
        { accountId },
      );
    }

    return account;
  }

  getPrivateOrderCapabilities(
    venue: Venue,
  ): VenueOrderCapabilities | undefined {
    return this.privateAdapters.get(venue)?.orderCapabilities;
  }

  normalizeVenueErrorCode(
    venue: Venue,
    code: string,
  ): VenueErrorReason | undefined {
    return this.privateAdapters.get(venue)?.normalizeVenueErrorCode?.(code);
  }

  ensurePrivateCredentials(accountId: string): void {
    const account = this.getRegisteredAccount(accountId);
    if (
      hasPrivateCredentials(
        account.credentials,
        this.getPrivateCredentialsRequired(account.venue),
      )
    ) {
      return;
    }

    throw this.createError(
      "CREDENTIALS_MISSING",
      `Account credentials are required for private subscriptions: ${accountId}`,
      { accountId, venue: account.venue },
    );
  }

  subscribePrivateAccountFeed(accountId: string): Promise<void> {
    return this.privateCoordinator.subscribeAccountFeed(accountId);
  }

  unsubscribePrivateAccountFeed(accountId: string): void {
    this.privateCoordinator.unsubscribeAccountFeed(accountId);
  }

  subscribePrivateOrderFeed(accountId: string): Promise<void> {
    return this.privateCoordinator.subscribeOrderFeed(accountId);
  }

  unsubscribePrivateOrderFeed(accountId: string): void {
    this.privateCoordinator.unsubscribeOrderFeed(accountId);
  }

  createOrder(input: CreateOrderInput): Promise<RawOrderUpdate> {
    const account = this.getPrivateCommandAccount(input.accountId);
    const request: CreateOrderRequest = {
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      amount: input.amount,
      price: input.type === "limit" ? input.price : undefined,
      postOnly: input.type === "limit" ? input.postOnly : undefined,
      clientOrderId: input.clientOrderId,
      reduceOnly: input.reduceOnly,
      positionSide: input.positionSide,
    };

    return this.getPrivateAdapter(account.venue).createOrder(
      account.credentials ?? {},
      request,
      { ...account.options, accountId: account.accountId },
    );
  }

  cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate> {
    const account = this.getPrivateCommandAccount(input.accountId);
    const request: CancelOrderRequest = {
      symbol: input.symbol,
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
    };

    return this.getPrivateAdapter(account.venue).cancelOrder(
      account.credentials ?? {},
      request,
      { ...account.options, accountId: account.accountId },
    );
  }

  cancelAllOrders(input: CancelAllOrdersInput): Promise<RawOrderUpdate[]> {
    const account = this.getPrivateCommandAccount(input.accountId);
    const request: CancelAllOrdersRequest = {
      symbol: input.symbol,
    };

    return this.getPrivateAdapter(account.venue).cancelAllOrders(
      account.credentials ?? {},
      request,
      { ...account.options, accountId: account.accountId },
    );
  }

  publishRuntimeError(
    source: AcexInternalError["source"],
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void {
    this.errorBus.publish({
      source,
      ts: this.now(),
      error,
      ...metadata,
    });
  }

  publishHealthEvent(event: HealthEvent): void {
    this.healthBus.publish(event);
  }

  private createOverflowHandler(
    stream: string,
  ): (info: AsyncEventBusOverflowInfo) => void {
    return ({ maxBuffer }) => {
      const error = new AcexError(
        "EVENT_BUFFER_OVERFLOW",
        `Event stream buffer overflow: ${stream}`,
      );
      this.publishRuntimeError("runtime", error, {
        stream,
        maxBuffer,
      });
    };
  }

  // --- Private ---

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

  private createError(
    code: AcexErrorCode,
    message: string,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): AcexError {
    const error = new AcexError(code, message, {
      details: buildAcexErrorDetails(metadata),
    });
    this.errorBus.publish({
      source: "client",
      ts: this.now(),
      error,
      ...metadata,
    });
    return error;
  }

  private getPrivateCommandAccount(accountId: string): RegisteredAccountRecord {
    const account = this.getRegisteredAccount(accountId);
    const adapter = this.getPrivateAdapter(account.venue);
    if (!adapter.orderCapabilities.supported) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue does not support private order commands: ${account.venue}`,
        { accountId, venue: account.venue },
      );
    }

    if (
      !hasPrivateCredentials(
        account.credentials,
        adapter.accountCapabilities.credentialsRequired,
      )
    ) {
      throw this.createError(
        "CREDENTIALS_MISSING",
        `Account credentials are required for private order commands: ${accountId}`,
        { accountId, venue: account.venue },
      );
    }

    return account;
  }

  private getPrivateCredentialsRequired(venue: Venue): boolean {
    return (
      this.privateAdapters.get(venue)?.accountCapabilities
        .credentialsRequired ?? true
    );
  }

  private getPrivateAdapter(venue: Venue): PrivateUserDataAdapter {
    const adapter = this.privateAdapters.get(venue);
    if (!adapter) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue is not supported yet: ${venue}`,
        { venue },
      );
    }

    return adapter;
  }
}
