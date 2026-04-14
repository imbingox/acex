import type { MarketDefinition, MarketType } from "../../types/index.ts";

type FetchLike = typeof fetch;

export type BinanceMarketFamily = "spot" | "usdm" | "coinm";

export interface BinanceMarketDefinition extends MarketDefinition {
  family: BinanceMarketFamily;
}

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
  if (contractType === "PERPETUAL") {
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

  return {
    exchange: "binance",
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
    priceStep,
    amountStep,
    minAmount: lotSizeFilter?.minQty,
    minNotional: notionalFilter?.minNotional ?? notionalFilter?.notional,
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

  return {
    exchange: "binance",
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
    contractSize,
    pricePrecision: precisionFromStep(priceStep),
    amountPrecision: precisionFromStep(amountStep),
    priceStep,
    amountStep,
    minAmount: lotSizeFilter?.minQty,
    minNotional: notionalFilter?.minNotional ?? notionalFilter?.notional,
    expiry: type === "future" ? symbol.deliveryDate : undefined,
    raw: toRecord(symbol),
  };
}

async function fetchJson<T>(fetchFn: FetchLike, url: string): Promise<T> {
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(
      `Binance request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
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
): Promise<BinanceMarketDefinition[]> {
  const [spot, usdm, coinm] = await Promise.all([
    fetchJson<BinanceSpotExchangeInfo>(fetchFn, BINANCE_SPOT_EXCHANGE_INFO_URL),
    fetchJson<BinanceDerivativesExchangeInfo>(
      fetchFn,
      BINANCE_USDM_EXCHANGE_INFO_URL,
    ),
    fetchJson<BinanceDerivativesExchangeInfo>(
      fetchFn,
      BINANCE_COINM_EXCHANGE_INFO_URL,
    ),
  ]);

  return sortMarkets([
    ...(spot.symbols ?? []).map(normalizeSpotSymbol),
    ...(usdm.symbols ?? []).map((symbol) =>
      normalizeDerivativesSymbol(symbol, "usdm"),
    ),
    ...(coinm.symbols ?? []).map((symbol) =>
      normalizeDerivativesSymbol(symbol, "coinm"),
    ),
  ]);
}
