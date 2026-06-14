import { BinanceMarketAdapter } from "../adapters/binance/adapter.ts";
import { BinanceMarketCatalog } from "../adapters/binance/market-catalog.ts";
import { BinancePrivateAdapter } from "../adapters/binance/private-adapter.ts";
import { fetchBinanceServerTime } from "../adapters/binance/server-time.ts";
import { JuplendPrivateAdapter } from "../adapters/juplend/private-adapter.ts";
import type {
  CancelAllOrdersRequest,
  CancelOrderRequest,
  CreateOrderRequest,
  FetchSymbolFeeRateRequest,
  MarketAdapter,
  PrivateUserDataAdapter,
  RawOrderUpdate,
  RawSymbolFeeRate,
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
import { SyncingTimeProvider } from "../internal/syncing-time-provider.ts";
import { AccountManagerImpl } from "../managers/account-manager.ts";
import { FeeManagerImpl } from "../managers/fee-manager.ts";
import { MarketManagerImpl } from "../managers/market-manager.ts";
import { OrderManagerImpl } from "../managers/order-manager.ts";
import {
  type AccountCredentials,
  type AccountManager,
  type AccountRuntimeOptions,
  type AcexClient,
  type AcexInternalError,
  type BinanceMarketRuntimeOptions,
  type BufferedEventStreamOptions,
  type CancelAllOrdersInput,
  type CancelOrderInput,
  type ClientEventStreams,
  type ClientHealthSnapshot,
  type ClientStatus,
  type ClientStatusChangedEvent,
  type CreateClientOptions,
  type CreateOrderInput,
  type FeeManager,
  type GetSymbolFeeRateInput,
  type HealthEvent,
  type HealthEventFilter,
  type JuplendAccountRuntimeOptions,
  type MarketDefinition,
  type MarketManager,
  METRIC_NAMES,
  type MetricType,
  type OnMetric,
  type OrderManager,
  type RateLimiter,
  type RegisterAccountInput,
  type RegisterAccountResult,
  type StopOptions,
  type TimeProvider,
  type Venue,
  type VenueCapabilities,
  type VenueOrderCapabilities,
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

interface VenueAdapterLifecycle {
  start(): Promise<void> | void;
  stop(): void;
}

type AccountVenueRuntimeOptionsMap = NonNullable<
  AccountRuntimeOptions["venues"]
>;
type MarketVenueRuntimeOptionsMap = NonNullable<
  NonNullable<CreateClientOptions["market"]>["venues"]
>;

interface VenueAdapterFactoryDeps {
  readonly rateLimiter: RateLimiter;
  readonly signingClock?: TimeProvider;
  readonly emitMetric: (
    name: string,
    value: number,
    type: MetricType,
    tags?: Record<string, string>,
  ) => void;
  readonly publishRuntimeError: (
    source: AcexInternalError["source"],
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ) => void;
}

interface VenueAdapterFactoryResult {
  readonly marketAdapter?: MarketAdapter;
  readonly privateAdapter?: PrivateUserDataAdapter;
  readonly lifecycle?: VenueAdapterLifecycle;
}

// Per-venue factories receive their own statically typed options slice, so a
// renamed venue option fails type-check here instead of silently reading a
// dead key at runtime. Adding a venue = one factory + one entry in
// createVenueAdapterGroups.
function createVenueAdapterGroups(
  deps: VenueAdapterFactoryDeps,
  marketOptions: MarketVenueRuntimeOptionsMap | undefined,
  venueOptions: AccountVenueRuntimeOptionsMap | undefined,
): VenueAdapterFactoryResult[] {
  return [
    createBinanceAdapterGroup(deps, marketOptions?.binance),
    createJuplendAdapterGroup(deps, venueOptions?.juplend),
  ];
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(fallback, { cause: value });
}

async function raceWithTimeout(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function createBinanceAdapterGroup(
  deps: VenueAdapterFactoryDeps,
  marketOptions: BinanceMarketRuntimeOptions | undefined,
): VenueAdapterFactoryResult {
  const marketCatalog = new BinanceMarketCatalog({
    rateLimiter: deps.rateLimiter,
    publishRuntimeError: deps.publishRuntimeError,
  });
  const signingTimeProvider = deps.signingClock
    ? undefined
    : new SyncingTimeProvider({
        sample: () => fetchBinanceServerTime({ rateLimiter: deps.rateLimiter }),
        onSampleFailed: (event) => {
          deps.publishRuntimeError(
            "runtime",
            toError(
              event.error,
              `Binance signing clock ${event.reason} sample failed`,
            ),
            { venue: "binance" },
          );
        },
        onDriftWarning: (event) => {
          deps.publishRuntimeError(
            "runtime",
            new Error(
              `Binance signing clock drift exceeded threshold: drift=${event.driftMs}ms threshold=${event.thresholdMs}ms`,
            ),
            { venue: "binance" },
          );
        },
      });
  const signingClock = deps.signingClock ?? signingTimeProvider;

  return {
    marketAdapter: new BinanceMarketAdapter({
      rateLimiter: deps.rateLimiter,
      marketCatalog,
      emitMetric: deps.emitMetric,
      marketDataApiKey:
        marketOptions?.apiKey ?? process.env.BINANCE_MARKET_API_KEY,
    }),
    privateAdapter: new BinancePrivateAdapter({
      signingClock,
      rateLimiter: deps.rateLimiter,
      marketCatalog,
    }),
    lifecycle: signingTimeProvider
      ? {
          start: () => signingTimeProvider.start(),
          stop: () => signingTimeProvider.stop(),
        }
      : undefined,
  };
}

function createJuplendAdapterGroup(
  _deps: VenueAdapterFactoryDeps,
  venueOptions: JuplendAccountRuntimeOptions | undefined,
): VenueAdapterFactoryResult {
  return {
    privateAdapter: new JuplendPrivateAdapter(
      venueOptions?.rpcUrl,
      venueOptions?.jupApiKey,
      {
        pollIntervalMs: venueOptions?.pollIntervalMs,
      },
    ),
  };
}

export async function stopAllClientsForTests(): Promise<void> {
  const clients = [...activeClients];
  activeClients.clear();
  await Promise.allSettled(
    clients.map((client) => client.stop({ graceful: false })),
  );
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
  readonly fee: FeeManager;
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
  private readonly feeManager: FeeManagerImpl;
  private readonly marketAdapters: Map<Venue, MarketAdapter>;
  private readonly privateAdapters: Map<Venue, PrivateUserDataAdapter>;
  private readonly privateCoordinator: PrivateSubscriptionCoordinator;
  private readonly adapterLifecycles: VenueAdapterLifecycle[];
  private readonly inFlightOrderCommands = new Set<Promise<unknown>>();
  private readonly onMetric: OnMetric | undefined;

  constructor(options: CreateClientOptions = {}) {
    activeClients.add(this);
    this.onMetric = options.onMetric;

    const rateLimiter =
      options.rateLimiter ??
      new ReactiveRateLimiter({
        utilizationTarget: options.rateLimit?.utilizationTarget,
      });
    const adapterGroups = createVenueAdapterGroups(
      {
        rateLimiter,
        signingClock: options.clock,
        emitMetric: this.emitMetric.bind(this),
        publishRuntimeError: this.publishRuntimeError.bind(this),
      },
      options.market?.venues,
      options.account?.venues,
    );
    this.adapterLifecycles = adapterGroups.flatMap((group) =>
      group.lifecycle ? [group.lifecycle] : [],
    );
    this.marketAdapters = new Map(
      adapterGroups.flatMap((group) =>
        group.marketAdapter
          ? [[group.marketAdapter.venue, group.marketAdapter]]
          : [],
      ),
    );
    const privateAdapters = adapterGroups.flatMap((group) =>
      group.privateAdapter ? [group.privateAdapter] : [],
    );
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
    this.feeManager = new FeeManagerImpl(this, options.fee);
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
    this.fee = this.feeManager;
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
    this.feeManager.onCredentialsUpdated(accountId, account.venue);

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
    this.feeManager.onAccountRemoved(accountId, now);
    this.registeredAccounts.delete(accountId);
  }

  async start(): Promise<void> {
    if (this.status === "running") {
      return;
    }

    activeClients.add(this);
    this.setClientStatus("starting");
    for (const lifecycle of this.adapterLifecycles) {
      void lifecycle.start();
    }
    this.setClientStatus("running");

    this.marketManager.onClientStarted();
    this.accountManager.onClientStarted();
    this.orderManager.onClientStarted();
    this.feeManager.onClientStarted();
    this.privateCoordinator.onClientStarted();
  }

  async stop(options: StopOptions = {}): Promise<void> {
    try {
      if (this.status === "stopped" || this.status === "idle") {
        if (this.status !== "stopped") {
          this.setClientStatus("stopped");
        }
        return;
      }

      this.setClientStatus("stopping");

      if (options.graceful ?? true) {
        await this.drainInFlightStop(options.timeoutMs ?? 5_000);
      }

      const now = this.now();
      for (const lifecycle of this.adapterLifecycles) {
        lifecycle.stop();
      }
      this.privateCoordinator.onClientStopping();
      this.marketManager.onClientStopping(now);
      this.accountManager.onClientStopping(now);
      this.orderManager.onClientStopping(now);
      this.feeManager.onClientStopping(now);

      this.setClientStatus("stopped");
    } finally {
      activeClients.delete(this);
    }
  }

  // --- ClientContext ---

  get metricsEnabled(): boolean {
    return this.onMetric !== undefined;
  }

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

  getMarketDefinition(
    venue: Venue,
    symbol: string,
  ): MarketDefinition | undefined {
    return this.marketManager.getMarket(venue, symbol);
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
    this.assertStarted();
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

    return this.trackOrderCommand(
      this.getPrivateAdapter(account.venue).createOrder(
        account.credentials ?? {},
        request,
        { ...account.options, accountId: account.accountId },
      ),
    );
  }

  cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate> {
    this.assertStarted();
    const account = this.getPrivateCommandAccount(input.accountId);
    const request: CancelOrderRequest = {
      symbol: input.symbol,
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
    };

    return this.trackOrderCommand(
      this.getPrivateAdapter(account.venue).cancelOrder(
        account.credentials ?? {},
        request,
        { ...account.options, accountId: account.accountId },
      ),
    );
  }

  cancelAllOrders(input: CancelAllOrdersInput): Promise<RawOrderUpdate[]> {
    this.assertStarted();
    const account = this.getPrivateCommandAccount(input.accountId);
    const request: CancelAllOrdersRequest = {
      symbol: input.symbol,
    };

    return this.trackOrderCommand(
      this.getPrivateAdapter(account.venue).cancelAllOrders(
        account.credentials ?? {},
        request,
        { ...account.options, accountId: account.accountId },
      ),
    );
  }

  fetchSymbolFeeRate(input: GetSymbolFeeRateInput): Promise<RawSymbolFeeRate> {
    this.assertStarted();
    const account = this.getRegisteredAccount(input.accountId);
    const adapter = this.getPrivateAdapter(account.venue);
    if (
      adapter.orderCapabilities.fees === "unsupported" ||
      !adapter.fetchSymbolFeeRate
    ) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue does not support symbol fee rate queries: ${account.venue}`,
        {
          accountId: input.accountId,
          venue: account.venue,
          symbol: input.symbol,
        },
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
        `Account credentials are required for symbol fee rate queries: ${input.accountId}`,
        {
          accountId: input.accountId,
          venue: account.venue,
          symbol: input.symbol,
        },
      );
    }

    const request: FetchSymbolFeeRateRequest = {
      symbol: input.symbol,
    };

    return adapter.fetchSymbolFeeRate(account.credentials ?? {}, request, {
      ...account.options,
      accountId: account.accountId,
    });
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

  emitMetric(
    name: string,
    value: number,
    type: MetricType,
    tags?: Record<string, string>,
  ): void {
    const onMetric = this.onMetric;
    if (!onMetric) {
      return;
    }

    try {
      onMetric(name, value, type, tags);
    } catch {
      // Observability callbacks must not break client workflows.
    }
  }

  private createOverflowHandler(
    stream: string,
  ): (info: AsyncEventBusOverflowInfo) => void {
    return ({ maxBuffer }) => {
      this.emitMetric(METRIC_NAMES.eventBufferOverflow, 1, "counter", {
        stream,
      });
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

  private trackOrderCommand<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      this.inFlightOrderCommands.delete(tracked);
    });
    this.inFlightOrderCommands.add(tracked);
    return tracked;
  }

  private async drainInFlightStop(timeoutMs: number): Promise<void> {
    const inFlight = [
      ...this.inFlightOrderCommands,
      ...this.privateCoordinator.getInFlightOperations(),
    ];
    if (inFlight.length === 0) {
      return;
    }

    await raceWithTimeout(Promise.allSettled(inFlight), timeoutMs);
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
