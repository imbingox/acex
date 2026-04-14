import type {
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawL1BookUpdate,
  StreamHandle,
} from "../adapters/types.ts";
import type {
  ClientContext,
  HealthReporter,
  ManagerLifecycle,
} from "../client/context.ts";
import { AcexError } from "../errors.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { matchesMarketFilter } from "../internal/filters.ts";
import type {
  Exchange,
  FundingRateSnapshot,
  FundingRateUpdatedEvent,
  L1Book,
  L1BookUpdatedEvent,
  MarketDataStatus,
  MarketDefinition,
  MarketEvent,
  MarketEventStreams,
  MarketKeyInput,
  MarketManager,
  MarketStatusChangedEvent,
  SubscribeFundingRateInput,
  SubscribeL1BookInput,
} from "../types/index.ts";

export interface MarketManagerOptions {
  initialL1TimeoutMs?: number;
  l1StaleAfterMs?: number;
  l1ReconnectDelayMs?: number;
  l1ReconnectMaxDelayMs?: number;
}

interface MarketRecord {
  exchange: Exchange;
  symbol: string;
  market?: MarketDefinition;
  l1Book?: L1Book;
  fundingRate?: FundingRateSnapshot;
  l1BookSubscribed: boolean;
  fundingRateSubscribed: boolean;
  status: MarketDataStatus;
  l1BookStream?: StreamHandle;
}

const DEFAULT_INITIAL_L1_TIMEOUT_MS = 15_000;
const DEFAULT_L1_STALE_AFTER_MS = 15_000;
const DEFAULT_L1_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_L1_RECONNECT_MAX_DELAY_MS = 10_000;

function marketKey(input: MarketKeyInput): string {
  return `${input.exchange}:${input.symbol}`;
}

function cloneMarketStatus(status: MarketDataStatus): MarketDataStatus {
  return { ...status };
}

function cloneMarketDefinition(definition: MarketDefinition): MarketDefinition {
  return { ...definition, raw: { ...definition.raw } };
}

export class MarketManagerImpl
  implements MarketManager, ManagerLifecycle, HealthReporter<MarketDataStatus>
{
  readonly events: MarketEventStreams;

  private readonly context: ClientContext;
  private readonly adapter: MarketAdapter;
  private readonly marketBus = new AsyncEventBus<MarketEvent>();
  private readonly marketStatusBus =
    new AsyncEventBus<MarketStatusChangedEvent>();
  private readonly definitions = new Map<string, MarketDefinition>();
  private readonly records = new Map<string, MarketRecord>();
  private catalogPromise: Promise<void> | undefined;
  private readonly initialL1TimeoutMs: number;
  private readonly l1StaleAfterMs: number;
  private readonly l1ReconnectDelayMs: number;
  private readonly l1ReconnectMaxDelayMs: number;

  constructor(
    context: ClientContext,
    adapter: MarketAdapter,
    options: MarketManagerOptions = {},
  ) {
    this.context = context;
    this.adapter = adapter;
    this.initialL1TimeoutMs =
      options.initialL1TimeoutMs ?? DEFAULT_INITIAL_L1_TIMEOUT_MS;
    this.l1StaleAfterMs = options.l1StaleAfterMs ?? DEFAULT_L1_STALE_AFTER_MS;
    this.l1ReconnectDelayMs =
      options.l1ReconnectDelayMs ?? DEFAULT_L1_RECONNECT_DELAY_MS;
    this.l1ReconnectMaxDelayMs =
      options.l1ReconnectMaxDelayMs ?? DEFAULT_L1_RECONNECT_MAX_DELAY_MS;

    this.events = {
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

  // --- MarketManager public API ---

  async loadMarkets(): Promise<void> {
    await this.loadMarketCatalog();
  }

  async subscribeL1Book(input: SubscribeL1BookInput): Promise<void> {
    this.context.assertStarted();
    const market = await this.resolveMarketDefinition(input);
    const record = this.getOrCreateRecord({
      exchange: input.exchange,
      symbol: market.symbol,
    });

    record.market = market;
    record.l1BookSubscribed = true;
    record.status = {
      ...record.status,
      activity: "active",
      ready: Boolean(record.l1Book),
      freshness: record.l1Book ? "stale" : undefined,
      reason: undefined,
      inactiveSince: undefined,
    };
    this.publishStatus(record);

    await this.ensureL1BookStream(record, market);
  }

  async unsubscribeL1Book(input: SubscribeL1BookInput): Promise<void> {
    const record = this.records.get(marketKey(input));
    if (!record?.l1BookSubscribed) {
      return;
    }

    record.l1BookStream?.close();
    record.l1BookStream = undefined;
    record.l1BookSubscribed = false;
    this.updateActivity(record);
  }

  async subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void> {
    this.context.assertStarted();
    const record = this.getOrCreateRecord(input);
    const fundingRate =
      record.fundingRate ??
      this.createFundingRate(input.exchange, input.symbol, record.fundingRate);

    if (!record.fundingRateSubscribed) {
      record.fundingRateSubscribed = true;
      record.fundingRate = fundingRate;
    }

    record.status = {
      ...record.status,
      activity: "active",
      ready: true,
      freshness: "fresh",
      lastReceivedAt: fundingRate.receivedAt,
      lastReadyAt: fundingRate.updatedAt,
      inactiveSince: undefined,
    };

    const event: FundingRateUpdatedEvent = {
      type: "funding_rate.updated",
      exchange: record.exchange,
      symbol: record.symbol,
      snapshot: fundingRate,
      ts: this.context.now(),
    };

    this.publishMarketEvent(event);
    this.publishStatus(record);
  }

  async unsubscribeFundingRate(
    input: SubscribeFundingRateInput,
  ): Promise<void> {
    const record = this.records.get(marketKey(input));
    if (!record?.fundingRateSubscribed) {
      return;
    }

    record.fundingRateSubscribed = false;
    this.updateActivity(record);
  }

  getMarket(symbol: string): MarketDefinition | undefined {
    const market = this.definitions.get(symbol);
    return market ? cloneMarketDefinition(market) : undefined;
  }

  listMarkets(): MarketDefinition[] {
    return [...this.definitions.values()]
      .sort((left, right) => left.symbol.localeCompare(right.symbol))
      .map((market) => cloneMarketDefinition(market));
  }

  getL1Book(key: MarketKeyInput): L1Book | undefined {
    return this.records.get(marketKey(key))?.l1Book;
  }

  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined {
    return this.records.get(marketKey(key))?.fundingRate;
  }

  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined {
    const status = this.records.get(marketKey(key))?.status;
    return status ? cloneMarketStatus(status) : undefined;
  }

  // --- ManagerLifecycle ---

  onClientStarted(): void {
    const now = this.context.now();

    for (const record of this.records.values()) {
      if (!record.l1BookSubscribed && !record.fundingRateSubscribed) {
        continue;
      }

      record.status = {
        ...record.status,
        activity: "active",
        ready: Boolean(record.l1Book || record.fundingRate),
        freshness: record.l1Book
          ? "stale"
          : record.status.ready
            ? "fresh"
            : undefined,
        reason: undefined,
        lastReadyAt: record.status.lastReadyAt ?? now,
        lastReceivedAt: record.status.lastReceivedAt ?? now,
        inactiveSince: undefined,
      };
      this.publishStatus(record);
    }

    void this.resumeStreams();
  }

  onClientStopping(now: number): void {
    for (const record of this.records.values()) {
      if (!record.l1BookSubscribed && !record.fundingRateSubscribed) {
        continue;
      }

      record.l1BookStream?.close();
      record.l1BookStream = undefined;

      record.status = {
        ...record.status,
        activity: "inactive",
        inactiveSince: now,
        freshness: record.l1Book ? "stale" : undefined,
      };
      this.publishStatus(record);
    }
  }

  // --- HealthReporter ---

  getStatuses(): MarketDataStatus[] {
    return [...this.records.values()]
      .map((record) => cloneMarketStatus(record.status))
      .sort((left, right) =>
        `${left.exchange}:${left.symbol}`.localeCompare(
          `${right.exchange}:${right.symbol}`,
        ),
      );
  }

  // --- Internal helpers ---

  private async loadMarketCatalog(): Promise<void> {
    if (this.definitions.size > 0) {
      return;
    }

    if (!this.catalogPromise) {
      this.catalogPromise = this.fetchAndStoreMarketCatalog();
    }

    try {
      await this.catalogPromise;
    } finally {
      if (this.definitions.size === 0) {
        this.catalogPromise = undefined;
      }
    }
  }

  private async fetchAndStoreMarketCatalog(): Promise<void> {
    try {
      const markets = await this.adapter.loadMarkets();
      this.definitions.clear();

      for (const market of markets) {
        this.definitions.set(market.symbol, market);
      }
    } catch (error) {
      const wrapped = new AcexError(
        "MARKET_CATALOG_LOAD_FAILED",
        "Failed to load market catalog from Binance",
      );
      this.context.publishRuntimeError(
        "adapter",
        error instanceof Error
          ? error
          : new Error("Unknown catalog load failure"),
        { exchange: this.adapter.exchange },
      );
      throw wrapped;
    }
  }

  private async resolveMarketDefinition(input: {
    exchange: Exchange;
    symbol: string;
  }): Promise<MarketDefinition> {
    this.assertSupportedExchange(input.exchange);
    await this.loadMarketCatalog();

    const market = this.definitions.get(input.symbol);
    if (!market) {
      throw this.createError(
        "MARKET_NOT_FOUND",
        `Unknown market symbol: ${input.symbol}`,
        { exchange: input.exchange, symbol: input.symbol },
        "market",
      );
    }

    if (!market.active) {
      throw this.createError(
        "MARKET_INACTIVE",
        `Inactive market symbol: ${input.symbol}`,
        { exchange: input.exchange, symbol: input.symbol },
        "market",
      );
    }

    return market;
  }

  private assertSupportedExchange(exchange: Exchange): void {
    if (exchange === this.adapter.exchange) {
      return;
    }

    throw this.createError(
      "EXCHANGE_NOT_SUPPORTED",
      `Exchange is not supported yet: ${exchange}`,
      { exchange },
      "client",
    );
  }

  private getOrCreateRecord(input: {
    exchange: Exchange;
    symbol: string;
  }): MarketRecord {
    const key = marketKey(input);
    const existing = this.records.get(key);
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

    this.records.set(key, record);
    return record;
  }

  private async ensureL1BookStream(
    record: MarketRecord,
    market: MarketDefinition,
  ): Promise<void> {
    if (record.l1BookStream) {
      await record.l1BookStream.ready;
      return;
    }

    record.l1BookStream = this.createL1BookStream(record, market);

    try {
      await record.l1BookStream.ready;
    } catch {
      record.l1BookStream = undefined;
      const timeoutError = new AcexError(
        "MARKET_STREAM_TIMEOUT",
        `Timed out waiting for market data: ${market.symbol}`,
      );
      this.context.publishRuntimeError("runtime", timeoutError, {
        exchange: market.exchange,
        symbol: market.symbol,
      });
      this.updateConnectionState(
        record,
        "stale",
        "ws_disconnected",
        Boolean(record.l1Book),
      );
      throw timeoutError;
    }
  }

  private createL1BookStream(
    record: MarketRecord,
    market: MarketDefinition,
  ): StreamHandle {
    const callbacks: L1BookStreamCallbacks = {
      onUpdate: (update: RawL1BookUpdate) => {
        record.l1Book = this.createL1Book(
          record.exchange,
          record.symbol,
          update,
          record.l1Book,
        );
        record.status = {
          ...record.status,
          activity: "active",
          ready: true,
          freshness: "fresh",
          reason: undefined,
          lastReceivedAt: record.l1Book.receivedAt,
          lastReadyAt: record.l1Book.updatedAt,
          inactiveSince: undefined,
        };

        const event: L1BookUpdatedEvent = {
          type: "l1_book.updated",
          exchange: record.exchange,
          symbol: record.symbol,
          snapshot: record.l1Book,
          ts: this.context.now(),
        };

        this.publishMarketEvent(event);
        this.publishStatus(record);
      },
      onFreshnessChange: (freshness, reason) => {
        this.updateConnectionState(
          record,
          freshness,
          reason,
          Boolean(record.l1Book),
        );
      },
      onDisconnected: () => {
        this.updateConnectionState(
          record,
          "stale",
          "ws_disconnected",
          Boolean(record.l1Book),
        );
      },
      onError: (error) => {
        this.context.publishRuntimeError("runtime", error, {
          exchange: record.exchange,
          symbol: record.symbol,
        });
      },
    };

    const options: L1BookStreamOptions = {
      initialMessageTimeoutMs: this.initialL1TimeoutMs,
      staleAfterMs: this.l1StaleAfterMs,
      reconnectDelayMs: this.l1ReconnectDelayMs,
      reconnectMaxDelayMs: this.l1ReconnectMaxDelayMs,
      now: () => this.context.now(),
    };

    return this.adapter.createL1BookStream(market, callbacks, options);
  }

  private createL1Book(
    exchange: Exchange,
    symbol: string,
    input: RawL1BookUpdate,
    previous?: L1Book,
  ): L1Book {
    return {
      exchange,
      symbol,
      bidPrice: input.bidPrice,
      bidSize: input.bidSize,
      askPrice: input.askPrice,
      askSize: input.askSize,
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      version: (previous?.version ?? 0) + 1,
    };
  }

  private createFundingRate(
    exchange: Exchange,
    symbol: string,
    previous?: FundingRateSnapshot,
  ): FundingRateSnapshot {
    const now = this.context.now();

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

  private updateConnectionState(
    record: MarketRecord,
    freshness: "fresh" | "stale",
    reason: MarketDataStatus["reason"],
    ready: boolean,
  ): void {
    record.status = {
      ...record.status,
      activity: "active",
      ready,
      freshness,
      reason,
      inactiveSince: undefined,
    };
    this.publishStatus(record);
  }

  private updateActivity(record: MarketRecord): void {
    if (record.l1BookSubscribed || record.fundingRateSubscribed) {
      record.status = {
        ...record.status,
        activity: "active",
        inactiveSince: undefined,
      };
    } else {
      record.status = {
        ...record.status,
        activity: "inactive",
        inactiveSince: this.context.now(),
      };
    }

    this.publishStatus(record);
  }

  private publishMarketEvent(event: MarketEvent): void {
    this.marketBus.publish(event);
  }

  private publishStatus(record: MarketRecord): void {
    const event: MarketStatusChangedEvent = {
      type: "market.status_changed",
      exchange: record.exchange,
      symbol: record.symbol,
      status: cloneMarketStatus(record.status),
      ts: this.context.now(),
    };

    this.marketStatusBus.publish(event);
    this.marketBus.publish(event);
    this.context.publishHealthEvent(event);
  }

  private async resumeStreams(): Promise<void> {
    for (const record of this.records.values()) {
      if (!record.l1BookSubscribed || record.l1BookStream) {
        continue;
      }

      const market = record.market;
      if (!market) {
        continue;
      }

      try {
        record.status = {
          ...record.status,
          activity: "active",
          freshness: record.l1Book ? "stale" : undefined,
          reason: undefined,
          inactiveSince: undefined,
        };
        this.publishStatus(record);
        await this.ensureL1BookStream(record, market);
      } catch {
        // Errors are already published through the runtime error bus.
      }
    }
  }

  private createError(
    code: "MARKET_NOT_FOUND" | "MARKET_INACTIVE" | "EXCHANGE_NOT_SUPPORTED",
    message: string,
    metadata?: { exchange?: Exchange; symbol?: string },
    source: "market" | "client" = "market",
  ): AcexError {
    const error = new AcexError(code, message);
    this.context.publishRuntimeError(source, error, metadata);
    return error;
  }
}
