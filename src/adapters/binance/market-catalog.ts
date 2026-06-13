import { toCanonical } from "../../internal/decimal.ts";
import {
  type HttpClientMessages,
  httpRequest,
  isTransportError,
} from "../../internal/http-client.ts";
import type {
  AcexInternalError,
  MarketDefinition,
  MarketType,
  RateLimiter,
  RateLimitScope,
} from "../../types/index.ts";
import { SymbolMappingError } from "../types.ts";
import { parseBinanceRateLimitUsage } from "./rate-limit.ts";
import { getBinanceCatalogRateLimitPlanId } from "./rate-limit-topology.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BinanceMarketFamily = "spot" | "usdm" | "coinm";

export interface BinanceMarketDefinition extends MarketDefinition {
  family: BinanceMarketFamily;
}

export type BinanceCatalogRuntimeErrorPublisher = (
  source: AcexInternalError["source"],
  error: Error,
  metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
) => void;

interface BinanceSymbolFilter {
  filterType?: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
  notional?: string;
}

interface BinanceSpotSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters?: BinanceSymbolFilter[];
}

interface BinanceSpotExchangeInfo {
  symbols?: BinanceSpotSymbolInfo[];
}

interface BinanceDerivativesSymbolInfo {
  symbol: string;
  status: string;
  contractType?: string;
  deliveryDate?: number;
  baseAsset: string;
  quoteAsset: string;
  marginAsset?: string;
  pricePrecision?: number;
  quantityPrecision?: number;
  contractSize?: number | string;
  filters?: BinanceSymbolFilter[];
}

interface BinanceDerivativesExchangeInfo {
  symbols?: BinanceDerivativesSymbolInfo[];
}

const BINANCE_SPOT_EXCHANGE_INFO_URL =
  "https://api.binance.com/api/v3/exchangeInfo";
const BINANCE_USDM_EXCHANGE_INFO_URL =
  "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BINANCE_COINM_EXCHANGE_INFO_URL =
  "https://dapi.binance.com/dapi/v1/exchangeInfo";
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const BINANCE_MARKET_FAMILIES = ["spot", "usdm", "coinm"] as const;
const MAX_DELIVERY_TOMBSTONES_PER_FAMILY = 512;
const DEFAULT_MISS_REFRESH_COOLDOWN_MS = 30_000;
const DEFAULT_MISS_REFRESH_FAILURE_RETRY_MS = 5_000;
const BINANCE_CATALOG_HTTP_MESSAGES: HttpClientMessages = {
  http: ({ status, statusText }) =>
    `Binance request failed: ${status} ${statusText ?? ""}`,
};

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function getFilter(
  filters: BinanceSymbolFilter[] | undefined,
  filterType: string,
): BinanceSymbolFilter | undefined {
  return filters?.find((filter) => filter.filterType === filterType);
}

function normalizeStep(step: string | undefined, fallback = "1"): string {
  return step && step.length > 0 ? step : fallback;
}

function precisionFromStep(step: string): number {
  const normalized = step.replace(/0+$/, "");
  const dotIndex = normalized.indexOf(".");
  if (dotIndex === -1) {
    return 0;
  }

  return normalized.length - dotIndex - 1;
}

function formatExpiry(expiry: number): string {
  const date = new Date(expiry);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
}

function inferContractType(
  contractType: string | undefined,
  deliveryDate: number | undefined,
): MarketType {
  // Binance TradFi perpetuals expose a far-future deliveryDate, so the
  // contractType is authoritative for perpetual classification.
  if (contractType === "PERPETUAL" || contractType === "TRADIFI_PERPETUAL") {
    return "swap";
  }

  if (deliveryDate && Number.isFinite(deliveryDate) && deliveryDate > 0) {
    return "future";
  }

  return "swap";
}

function buildFuturesSymbol(
  base: string,
  quote: string,
  settle: string,
  type: MarketType,
  expiry: number | undefined,
): string {
  const prefix = `${base}/${quote}:${settle}`;
  if (type !== "future" || !expiry) {
    return prefix;
  }

  return `${prefix}-${formatExpiry(expiry)}`;
}

function normalizeSpotSymbol(
  symbol: BinanceSpotSymbolInfo,
): BinanceMarketDefinition {
  const priceFilter = getFilter(symbol.filters, "PRICE_FILTER");
  const lotSizeFilter = getFilter(symbol.filters, "LOT_SIZE");
  const notionalFilter =
    getFilter(symbol.filters, "NOTIONAL") ??
    getFilter(symbol.filters, "MIN_NOTIONAL");
  const priceStep = normalizeStep(priceFilter?.tickSize);
  const amountStep = normalizeStep(lotSizeFilter?.stepSize);
  const notionalValue = notionalFilter?.minNotional ?? notionalFilter?.notional;

  return {
    venue: "binance",
    family: "spot",
    symbol: `${symbol.baseAsset}/${symbol.quoteAsset}`,
    id: symbol.symbol,
    type: "spot",
    base: symbol.baseAsset,
    quote: symbol.quoteAsset,
    active: symbol.status === "TRADING",
    contract: false,
    pricePrecision: precisionFromStep(priceStep),
    amountPrecision: precisionFromStep(amountStep),
    priceStep: toCanonical(priceStep),
    amountStep: toCanonical(amountStep),
    minAmount: lotSizeFilter?.minQty
      ? toCanonical(lotSizeFilter.minQty)
      : undefined,
    minNotional: notionalValue ? toCanonical(notionalValue) : undefined,
    raw: toRecord(symbol),
  };
}

function normalizeDerivativesSymbol(
  symbol: BinanceDerivativesSymbolInfo,
  family: BinanceMarketFamily,
): BinanceMarketDefinition {
  const priceFilter = getFilter(symbol.filters, "PRICE_FILTER");
  const lotSizeFilter = getFilter(symbol.filters, "LOT_SIZE");
  const notionalFilter =
    getFilter(symbol.filters, "NOTIONAL") ??
    getFilter(symbol.filters, "MIN_NOTIONAL");
  const priceStep = normalizeStep(priceFilter?.tickSize);
  const amountStep = normalizeStep(lotSizeFilter?.stepSize);
  const type = inferContractType(symbol.contractType, symbol.deliveryDate);
  const settle =
    symbol.marginAsset ??
    (family === "usdm" ? symbol.quoteAsset : symbol.baseAsset);
  const contractSize =
    symbol.contractSize !== undefined
      ? `${symbol.contractSize}`
      : family === "usdm"
        ? "1"
        : undefined;
  const notionalValue = notionalFilter?.minNotional ?? notionalFilter?.notional;

  return {
    venue: "binance",
    family,
    symbol: buildFuturesSymbol(
      symbol.baseAsset,
      symbol.quoteAsset,
      settle,
      type,
      type === "future" ? symbol.deliveryDate : undefined,
    ),
    id: symbol.symbol,
    type,
    base: symbol.baseAsset,
    quote: symbol.quoteAsset,
    settle,
    active: symbol.status === "TRADING",
    contract: true,
    linear: family === "usdm",
    inverse: family === "coinm",
    contractSize: contractSize ? toCanonical(contractSize) : undefined,
    pricePrecision: precisionFromStep(priceStep),
    amountPrecision: precisionFromStep(amountStep),
    priceStep: toCanonical(priceStep),
    amountStep: toCanonical(amountStep),
    minAmount: lotSizeFilter?.minQty
      ? toCanonical(lotSizeFilter.minQty)
      : undefined,
    minNotional: notionalValue ? toCanonical(notionalValue) : undefined,
    expiry: type === "future" ? symbol.deliveryDate : undefined,
    raw: toRecord(symbol),
  };
}

function endpointForFamily(family: BinanceMarketFamily): {
  readonly url: string;
  readonly endpointKey: string;
} {
  switch (family) {
    case "spot":
      return {
        url: BINANCE_SPOT_EXCHANGE_INFO_URL,
        endpointKey: "GET /api/v3/exchangeInfo",
      };
    case "usdm":
      return {
        url: BINANCE_USDM_EXCHANGE_INFO_URL,
        endpointKey: "GET /fapi/v1/exchangeInfo",
      };
    case "coinm":
      return {
        url: BINANCE_COINM_EXCHANGE_INFO_URL,
        endpointKey: "GET /dapi/v1/exchangeInfo",
      };
  }
}

async function requestCatalogJson<T>(
  fetchFn: FetchLike,
  url: string,
  rateLimiter: RateLimiter | undefined,
  endpointKey: string,
): Promise<T> {
  const scope: RateLimitScope = {
    venue: "binance",
    endpointKey,
  };
  const requestContext = {
    scope,
    planId: getBinanceCatalogRateLimitPlanId(endpointKey),
  };

  const reservation =
    (await rateLimiter?.beforeRequest(requestContext)) ?? undefined;

  try {
    const response = await httpRequest<T>({
      fetchFn,
      url,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      parseAs: "json",
      jsonParseMode: "response",
      retryPolicy: {
        idempotent: true,
        maxAttempts: 1,
      },
      messages: BINANCE_CATALOG_HTTP_MESSAGES,
    });

    await rateLimiter?.afterResponse(requestContext, {
      status: response.status,
      headers: response.headers,
      usage: parseBinanceRateLimitUsage(response.headers),
      reservation,
    });

    return response.body;
  } catch (error) {
    if (isTransportError(error)) {
      await rateLimiter?.onTransportError(requestContext, {
        status: error.status,
        headers: error.headers,
        retryAfterMs: error.retryAfterMs,
        usage: parseBinanceRateLimitUsage(error.headers),
        reservation,
      });
    }

    throw error;
  }
}

function sortMarkets(
  markets: BinanceMarketDefinition[],
): BinanceMarketDefinition[] {
  return [...markets].sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  );
}

export async function loadBinanceMarkets(
  fetchFn: FetchLike = fetch,
  options: { readonly rateLimiter?: RateLimiter } = {},
): Promise<BinanceMarketDefinition[]> {
  const markets = await Promise.all(
    BINANCE_MARKET_FAMILIES.map((family) =>
      loadBinanceMarketFamily(family, fetchFn, options),
    ),
  );

  return sortMarkets(markets.flat());
}

export async function loadBinanceMarketFamily(
  family: BinanceMarketFamily,
  fetchFn: FetchLike = fetch,
  options: { readonly rateLimiter?: RateLimiter } = {},
): Promise<BinanceMarketDefinition[]> {
  const endpoint = endpointForFamily(family);

  if (family === "spot") {
    const response = await requestCatalogJson<BinanceSpotExchangeInfo>(
      fetchFn,
      endpoint.url,
      options.rateLimiter,
      endpoint.endpointKey,
    );
    return sortMarkets((response.symbols ?? []).map(normalizeSpotSymbol));
  }

  const response = await requestCatalogJson<BinanceDerivativesExchangeInfo>(
    fetchFn,
    endpoint.url,
    options.rateLimiter,
    endpoint.endpointKey,
  );
  return sortMarkets(
    (response.symbols ?? []).map((symbol) =>
      normalizeDerivativesSymbol(symbol, family),
    ),
  );
}

export class BinanceMarketCatalog {
  private readonly fetchFn: FetchLike;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly publishRuntimeError:
    | BinanceCatalogRuntimeErrorPublisher
    | undefined;
  private readonly missRefreshCooldownMs: number;
  private readonly missRefreshFailureRetryMs: number;
  private readonly now: () => number;
  private readonly definitionsByFamily = new Map<
    BinanceMarketFamily,
    Map<string, BinanceMarketDefinition>
  >();
  private readonly venueIdByUnifiedByFamily = new Map<
    BinanceMarketFamily,
    Map<string, string>
  >();
  private readonly deliveryTombstonesByFamily = new Map<
    BinanceMarketFamily,
    Map<string, BinanceMarketDefinition>
  >();
  private readonly deliveryTombstoneVenueIdByUnifiedByFamily = new Map<
    BinanceMarketFamily,
    Map<string, string>
  >();
  private readonly tombstoneOrderByFamily = new Map<
    BinanceMarketFamily,
    string[]
  >();
  private readonly inFlightByFamily = new Map<
    BinanceMarketFamily,
    Promise<void>
  >();
  private readonly missRefreshNextAllowedAt = new Map<string, number>();
  private readonly reportedRuntimeErrorKeys = new Set<string>();

  constructor(
    options: {
      readonly fetchFn?: FetchLike;
      readonly rateLimiter?: RateLimiter;
      readonly publishRuntimeError?: BinanceCatalogRuntimeErrorPublisher;
      readonly missRefreshCooldownMs?: number;
      readonly missRefreshFailureRetryMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.rateLimiter = options.rateLimiter;
    this.publishRuntimeError = options.publishRuntimeError;
    this.missRefreshCooldownMs = normalizeCooldownMs(
      options.missRefreshCooldownMs,
    );
    this.missRefreshFailureRetryMs = normalizeFailureRetryMs(
      options.missRefreshFailureRetryMs,
      this.missRefreshCooldownMs,
    );
    this.now = options.now ?? Date.now;
  }

  async ensureLoaded(family: BinanceMarketFamily): Promise<void> {
    if (this.definitionsByFamily.has(family)) {
      return;
    }

    await this.loadFamilyCoalesced(family);
  }

  async refreshFamily(family: BinanceMarketFamily): Promise<void> {
    await this.loadFamilyCoalesced(family);
  }

  async refreshFamilyAfterMiss(
    family: BinanceMarketFamily,
    symbols: readonly string[],
  ): Promise<"refreshed" | "cooldown"> {
    const claimed = this.claimMissRefresh(family, symbols);
    if (claimed.length === 0) {
      return "cooldown";
    }

    try {
      await this.refreshFamily(family);
    } catch (error) {
      // A failed refresh must not consume the full miss cooldown: restamp the
      // claimed symbols with the shorter failure retry window so transient
      // exchangeInfo errors do not delay quarantined replays by a whole
      // cooldown period.
      const retryAt = this.now() + this.missRefreshFailureRetryMs;
      for (const symbol of claimed) {
        this.missRefreshNextAllowedAt.set(
          missRefreshKey(family, symbol),
          retryAt,
        );
      }
      throw error;
    }

    return "refreshed";
  }

  getMissRefreshDelayMs(
    family: BinanceMarketFamily,
    symbols: readonly string[],
  ): number {
    const now = this.now();
    const nextAt = uniqueStrings(symbols).reduce<number | undefined>(
      (earliest, symbol) => {
        const value = this.missRefreshNextAllowedAt.get(
          missRefreshKey(family, symbol),
        );
        if (value === undefined) {
          return earliest;
        }

        return earliest === undefined ? value : Math.min(earliest, value);
      },
      undefined,
    );

    if (nextAt === undefined) {
      return 0;
    }

    return Math.max(0, nextAt - now);
  }

  async loadAll(): Promise<BinanceMarketDefinition[]> {
    await Promise.all(
      BINANCE_MARKET_FAMILIES.map((family) => this.refreshFamily(family)),
    );
    return this.getAllDefinitions();
  }

  getAllDefinitions(): BinanceMarketDefinition[] {
    return sortMarkets(
      BINANCE_MARKET_FAMILIES.flatMap((family) => [
        ...(this.definitionsByFamily.get(family)?.values() ?? []),
      ]),
    );
  }

  getDefinition(
    family: BinanceMarketFamily,
    unifiedSymbol: string,
  ): BinanceMarketDefinition | undefined {
    const venueId = this.venueIdByUnifiedByFamily
      .get(family)
      ?.get(unifiedSymbol);
    if (venueId) {
      return this.definitionsByFamily.get(family)?.get(venueId);
    }

    const tombstoneVenueId = this.deliveryTombstoneVenueIdByUnifiedByFamily
      .get(family)
      ?.get(unifiedSymbol);
    return tombstoneVenueId
      ? this.deliveryTombstonesByFamily.get(family)?.get(tombstoneVenueId)
      : undefined;
  }

  toUnified(family: BinanceMarketFamily, venueId: string): string | undefined {
    return (
      this.definitionsByFamily.get(family)?.get(venueId)?.symbol ??
      this.deliveryTombstonesByFamily.get(family)?.get(venueId)?.symbol
    );
  }

  toVenueId(family: BinanceMarketFamily, unifiedSymbol: string): string {
    const venueId =
      this.venueIdByUnifiedByFamily.get(family)?.get(unifiedSymbol) ??
      this.deliveryTombstoneVenueIdByUnifiedByFamily
        .get(family)
        ?.get(unifiedSymbol);
    if (!venueId) {
      throw new SymbolMappingError({
        venue: "binance",
        family,
        symbol: unifiedSymbol,
        direction: "to_venue",
      });
    }

    return venueId;
  }

  reportSymbolMappingMiss(family: BinanceMarketFamily, venueId: string): void {
    this.publishRuntimeErrorOnce(
      `symbol-mapping:${family}:${venueId}`,
      new SymbolMappingError({
        venue: "binance",
        family,
        symbol: venueId,
        direction: "to_unified",
      }),
      {
        venue: "binance",
        symbol: venueId,
      },
    );
  }

  private async loadFamilyCoalesced(
    family: BinanceMarketFamily,
  ): Promise<void> {
    let promise = this.inFlightByFamily.get(family);
    if (!promise) {
      promise = this.fetchAndSwapFamily(family).finally(() => {
        this.inFlightByFamily.delete(family);
      });
      this.inFlightByFamily.set(family, promise);
    }

    await promise;
  }

  private async fetchAndSwapFamily(family: BinanceMarketFamily): Promise<void> {
    try {
      const markets = await loadBinanceMarketFamily(family, this.fetchFn, {
        rateLimiter: this.rateLimiter,
      });
      this.installFamily(family, markets);
    } catch (error) {
      const runtimeError =
        error instanceof Error
          ? new Error(
              `Failed to load Binance ${family} market catalog: ${error.message}`,
              { cause: error },
            )
          : new Error(`Failed to load Binance ${family} market catalog`);
      this.publishRuntimeErrorOnce(`catalog-load:${family}`, runtimeError, {
        venue: "binance",
      });
      throw error;
    }
  }

  private installFamily(
    family: BinanceMarketFamily,
    markets: BinanceMarketDefinition[],
  ): void {
    const nextByVenueId = new Map<string, BinanceMarketDefinition>();
    const nextVenueIdByUnified = new Map<string, string>();

    for (const market of markets) {
      nextByVenueId.set(market.id, market);
      nextVenueIdByUnified.set(market.symbol, market.id);
    }

    this.retainRemovedDeliveryDefinitions(family, nextByVenueId);
    this.definitionsByFamily.set(family, nextByVenueId);
    this.venueIdByUnifiedByFamily.set(family, nextVenueIdByUnified);
    this.dropLiveTombstones(family, nextByVenueId);
    this.clearResolvedRuntimeErrorKeys(family, nextByVenueId);
  }

  /**
   * Re-arm once-only runtime errors that the freshly installed snapshot
   * resolves, so a symbol that misses again after being mapped (or a later
   * catalog-load outage) is reported instead of being suppressed for the
   * process lifetime.
   */
  private clearResolvedRuntimeErrorKeys(
    family: BinanceMarketFamily,
    nextByVenueId: Map<string, BinanceMarketDefinition>,
  ): void {
    this.reportedRuntimeErrorKeys.delete(`catalog-load:${family}`);

    const prefix = `symbol-mapping:${family}:`;
    for (const key of this.reportedRuntimeErrorKeys) {
      if (
        key.startsWith(prefix) &&
        nextByVenueId.has(key.slice(prefix.length))
      ) {
        this.reportedRuntimeErrorKeys.delete(key);
      }
    }
  }

  private retainRemovedDeliveryDefinitions(
    family: BinanceMarketFamily,
    nextByVenueId: Map<string, BinanceMarketDefinition>,
  ): void {
    const previousByVenueId = this.definitionsByFamily.get(family);
    if (!previousByVenueId) {
      return;
    }

    for (const [venueId, definition] of previousByVenueId) {
      if (nextByVenueId.has(venueId) || !isDeliveryDefinition(definition)) {
        continue;
      }

      this.addDeliveryTombstone(family, definition);
    }
  }

  private addDeliveryTombstone(
    family: BinanceMarketFamily,
    definition: BinanceMarketDefinition,
  ): void {
    let tombstones = this.deliveryTombstonesByFamily.get(family);
    if (!tombstones) {
      tombstones = new Map();
      this.deliveryTombstonesByFamily.set(family, tombstones);
    }

    let reverse = this.deliveryTombstoneVenueIdByUnifiedByFamily.get(family);
    if (!reverse) {
      reverse = new Map();
      this.deliveryTombstoneVenueIdByUnifiedByFamily.set(family, reverse);
    }

    let order = this.tombstoneOrderByFamily.get(family);
    if (!order) {
      order = [];
      this.tombstoneOrderByFamily.set(family, order);
    }

    if (!tombstones.has(definition.id)) {
      order.push(definition.id);
    }
    tombstones.set(definition.id, definition);
    reverse.set(definition.symbol, definition.id);

    while (order.length > MAX_DELIVERY_TOMBSTONES_PER_FAMILY) {
      const evicted = order.shift();
      if (!evicted) {
        continue;
      }

      const evictedDefinition = tombstones.get(evicted);
      tombstones.delete(evicted);
      if (evictedDefinition) {
        reverse.delete(evictedDefinition.symbol);
      }
    }
  }

  private dropLiveTombstones(
    family: BinanceMarketFamily,
    nextByVenueId: Map<string, BinanceMarketDefinition>,
  ): void {
    const tombstones = this.deliveryTombstonesByFamily.get(family);
    const reverse = this.deliveryTombstoneVenueIdByUnifiedByFamily.get(family);
    const order = this.tombstoneOrderByFamily.get(family);
    if (!tombstones || !reverse || !order) {
      return;
    }

    for (const venueId of nextByVenueId.keys()) {
      const tombstone = tombstones.get(venueId);
      if (!tombstone) {
        continue;
      }

      tombstones.delete(venueId);
      reverse.delete(tombstone.symbol);
      const index = order.indexOf(venueId);
      if (index !== -1) {
        order.splice(index, 1);
      }
    }
  }

  private publishRuntimeErrorOnce(
    key: string,
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void {
    if (!this.publishRuntimeError || this.reportedRuntimeErrorKeys.has(key)) {
      return;
    }

    this.reportedRuntimeErrorKeys.add(key);
    this.publishRuntimeError("adapter", error, metadata);
  }

  private claimMissRefresh(
    family: BinanceMarketFamily,
    symbols: readonly string[],
  ): string[] {
    const now = this.now();
    return uniqueStrings([...symbols]).filter((symbol) => {
      const key = missRefreshKey(family, symbol);
      const nextAllowedAt = this.missRefreshNextAllowedAt.get(key) ?? 0;
      if (nextAllowedAt > now) {
        return false;
      }

      this.missRefreshNextAllowedAt.set(key, now + this.missRefreshCooldownMs);
      return true;
    });
  }
}

function isDeliveryDefinition(definition: BinanceMarketDefinition): boolean {
  return definition.type === "future" && definition.expiry !== undefined;
}

function normalizeCooldownMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_MISS_REFRESH_COOLDOWN_MS;
}

function normalizeFailureRetryMs(
  value: number | undefined,
  cooldownMs: number,
): number {
  if (value !== undefined && Number.isFinite(value) && value >= 0) {
    return value;
  }

  return Math.min(cooldownMs, DEFAULT_MISS_REFRESH_FAILURE_RETRY_MS);
}

function missRefreshKey(family: BinanceMarketFamily, symbol: string): string {
  return `${family}:${symbol}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
