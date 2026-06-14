import BigNumber from "bignumber.js";
import type {
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawFundingRateHistoryEntry,
  RawFundingRateUpdate,
  RawL1BookUpdate,
  RawPublicTrade,
  StreamHandle,
} from "../adapters/types.ts";
import type {
  ClientContext,
  HealthReporter,
  ManagerLifecycle,
} from "../client/context.ts";
import {
  AcexError,
  buildAcexErrorDetails,
  formatAcexErrorMessage,
} from "../errors.ts";
import type {
  AsyncEventBusOverflowInfo,
  AsyncEventBusStreamOptions,
} from "../internal/async-event-bus.ts";
import { AsyncEventBus } from "../internal/async-event-bus.ts";
import { toCanonical } from "../internal/decimal.ts";
import { matchesMarketFilter } from "../internal/filters.ts";
import type {
  EventStreamOptions,
  FetchFundingRateHistoryInput,
  FetchFundingRateHistoryResult,
  FetchPublicRawTradesInput,
  FetchPublicRawTradesResult,
  FetchPublicTradesInput,
  FetchPublicTradesResult,
  FundingRateHistoryEntry,
  FundingRateSnapshot,
  FundingRateUpdatedEvent,
  L1Book,
  L1BookUpdatedEvent,
  MarketCatalogReloadSummary,
  MarketDataStatus,
  MarketDataStreamStatus,
  MarketDefinition,
  MarketEvent,
  MarketEventStreams,
  MarketKeyInput,
  MarketManager,
  MarketStatusChangedEvent,
  NormalizedOrderInput,
  NormalizeOrderInputInput,
  PublicTrade,
  SubscribeFundingRateInput,
  SubscribeL1BookInput,
  SubscriptionActivity,
  Venue,
  VenueServerTime,
} from "../types/index.ts";
import { METRIC_NAMES } from "../types/index.ts";

export interface MarketManagerOptions {
  initialL1TimeoutMs?: number;
  l1StaleAfterMs?: number;
  l1ReconnectDelayMs?: number;
  l1ReconnectMaxDelayMs?: number;
}

interface MarketRecord {
  venue: Venue;
  symbol: string;
  market?: MarketDefinition;
  l1Book?: L1Book;
  fundingRate?: FundingRateSnapshot;
  l1BookSubscribed: boolean;
  fundingRateSubscribed: boolean;
  l1Freshness?: "fresh" | "stale";
  l1Reason?: MarketDataStatus["reason"];
  fundingRateFreshness?: "fresh" | "stale";
  fundingRateReason?: MarketDataStatus["reason"];
  status: MarketDataStatus;
  l1BookStream?: StreamHandle;
  fundingRateStream?: StreamHandle;
  lastPublishedStatusKey?: MarketStatusPublicationKey;
}

interface MarketStatusPublicationKey {
  activity: MarketDataStatus["activity"];
  ready: MarketDataStatus["ready"];
  freshness: MarketDataStatus["freshness"];
  reason: MarketDataStatus["reason"];
}

interface CatalogFetchResult {
  venue: Venue;
  added: string[];
  removed: string[];
  total: number;
}

const DEFAULT_INITIAL_L1_TIMEOUT_MS = 15_000;
const DEFAULT_L1_STALE_AFTER_MS = 15_000;
const DEFAULT_L1_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_L1_RECONNECT_MAX_DELAY_MS = 10_000;
const MAX_FUNDING_RATE_HISTORY_LIMIT = 1_000;

function marketKey(input: MarketKeyInput): string {
  return `${input.venue}:${input.symbol}`;
}

function marketEventConflateKey(event: MarketEvent): string {
  return `${event.type}:${marketKey(event)}`;
}

function freezeMarketStatus(status: MarketDataStatus): MarketDataStatus {
  return Object.freeze({ ...status });
}

function statusPublicationKey(
  status: MarketDataStatus,
): MarketStatusPublicationKey {
  return {
    activity: status.activity,
    ready: status.ready,
    freshness: status.freshness,
    reason: status.reason,
  };
}

function sameStatusPublicationKey(
  current: MarketStatusPublicationKey,
  previous: MarketStatusPublicationKey | undefined,
): boolean {
  return (
    previous !== undefined &&
    current.activity === previous.activity &&
    current.ready === previous.ready &&
    current.freshness === previous.freshness &&
    current.reason === previous.reason
  );
}

function freezeStreamStatus(
  status: MarketDataStreamStatus,
): MarketDataStreamStatus {
  return Object.freeze({ ...status });
}

function freezeL1Book(book: L1Book): L1Book {
  return Object.freeze(book);
}

function freezeFundingRate(snapshot: FundingRateSnapshot): FundingRateSnapshot {
  return Object.freeze(snapshot);
}

function isTimestampMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function cloneMarketDefinition(definition: MarketDefinition): MarketDefinition {
  return { ...definition, raw: { ...definition.raw } };
}

function floorToStep(value: BigNumber, step: BigNumber): BigNumber {
  if (step.isLessThanOrEqualTo(0)) {
    return value;
  }
  return value.dividedToIntegerBy(step).multipliedBy(step);
}

export class MarketManagerImpl
  implements MarketManager, ManagerLifecycle, HealthReporter<MarketDataStatus>
{
  readonly events: MarketEventStreams;

  private readonly context: ClientContext;
  private readonly adapters: Map<Venue, MarketAdapter>;
  private readonly marketBus = new AsyncEventBus<MarketEvent>();
  private readonly marketStatusBus =
    new AsyncEventBus<MarketStatusChangedEvent>();
  private readonly definitions = new Map<string, MarketDefinition>();
  private readonly records = new Map<string, MarketRecord>();
  private readonly loadedCatalogVenues = new Set<Venue>();
  private readonly catalogPromises = new Map<
    Venue,
    Promise<CatalogFetchResult>
  >();
  private readonly initialL1TimeoutMs: number;
  private readonly l1StaleAfterMs: number;
  private readonly l1ReconnectDelayMs: number;
  private readonly l1ReconnectMaxDelayMs: number;
  private readonly streamNow = (): number => this.context.now();

  constructor(
    context: ClientContext,
    adapters: Map<Venue, MarketAdapter>,
    options: MarketManagerOptions = {},
  ) {
    this.context = context;
    this.adapters = new Map(adapters);
    this.initialL1TimeoutMs =
      options.initialL1TimeoutMs ?? DEFAULT_INITIAL_L1_TIMEOUT_MS;
    this.l1StaleAfterMs = options.l1StaleAfterMs ?? DEFAULT_L1_STALE_AFTER_MS;
    this.l1ReconnectDelayMs =
      options.l1ReconnectDelayMs ?? DEFAULT_L1_RECONNECT_DELAY_MS;
    this.l1ReconnectMaxDelayMs =
      options.l1ReconnectMaxDelayMs ?? DEFAULT_L1_RECONNECT_MAX_DELAY_MS;

    this.events = {
      all: (filter, options) =>
        this.marketBus.stream(
          (event) => matchesMarketFilter(event, filter),
          this.createStreamOptions(
            "market.all",
            options,
            "buffer",
            marketEventConflateKey,
          ),
        ),
      fundingRateUpdates: (filter, options) =>
        this.marketBus.stream(
          (event): event is FundingRateUpdatedEvent =>
            event.type === "funding_rate.updated" &&
            matchesMarketFilter(event, filter),
          this.createStreamOptions(
            "market.fundingRateUpdates",
            options,
            "conflate",
            marketKey,
          ),
        ),
      l1BookUpdates: (filter, options) =>
        this.marketBus.stream(
          (event): event is L1BookUpdatedEvent =>
            event.type === "l1_book.updated" &&
            matchesMarketFilter(event, filter),
          this.createStreamOptions(
            "market.l1BookUpdates",
            options,
            "conflate",
            marketKey,
          ),
        ),
      status: (filter, options) =>
        this.marketStatusBus.stream(
          (event) => matchesMarketFilter(event, filter),
          this.createStreamOptions(
            "market.status",
            options,
            "buffer",
            marketKey,
          ),
        ),
    };
  }

  // --- MarketManager public API ---

  async loadMarkets(): Promise<void> {
    await Promise.all(
      [...this.adapters.keys()].map((venue) => this.loadMarketCatalog(venue)),
    );
  }

  async reloadMarkets(venue?: Venue): Promise<MarketCatalogReloadSummary[]> {
    if (venue !== undefined) {
      this.assertSupportedVenue(venue);
      return [await this.reloadVenue(venue)];
    }

    const venues = [...this.adapters.keys()];
    const settled = await Promise.allSettled(
      venues.map((registeredVenue) => this.reloadVenue(registeredVenue)),
    );
    const summaries: MarketCatalogReloadSummary[] = [];

    for (const result of settled) {
      if (result.status === "fulfilled") {
        summaries.push(result.value);
        continue;
      }

      throw result.reason;
    }

    return summaries;
  }

  async fetchServerTime(venue: Venue): Promise<VenueServerTime> {
    const adapter = this.getMarketAdapter(venue);
    if (!adapter.fetchServerTime) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue is not supported yet: ${venue}`,
        { venue },
        "client",
      );
    }

    try {
      return await adapter.fetchServerTime();
    } catch (error) {
      throw this.createServerTimeFetchError(venue, error);
    }
  }

  async fetchPublicTrades(
    input: FetchPublicTradesInput,
  ): Promise<FetchPublicTradesResult> {
    this.validatePublicTradesInput(input);

    const market = await this.resolveMarketDefinition(input);
    const adapter = this.getMarketAdapter(market.venue);
    if (!adapter.fetchPublicTrades) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue does not support public trade queries: ${market.venue}`,
        { venue: market.venue, symbol: market.symbol },
        "client",
      );
    }

    try {
      const result = await adapter.fetchPublicTrades(market, {
        startTs: input.startTs,
        endTs: input.endTs,
        limit: input.limit,
      });

      return {
        trades: result.trades.map((trade) =>
          this.createPublicTrade(market, trade),
        ),
        startTs: input.startTs,
        truncated: result.truncated,
        ...(input.endTs !== undefined ? { endTs: input.endTs } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      };
    } catch (error) {
      throw this.createPublicTradesFetchError(market, error);
    }
  }

  async fetchPublicRawTrades(
    input: FetchPublicRawTradesInput,
  ): Promise<FetchPublicRawTradesResult> {
    this.validatePublicTradesInput(input);

    const adapter = this.getMarketAdapter(input.venue);
    if (!adapter.fetchPublicRawTrades) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue does not support public raw trade queries: ${input.venue}`,
        { venue: input.venue, symbol: input.symbol },
        "client",
      );
    }

    try {
      adapter.assertPublicRawTradesConfigured?.();
    } catch (error) {
      throw this.createPublicTradesFetchError(input, error);
    }

    const market = await this.resolveMarketDefinition(input);

    try {
      const result = await adapter.fetchPublicRawTrades(market, {
        startTs: input.startTs,
        endTs: input.endTs,
        limit: input.limit,
      });

      return {
        trades: result.trades.map((trade) =>
          this.createPublicTrade(market, trade),
        ),
        startTs: input.startTs,
        truncated: result.truncated,
        ...(input.endTs !== undefined ? { endTs: input.endTs } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      };
    } catch (error) {
      throw this.createPublicTradesFetchError(market, error);
    }
  }

  async fetchFundingRateHistory(
    input: FetchFundingRateHistoryInput,
  ): Promise<FetchFundingRateHistoryResult> {
    this.validateFundingRateHistoryInput(input);

    const market = await this.resolveMarketDefinition(input);
    this.assertFundingRateSupported(market);
    const adapter = this.getMarketAdapter(market.venue);
    if (!adapter.fetchFundingRateHistory) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue does not support funding rate history queries: ${market.venue}`,
        { venue: market.venue, symbol: market.symbol },
        "client",
      );
    }

    try {
      const result = await adapter.fetchFundingRateHistory(market, {
        startTs: input.startTs,
        endTs: input.endTs,
        limit: input.limit,
      });

      return {
        rates: result.rates.map((rate) =>
          this.createFundingRateHistoryEntry(market, rate),
        ),
        truncated: result.truncated,
        ...(input.startTs !== undefined ? { startTs: input.startTs } : {}),
        ...(input.endTs !== undefined ? { endTs: input.endTs } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      };
    } catch (error) {
      throw this.createFundingRateHistoryFetchError(market, error);
    }
  }

  async subscribeL1Book(input: SubscribeL1BookInput): Promise<void> {
    this.context.assertStarted();
    const market = await this.resolveMarketDefinition(input);
    const record = this.getOrCreateRecord({
      venue: input.venue,
      symbol: market.symbol,
    });

    record.market = market;
    record.l1BookSubscribed = true;
    record.l1Freshness = record.l1Book ? "stale" : undefined;
    record.l1Reason = undefined;
    this.recomputeAndPublishStatus(record);

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
    record.l1Freshness = undefined;
    record.l1Reason = undefined;
    this.syncL1BookStatus(record);
    this.recomputeAndPublishStatus(record, this.context.now());
  }

  async subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void> {
    this.context.assertStarted();
    const market = await this.resolveMarketDefinition(input);
    this.assertFundingRateSupported(market);
    const record = this.getOrCreateRecord({
      venue: input.venue,
      symbol: market.symbol,
    });

    record.market = market;
    record.fundingRateSubscribed = true;
    record.fundingRateFreshness = record.fundingRate ? "stale" : undefined;
    record.fundingRateReason = undefined;
    this.recomputeAndPublishStatus(record);

    await this.ensureFundingRateStream(record, market);
  }

  async unsubscribeFundingRate(
    input: SubscribeFundingRateInput,
  ): Promise<void> {
    const record = this.records.get(marketKey(input));
    if (!record?.fundingRateSubscribed) {
      return;
    }

    record.fundingRateStream?.close();
    record.fundingRateStream = undefined;
    record.fundingRateSubscribed = false;
    record.fundingRateFreshness = undefined;
    record.fundingRateReason = undefined;
    this.syncFundingRateStatus(record);
    this.recomputeAndPublishStatus(record, this.context.now());
  }

  getMarket(venue: Venue, symbol: string): MarketDefinition | undefined {
    const market = this.definitions.get(marketKey({ venue, symbol }));
    return market ? cloneMarketDefinition(market) : undefined;
  }

  getMarkets(symbol: string): MarketDefinition[] {
    return [...this.definitions.values()]
      .filter((market) => market.symbol === symbol)
      .sort((left, right) => left.venue.localeCompare(right.venue))
      .map((market) => cloneMarketDefinition(market));
  }

  listMarkets(venue?: Venue): MarketDefinition[] {
    const values = [...this.definitions.values()];
    const filtered = venue
      ? values.filter((market) => market.venue === venue)
      : values;
    return filtered
      .sort((left, right) => left.symbol.localeCompare(right.symbol))
      .map((market) => cloneMarketDefinition(market));
  }

  normalizeOrderInput(input: NormalizeOrderInputInput): NormalizedOrderInput {
    const market = this.resolveLoadedMarket(input);
    const rawPrice = new BigNumber(input.price);
    const rawAmount = new BigNumber(input.amount);
    const priceStep = new BigNumber(market.priceStep);
    const amountStep = new BigNumber(market.amountStep);
    const minAmount =
      market.minAmount === undefined
        ? undefined
        : new BigNumber(market.minAmount);
    const minNotional =
      market.minNotional === undefined
        ? undefined
        : new BigNumber(market.minNotional);
    const price = floorToStep(rawPrice, priceStep);
    const amount = floorToStep(rawAmount, amountStep);

    // normalizeOrderInput rejects non-finite input gracefully (see the
    // isFinite checks below), so its echoed numeric fields fall back to the
    // raw string instead of throwing the way toCanonical now does.
    const echoDecimal = (value: BigNumber): string =>
      value.isFinite() ? toCanonical(value) : value.toString();

    const normalized: NormalizedOrderInput = {
      price: echoDecimal(price),
      amount: echoDecimal(amount),
      rawPrice: echoDecimal(rawPrice),
      rawAmount: echoDecimal(rawAmount),
      adjusted: !price.isEqualTo(rawPrice) || !amount.isEqualTo(rawAmount),
      accepted: true,
      priceStep: market.priceStep,
      amountStep: market.amountStep,
      minAmount: market.minAmount,
      minNotional: market.minNotional,
    };

    if (!price.isFinite() || price.isLessThanOrEqualTo(0)) {
      return {
        ...normalized,
        accepted: false,
        rejectReason: "price_not_positive",
      };
    }

    if (!amount.isFinite() || amount.isLessThanOrEqualTo(0)) {
      return {
        ...normalized,
        accepted: false,
        rejectReason: "amount_not_positive",
      };
    }

    if (minAmount && amount.isLessThan(minAmount)) {
      return {
        ...normalized,
        accepted: false,
        rejectReason: "amount_below_min",
      };
    }

    if (minNotional) {
      const notional = amount.multipliedBy(price);
      if (notional.isLessThan(minNotional)) {
        return {
          ...normalized,
          accepted: false,
          rejectReason: "notional_below_min",
        };
      }
    }

    return normalized;
  }

  getL1Book(key: MarketKeyInput): L1Book | undefined {
    const book = this.records.get(marketKey(key))?.l1Book;
    return book;
  }

  getL1Books(symbol: string): L1Book[] {
    return [...this.records.values()]
      .filter(
        (record): record is MarketRecord & { l1Book: L1Book } =>
          record.symbol === symbol && Boolean(record.l1Book),
      )
      .map((record) => record.l1Book)
      .sort((left, right) => left.venue.localeCompare(right.venue));
  }

  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined {
    const fundingRate = this.records.get(marketKey(key))?.fundingRate;
    return fundingRate;
  }

  getFundingRates(symbol: string): FundingRateSnapshot[] {
    return [...this.records.values()]
      .filter(
        (
          record,
        ): record is MarketRecord & { fundingRate: FundingRateSnapshot } =>
          record.symbol === symbol && Boolean(record.fundingRate),
      )
      .map((record) => record.fundingRate)
      .sort((left, right) => left.venue.localeCompare(right.venue));
  }

  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined {
    return this.records.get(marketKey(key))?.status;
  }

  // --- ManagerLifecycle ---

  onClientStarted(): void {
    const now = this.context.now();

    for (const record of this.records.values()) {
      if (!record.l1BookSubscribed && !record.fundingRateSubscribed) {
        continue;
      }

      if (record.l1BookSubscribed) {
        record.l1Freshness = record.l1Book ? "stale" : undefined;
        record.l1Reason = undefined;
        this.syncL1BookStatus(record);
      }
      if (record.fundingRateSubscribed) {
        record.fundingRateFreshness = record.fundingRate ? "stale" : undefined;
        record.fundingRateReason = undefined;
        this.syncFundingRateStatus(record);
      }
      this.recomputeAndPublishStatus(record, now);
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
      record.fundingRateStream?.close();
      record.fundingRateStream = undefined;
      record.l1Freshness = record.l1Book ? "stale" : undefined;
      record.fundingRateFreshness = record.fundingRate ? "stale" : undefined;
      this.syncL1BookStatus(record, now, "inactive");
      this.syncFundingRateStatus(record, now, "inactive");

      record.status = freezeMarketStatus({
        ...record.status,
        activity: "inactive",
        inactiveSince: now,
        freshness: record.l1Book || record.fundingRate ? "stale" : undefined,
      });
      this.publishStatus(record);
    }
  }

  // --- HealthReporter ---

  getStatuses(): MarketDataStatus[] {
    return [...this.records.values()]
      .map((record) => record.status)
      .sort((left, right) =>
        `${left.venue}:${left.symbol}`.localeCompare(
          `${right.venue}:${right.symbol}`,
        ),
      );
  }

  // --- Internal helpers ---

  private async loadMarketCatalog(venue: Venue): Promise<void> {
    this.assertSupportedVenue(venue);

    if (this.loadedCatalogVenues.has(venue)) {
      return;
    }

    await this.fetchCatalogCoalesced(venue);
  }

  private async reloadVenue(venue: Venue): Promise<MarketCatalogReloadSummary> {
    try {
      const result = await this.fetchCatalogCoalesced(venue);
      return { ...result, ok: true };
    } catch (error) {
      if (
        error instanceof AcexError &&
        error.code === "MARKET_CATALOG_LOAD_FAILED"
      ) {
        return {
          venue,
          added: [],
          removed: [],
          total: this.countVenueMarkets(venue),
          ok: false,
          error,
        };
      }

      throw error;
    }
  }

  private async fetchCatalogCoalesced(
    venue: Venue,
  ): Promise<CatalogFetchResult> {
    let catalogPromise = this.catalogPromises.get(venue);
    if (!catalogPromise) {
      catalogPromise = this.fetchAndStoreMarketCatalog(venue).finally(() => {
        this.catalogPromises.delete(venue);
      });
      this.catalogPromises.set(venue, catalogPromise);
    }

    return await catalogPromise;
  }

  private async fetchAndStoreMarketCatalog(
    venue: Venue,
  ): Promise<CatalogFetchResult> {
    const adapter = this.getMarketAdapter(venue);
    let markets: MarketDefinition[];

    try {
      markets = await adapter.loadMarkets();
    } catch (error) {
      throw this.createCatalogLoadError(venue, error);
    }

    const mismatchedMarket = markets.find((market) => market.venue !== venue);
    if (mismatchedMarket) {
      throw this.createCatalogLoadError(
        venue,
        new Error(
          `Market catalog from ${venue} included ${mismatchedMarket.venue} market: ${mismatchedMarket.symbol}`,
        ),
      );
    }

    const previousKeys = this.getVenueMarketKeys(venue);

    for (const [key, market] of this.definitions) {
      if (market.venue === venue) {
        this.definitions.delete(key);
      }
    }

    for (const market of markets) {
      this.definitions.set(marketKey(market), market);
    }

    this.loadedCatalogVenues.add(venue);

    const currentKeys = this.getVenueMarketKeys(venue);
    return {
      venue,
      added: this.diffMarketSymbols(venue, currentKeys, previousKeys),
      removed: this.diffMarketSymbols(venue, previousKeys, currentKeys),
      total: currentKeys.size,
    };
  }

  private getVenueMarketKeys(venue: Venue): Set<string> {
    const keys = new Set<string>();

    for (const [key, market] of this.definitions) {
      if (market.venue === venue) {
        keys.add(key);
      }
    }

    return keys;
  }

  private countVenueMarkets(venue: Venue): number {
    return this.getVenueMarketKeys(venue).size;
  }

  private diffMarketSymbols(
    venue: Venue,
    left: Set<string>,
    right: Set<string>,
  ): string[] {
    const prefix = `${venue}:`;
    return [...left]
      .filter((key) => !right.has(key))
      .map((key) => key.slice(prefix.length))
      .sort((leftSymbol, rightSymbol) => leftSymbol.localeCompare(rightSymbol));
  }

  private createCatalogLoadError(venue: Venue, error: unknown): AcexError {
    const details = buildAcexErrorDetails({ venue }, error);
    const wrapped = new AcexError(
      "MARKET_CATALOG_LOAD_FAILED",
      formatAcexErrorMessage(
        `Failed to load market catalog from ${venue}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error("Unknown catalog load failure"),
      { venue },
    );
    return wrapped;
  }

  private createServerTimeFetchError(venue: Venue, error: unknown): AcexError {
    const details = buildAcexErrorDetails({ venue }, error);
    const wrapped = new AcexError(
      "MARKET_SERVER_TIME_FETCH_FAILED",
      formatAcexErrorMessage(
        `Failed to fetch server time from ${venue}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error("Unknown server time fetch failure"),
      { venue },
    );
    return wrapped;
  }

  private createPublicTradesFetchError(
    market: { venue: Venue; symbol: string },
    error: unknown,
  ): AcexError {
    const details = buildAcexErrorDetails(
      { venue: market.venue, symbol: market.symbol },
      error,
    );
    const wrapped = new AcexError(
      "MARKET_PUBLIC_TRADES_FETCH_FAILED",
      formatAcexErrorMessage(
        `Failed to fetch public trades from ${market.venue}: ${market.symbol}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error("Unknown public trades fetch failure"),
      { venue: market.venue, symbol: market.symbol },
    );
    return wrapped;
  }

  private createFundingRateHistoryFetchError(
    market: MarketDefinition,
    error: unknown,
  ): AcexError {
    const details = buildAcexErrorDetails(
      { venue: market.venue, symbol: market.symbol },
      error,
    );
    const wrapped = new AcexError(
      "MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED",
      formatAcexErrorMessage(
        `Failed to fetch funding rate history from ${market.venue}: ${market.symbol}`,
        details,
      ),
      {
        cause: error,
        details,
      },
    );
    this.context.publishRuntimeError(
      "adapter",
      error instanceof Error
        ? error
        : new Error("Unknown funding rate history fetch failure"),
      { venue: market.venue, symbol: market.symbol },
    );
    return wrapped;
  }

  private validatePublicTradesInput(input: FetchPublicTradesInput): void {
    const metadata = { venue: input.venue, symbol: input.symbol };

    if (!isTimestampMs(input.startTs)) {
      throw this.createError(
        "MARKET_INPUT_INVALID",
        "startTs must be a non-negative integer epoch millisecond timestamp",
        metadata,
        "market",
      );
    }

    if (input.endTs === undefined && input.limit === undefined) {
      throw this.createError(
        "MARKET_INPUT_INVALID",
        "Either endTs or limit must be provided when fetching public trades",
        metadata,
        "market",
      );
    }

    if (input.endTs !== undefined) {
      if (!isTimestampMs(input.endTs)) {
        throw this.createError(
          "MARKET_INPUT_INVALID",
          "endTs must be a non-negative integer epoch millisecond timestamp",
          metadata,
          "market",
        );
      }

      if (input.endTs <= input.startTs) {
        throw this.createError(
          "MARKET_INPUT_INVALID",
          "endTs must be greater than startTs when fetching public trades",
          metadata,
          "market",
        );
      }
    }

    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit <= 0)
    ) {
      throw this.createError(
        "MARKET_INPUT_INVALID",
        "limit must be a positive integer when fetching public trades",
        metadata,
        "market",
      );
    }
  }

  private validateFundingRateHistoryInput(
    input: FetchFundingRateHistoryInput,
  ): void {
    const metadata = { venue: input.venue, symbol: input.symbol };

    if (input.startTs !== undefined && !isTimestampMs(input.startTs)) {
      throw this.createError(
        "MARKET_INPUT_INVALID",
        "startTs must be a non-negative integer epoch millisecond timestamp",
        metadata,
        "market",
      );
    }

    if (input.endTs !== undefined) {
      if (!isTimestampMs(input.endTs)) {
        throw this.createError(
          "MARKET_INPUT_INVALID",
          "endTs must be a non-negative integer epoch millisecond timestamp",
          metadata,
          "market",
        );
      }

      if (input.startTs !== undefined && input.endTs < input.startTs) {
        throw this.createError(
          "MARKET_INPUT_INVALID",
          "endTs must be greater than or equal to startTs when fetching funding rate history",
          metadata,
          "market",
        );
      }
    }

    if (input.limit !== undefined) {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw this.createError(
          "MARKET_INPUT_INVALID",
          "limit must be a positive integer when fetching funding rate history",
          metadata,
          "market",
        );
      }

      if (input.limit > MAX_FUNDING_RATE_HISTORY_LIMIT) {
        throw this.createError(
          "MARKET_INPUT_INVALID",
          `limit must be less than or equal to ${MAX_FUNDING_RATE_HISTORY_LIMIT} when fetching funding rate history`,
          metadata,
          "market",
        );
      }
    }
  }

  private createPublicTrade(
    market: MarketDefinition,
    input: RawPublicTrade,
  ): PublicTrade {
    return {
      venue: market.venue,
      symbol: market.symbol,
      id: input.id,
      price: toCanonical(input.price),
      amount: toCanonical(input.amount),
      cost: input.cost === undefined ? undefined : toCanonical(input.cost),
      side: input.side,
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      raw: { ...input.raw },
    };
  }

  private createFundingRateHistoryEntry(
    market: MarketDefinition,
    input: RawFundingRateHistoryEntry,
  ): FundingRateHistoryEntry {
    return {
      venue: market.venue,
      symbol: market.symbol,
      fundingRate: toCanonical(input.fundingRate),
      fundingTime: input.fundingTime,
      markPrice:
        input.markPrice === undefined
          ? undefined
          : toCanonical(input.markPrice),
      receivedAt: input.receivedAt,
      raw: { ...input.raw },
    };
  }

  private async resolveMarketDefinition(input: {
    venue: Venue;
    symbol: string;
  }): Promise<MarketDefinition> {
    this.assertSupportedVenue(input.venue);
    await this.loadMarketCatalog(input.venue);

    const market = this.definitions.get(marketKey(input));
    if (!market) {
      throw this.createError(
        "MARKET_NOT_FOUND",
        `Unknown market symbol: ${input.symbol}`,
        { venue: input.venue, symbol: input.symbol },
        "market",
      );
    }

    if (!market.active) {
      throw this.createError(
        "MARKET_INACTIVE",
        `Inactive market symbol: ${input.symbol}`,
        { venue: input.venue, symbol: input.symbol },
        "market",
      );
    }

    return market;
  }

  private resolveLoadedMarket(input: MarketKeyInput): MarketDefinition {
    const market = this.definitions.get(marketKey(input));
    if (!market) {
      throw this.createError(
        "MARKET_NOT_FOUND",
        `Unknown market symbol: ${input.symbol}`,
        { venue: input.venue, symbol: input.symbol },
        "market",
      );
    }

    return market;
  }

  private assertSupportedVenue(venue: Venue): void {
    if (this.adapters.has(venue)) {
      return;
    }

    throw this.createError(
      "VENUE_NOT_SUPPORTED",
      `Venue is not supported yet: ${venue}`,
      { venue },
      "client",
    );
  }

  private getMarketAdapter(venue: Venue): MarketAdapter {
    const adapter = this.adapters.get(venue);
    if (!adapter) {
      throw this.createError(
        "VENUE_NOT_SUPPORTED",
        `Venue is not supported yet: ${venue}`,
        { venue },
        "client",
      );
    }

    return adapter;
  }

  private assertFundingRateSupported(market: MarketDefinition): void {
    if (market.contract && market.type === "swap") {
      return;
    }

    throw this.createError(
      "MARKET_FUNDING_RATE_UNSUPPORTED",
      `Funding rate is not supported for market: ${market.symbol}`,
      { venue: market.venue, symbol: market.symbol },
      "market",
    );
  }

  private getOrCreateRecord(input: {
    venue: Venue;
    symbol: string;
  }): MarketRecord {
    const key = marketKey(input);
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }

    const record: MarketRecord = {
      venue: input.venue,
      symbol: input.symbol,
      l1BookSubscribed: false,
      fundingRateSubscribed: false,
      status: freezeMarketStatus({
        venue: input.venue,
        symbol: input.symbol,
        activity: "inactive",
        ready: false,
      }),
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
    } catch (error) {
      record.l1BookStream.close();
      record.l1BookStream = undefined;
      const details = buildAcexErrorDetails(
        { venue: market.venue, symbol: market.symbol },
        error,
      );
      const timeoutError = new AcexError(
        "MARKET_STREAM_TIMEOUT",
        `Timed out waiting for market data: ${market.symbol}`,
        {
          cause: error,
          details,
        },
      );
      this.context.publishRuntimeError("runtime", timeoutError, {
        venue: market.venue,
        symbol: market.symbol,
      });
      this.updateConnectionState(record, "l1Book", "stale", "ws_disconnected");
      throw timeoutError;
    }
  }

  private async ensureFundingRateStream(
    record: MarketRecord,
    market: MarketDefinition,
  ): Promise<void> {
    if (record.fundingRateStream) {
      await record.fundingRateStream.ready;
      return;
    }

    record.fundingRateStream = this.createFundingRateStream(record, market);

    try {
      await record.fundingRateStream.ready;
    } catch (error) {
      record.fundingRateStream.close();
      record.fundingRateStream = undefined;
      const details = buildAcexErrorDetails(
        { venue: market.venue, symbol: market.symbol },
        error,
      );
      const timeoutError = new AcexError(
        "MARKET_STREAM_TIMEOUT",
        `Timed out waiting for market data: ${market.symbol}`,
        {
          cause: error,
          details,
        },
      );
      this.context.publishRuntimeError("runtime", timeoutError, {
        venue: market.venue,
        symbol: market.symbol,
      });
      this.updateConnectionState(
        record,
        "fundingRate",
        "stale",
        "ws_disconnected",
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
        if (this.context.metricsEnabled && update.exchangeTs !== undefined) {
          this.context.emitMetric(
            METRIC_NAMES.wsMessageLatency,
            update.receivedAt - update.exchangeTs,
            "timing",
            {
              venue: record.venue,
              channel: "l1book",
              symbol: record.symbol,
            },
          );
        }

        record.l1Freshness = "fresh";
        record.l1Reason = undefined;
        record.l1Book = this.createL1Book(
          record.venue,
          record.symbol,
          update,
          record.l1Book,
        );

        const event: L1BookUpdatedEvent = {
          type: "l1_book.updated",
          venue: record.venue,
          symbol: record.symbol,
          snapshot: record.l1Book,
          ts: this.context.now(),
        };

        this.publishMarketEvent(event);
        this.recomputeAndPublishStatus(record);
      },
      onFreshnessChange: (freshness, reason) => {
        this.updateConnectionState(record, "l1Book", freshness, reason);
      },
      onDisconnected: () => {
        this.updateConnectionState(
          record,
          "l1Book",
          "stale",
          "ws_disconnected",
        );
      },
      onError: (error) => {
        this.context.publishRuntimeError("runtime", error, {
          venue: record.venue,
          symbol: record.symbol,
        });
      },
    };

    const options: L1BookStreamOptions = {
      initialMessageTimeoutMs: this.initialL1TimeoutMs,
      staleAfterMs: this.l1StaleAfterMs,
      reconnectDelayMs: this.l1ReconnectDelayMs,
      reconnectMaxDelayMs: this.l1ReconnectMaxDelayMs,
      now: this.streamNow,
    };

    return this.getMarketAdapter(market.venue).createL1BookStream(
      market,
      callbacks,
      options,
    );
  }

  private createFundingRateStream(
    record: MarketRecord,
    market: MarketDefinition,
  ): StreamHandle {
    const callbacks: FundingRateStreamCallbacks = {
      onUpdate: (update: RawFundingRateUpdate) => {
        record.fundingRateFreshness = "fresh";
        record.fundingRateReason = undefined;
        record.fundingRate = this.createFundingRate(
          record.venue,
          record.symbol,
          update,
          record.fundingRate,
        );

        const event: FundingRateUpdatedEvent = {
          type: "funding_rate.updated",
          venue: record.venue,
          symbol: record.symbol,
          snapshot: record.fundingRate,
          ts: this.context.now(),
        };

        this.publishMarketEvent(event);
        this.recomputeAndPublishStatus(record);
      },
      onFreshnessChange: (freshness, reason) => {
        this.updateConnectionState(record, "fundingRate", freshness, reason);
      },
      onDisconnected: () => {
        this.updateConnectionState(
          record,
          "fundingRate",
          "stale",
          "ws_disconnected",
        );
      },
      onError: (error) => {
        this.context.publishRuntimeError("runtime", error, {
          venue: record.venue,
          symbol: record.symbol,
        });
      },
    };

    const options: FundingRateStreamOptions = {
      initialMessageTimeoutMs: this.initialL1TimeoutMs,
      staleAfterMs: this.l1StaleAfterMs,
      reconnectDelayMs: this.l1ReconnectDelayMs,
      reconnectMaxDelayMs: this.l1ReconnectMaxDelayMs,
      now: this.streamNow,
    };

    return this.getMarketAdapter(market.venue).createFundingRateStream(
      market,
      callbacks,
      options,
    );
  }

  private createL1Book(
    venue: Venue,
    symbol: string,
    input: RawL1BookUpdate,
    previous?: L1Book,
  ): L1Book {
    return freezeL1Book({
      venue,
      symbol,
      bidPrice: toCanonical(input.bidPrice),
      bidSize: toCanonical(input.bidSize),
      askPrice: toCanonical(input.askPrice),
      askSize: toCanonical(input.askSize),
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      version: (previous?.version ?? 0) + 1,
      status: this.createStreamStatus(
        "active",
        true,
        "fresh",
        undefined,
        input.receivedAt,
        input.receivedAt,
      ),
    });
  }

  private createFundingRate(
    venue: Venue,
    symbol: string,
    input: RawFundingRateUpdate,
    previous?: FundingRateSnapshot,
  ): FundingRateSnapshot {
    return freezeFundingRate({
      venue,
      symbol,
      fundingRate: toCanonical(input.fundingRate),
      nextFundingTime: input.nextFundingTime,
      markPrice: input.markPrice ? toCanonical(input.markPrice) : undefined,
      indexPrice: input.indexPrice ? toCanonical(input.indexPrice) : undefined,
      exchangeTs: input.exchangeTs,
      receivedAt: input.receivedAt,
      updatedAt: input.receivedAt,
      version: (previous?.version ?? 0) + 1,
      status: this.createStreamStatus(
        "active",
        true,
        "fresh",
        undefined,
        input.receivedAt,
        input.receivedAt,
      ),
    });
  }

  private updateConnectionState(
    record: MarketRecord,
    stream: "l1Book" | "fundingRate",
    freshness: "fresh" | "stale",
    reason: MarketDataStatus["reason"],
  ): void {
    if (stream === "l1Book") {
      record.l1Freshness = freshness;
      record.l1Reason = reason;
      this.syncL1BookStatus(record);
    } else {
      record.fundingRateFreshness = freshness;
      record.fundingRateReason = reason;
      this.syncFundingRateStatus(record);
    }

    this.recomputeAndPublishStatus(record);
  }

  private recomputeAndPublishStatus(
    record: MarketRecord,
    now = this.context.now(),
  ): void {
    const l1Ready = record.l1BookSubscribed && Boolean(record.l1Book);
    const fundingRateReady =
      record.fundingRateSubscribed && Boolean(record.fundingRate);
    const active = record.l1BookSubscribed || record.fundingRateSubscribed;
    const staleReason = record.l1Reason ?? record.fundingRateReason;
    const freshness = this.resolveFreshness(record);

    const nextStatus: MarketDataStatus = {
      ...record.status,
      activity: active ? "active" : "inactive",
      ready: l1Ready || fundingRateReady,
      freshness,
      reason: freshness === "stale" ? staleReason : undefined,
      inactiveSince: active ? undefined : now,
    };

    if (nextStatus.ready) {
      nextStatus.lastReceivedAt = this.resolveLastReceivedAt(record);
      nextStatus.lastReadyAt = this.resolveLastReadyAt(record);
    }

    record.status = freezeMarketStatus(nextStatus);

    const publicationKey = statusPublicationKey(record.status);
    if (
      sameStatusPublicationKey(publicationKey, record.lastPublishedStatusKey)
    ) {
      return;
    }

    record.lastPublishedStatusKey = publicationKey;
    this.publishStatus(record);
  }

  private syncL1BookStatus(
    record: MarketRecord,
    now?: number,
    activity?: SubscriptionActivity,
  ): void {
    if (!record.l1Book) {
      return;
    }

    record.l1Book = freezeL1Book({
      ...record.l1Book,
      status: this.createStreamStatus(
        activity ?? (record.l1BookSubscribed ? "active" : "inactive"),
        true,
        record.l1Freshness,
        record.l1Reason,
        record.l1Book.receivedAt,
        record.l1Book.updatedAt,
        now,
      ),
    });
  }

  private syncFundingRateStatus(
    record: MarketRecord,
    now?: number,
    activity?: SubscriptionActivity,
  ): void {
    if (!record.fundingRate) {
      return;
    }

    record.fundingRate = freezeFundingRate({
      ...record.fundingRate,
      status: this.createStreamStatus(
        activity ?? (record.fundingRateSubscribed ? "active" : "inactive"),
        true,
        record.fundingRateFreshness,
        record.fundingRateReason,
        record.fundingRate.receivedAt,
        record.fundingRate.updatedAt,
        now,
      ),
    });
  }

  private createStreamStatus(
    activity: SubscriptionActivity,
    ready: boolean,
    freshness: MarketDataStreamStatus["freshness"],
    reason: MarketDataStreamStatus["reason"],
    lastReceivedAt?: number,
    lastReadyAt?: number,
    now = this.context.now(),
  ): MarketDataStreamStatus {
    return freezeStreamStatus({
      activity,
      ready,
      freshness,
      reason: freshness === "stale" ? reason : undefined,
      lastReceivedAt,
      lastReadyAt,
      inactiveSince: activity === "active" ? undefined : now,
    });
  }

  private resolveFreshness(
    record: MarketRecord,
  ): MarketDataStatus["freshness"] | undefined {
    if (record.l1BookSubscribed && record.l1Freshness === "stale") {
      return "stale";
    }
    if (
      record.fundingRateSubscribed &&
      record.fundingRateFreshness === "stale"
    ) {
      return "stale";
    }
    if (record.l1BookSubscribed && record.l1Freshness === "fresh") {
      return "fresh";
    }
    if (
      record.fundingRateSubscribed &&
      record.fundingRateFreshness === "fresh"
    ) {
      return "fresh";
    }

    return undefined;
  }

  private resolveLastReceivedAt(record: MarketRecord): number | undefined {
    return Math.max(
      record.l1Book?.receivedAt ?? 0,
      record.fundingRate?.receivedAt ?? 0,
    );
  }

  private resolveLastReadyAt(record: MarketRecord): number | undefined {
    return Math.max(
      record.l1Book?.updatedAt ?? 0,
      record.fundingRate?.updatedAt ?? 0,
    );
  }

  private publishMarketEvent(event: MarketEvent): void {
    this.marketBus.publish(event);
  }

  private publishStatus(record: MarketRecord): void {
    const event: MarketStatusChangedEvent = {
      type: "market.status_changed",
      venue: record.venue,
      symbol: record.symbol,
      status: record.status,
      ts: this.context.now(),
    };

    this.marketStatusBus.publish(event);
    this.marketBus.publish(event);
    this.context.publishHealthEvent(event);
  }

  private createStreamOptions<U extends { venue: Venue; symbol: string }>(
    stream: string,
    options: EventStreamOptions | undefined,
    defaultMode: "buffer" | "conflate",
    conflateKey: (event: U) => string,
  ): AsyncEventBusStreamOptions<U> {
    return {
      mode: options?.mode ?? defaultMode,
      maxBuffer: options?.maxBuffer,
      conflateKey,
      onOverflow: this.createOverflowHandler(stream),
    };
  }

  private createOverflowHandler(
    stream: string,
  ): (info: AsyncEventBusOverflowInfo) => void {
    return ({ maxBuffer }) => {
      this.context.emitMetric(METRIC_NAMES.eventBufferOverflow, 1, "counter", {
        stream,
      });
      const error = new AcexError(
        "EVENT_BUFFER_OVERFLOW",
        `Event stream buffer overflow: ${stream}`,
      );
      this.context.publishRuntimeError("market", error, {
        stream,
        maxBuffer,
      });
    };
  }

  private async resumeStreams(): Promise<void> {
    const tasks: Array<() => Promise<void>> = [];

    for (const record of this.records.values()) {
      const market = record.market;
      if (!market) {
        continue;
      }

      if (record.l1BookSubscribed && !record.l1BookStream) {
        tasks.push(async () => {
          if (!record.l1BookSubscribed || record.l1BookStream) {
            return;
          }

          record.l1Freshness = record.l1Book ? "stale" : undefined;
          record.l1Reason = undefined;
          this.recomputeAndPublishStatus(record);
          await this.ensureL1BookStream(record, market);
        });
      }

      if (record.fundingRateSubscribed && !record.fundingRateStream) {
        tasks.push(async () => {
          if (!record.fundingRateSubscribed || record.fundingRateStream) {
            return;
          }

          record.fundingRateFreshness = record.fundingRate
            ? "stale"
            : undefined;
          record.fundingRateReason = undefined;
          this.recomputeAndPublishStatus(record);
          await this.ensureFundingRateStream(record, market);
        });
      }
    }

    await Promise.allSettled(
      tasks.map(async (task) => {
        try {
          await task();
        } catch {
          // Errors are already published through the runtime error bus.
        }
      }),
    );
  }

  private createError(
    code:
      | "MARKET_INPUT_INVALID"
      | "MARKET_NOT_FOUND"
      | "MARKET_INACTIVE"
      | "MARKET_FUNDING_RATE_UNSUPPORTED"
      | "VENUE_NOT_SUPPORTED",
    message: string,
    metadata?: { venue?: Venue; symbol?: string },
    source: "market" | "client" = "market",
  ): AcexError {
    const error = new AcexError(code, message, {
      details: buildAcexErrorDetails(metadata),
    });
    this.context.publishRuntimeError(source, error, metadata);
    return error;
  }
}
