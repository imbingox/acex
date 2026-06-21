import { toCanonical } from "../../internal/decimal.ts";
import {
  type HttpClientMessages,
  httpRequest,
  isTransportError,
} from "../../internal/http-client.ts";
import type {
  OptionMarketDefinition,
  RateLimiter,
  RateLimitScope,
} from "../../types/index.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface DeribitGetInstrumentsResponse {
  result?: unknown;
  error?: {
    code?: number | string;
    message?: string;
  };
}

const DERIBIT_GET_INSTRUMENTS_URL =
  "https://www.deribit.com/api/v2/public/get_instruments";
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DERIBIT_OPTION_UNDERLYINGS = ["BTC"] as const;
const DERIBIT_GET_INSTRUMENTS_ENDPOINT_KEY =
  "GET /api/v2/public/get_instruments";
const DERIBIT_CATALOG_HTTP_MESSAGES: HttpClientMessages = {
  http: ({ status, statusText }) =>
    `Deribit request failed: ${status} ${statusText ?? ""}`,
};

export interface DeribitMarketCatalogOptions {
  readonly underlyings?: readonly string[];
  readonly fetchFn?: FetchLike;
  readonly rateLimiter?: RateLimiter;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Deribit instrument is missing string field: ${field}`);
  }

  return value.trim();
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Deribit instrument is missing number field: ${field}`);
  }

  return value;
}

function requireBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`Deribit instrument is missing boolean field: ${field}`);
  }

  return value;
}

function precisionFromStep(step: string): number {
  const normalized = step.replace(/0+$/, "");
  const dotIndex = normalized.indexOf(".");
  if (dotIndex === -1) {
    return 0;
  }

  return normalized.length - dotIndex - 1;
}

function formatExpiryDate(expiry: number): string {
  const date = new Date(expiry);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
}

function sortOptionMarkets(
  markets: OptionMarketDefinition[],
): OptionMarketDefinition[] {
  return [...markets].sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  );
}

export function normalizeDeribitUnderlyings(
  underlyings?: readonly string[],
): string[] {
  const input = underlyings ?? DERIBIT_OPTION_UNDERLYINGS;
  const normalized = new Set<string>();

  for (const underlying of input) {
    const value = String(underlying).trim().toUpperCase();
    if (value) {
      normalized.add(value);
    }
  }

  if (normalized.size === 0) {
    throw new Error(
      "Deribit market.venues.deribit.underlyings must not be empty",
    );
  }

  return [...normalized];
}

export function normalizeDeribitOptionInstrument(
  input: unknown,
): OptionMarketDefinition {
  const raw = toRecord(input);
  const instrumentName = requireString(raw, "instrument_name");
  const base = requireString(raw, "base_currency").toUpperCase();
  const strikeCurrency = requireString(raw, "counter_currency").toUpperCase();
  const premiumCurrency = requireString(raw, "quote_currency").toUpperCase();
  const settle = requireString(raw, "settlement_currency").toUpperCase();
  const expiry = requireNumber(raw, "expiration_timestamp");
  const strike = toCanonical(requireNumber(raw, "strike"));
  const rawOptionType = requireString(raw, "option_type").toLowerCase();
  const optionType =
    rawOptionType === "call"
      ? "call"
      : rawOptionType === "put"
        ? "put"
        : undefined;
  if (!optionType) {
    throw new Error(`Unsupported Deribit option type: ${rawOptionType}`);
  }

  const contractSize = toCanonical(requireNumber(raw, "contract_size"));
  const priceStep = toCanonical(requireNumber(raw, "tick_size"));
  const amountStep = toCanonical(requireNumber(raw, "min_trade_amount"));
  const state = raw.state;
  const active =
    requireBoolean(raw, "is_active") &&
    (state === undefined || state === "open");
  const instrumentType =
    typeof raw.instrument_type === "string" ? raw.instrument_type : undefined;
  const optionTypeSuffix = optionType === "call" ? "C" : "P";

  return {
    venue: "deribit",
    symbol: `${base}/${strikeCurrency}:${settle}-${formatExpiryDate(expiry)}-${strike}-${optionTypeSuffix}`,
    id: instrumentName,
    type: "option",
    base,
    quote: strikeCurrency,
    settle,
    active,
    contract: true,
    linear: instrumentType === "linear",
    inverse: instrumentType === "reversed",
    contractSize,
    pricePrecision: precisionFromStep(priceStep),
    amountPrecision: precisionFromStep(amountStep),
    priceStep,
    amountStep,
    minAmount: amountStep,
    expiry,
    raw,
    underlying: base,
    strike,
    strikeCurrency,
    optionType,
    premiumCurrency,
  };
}

export async function loadDeribitOptionMarkets(
  fetchFn: FetchLike = fetch,
  options: {
    readonly underlyings?: readonly string[];
    readonly rateLimiter?: RateLimiter;
  } = {},
): Promise<OptionMarketDefinition[]> {
  const markets = await Promise.all(
    normalizeDeribitUnderlyings(options.underlyings).map((underlying) =>
      loadDeribitOptionUnderlying(underlying, fetchFn, options.rateLimiter),
    ),
  );

  return sortOptionMarkets(markets.flat());
}

async function loadDeribitOptionUnderlying(
  underlying: string,
  fetchFn: FetchLike,
  rateLimiter: RateLimiter | undefined,
): Promise<OptionMarketDefinition[]> {
  const url = new URL(DERIBIT_GET_INSTRUMENTS_URL);
  url.searchParams.set("currency", underlying);
  url.searchParams.set("kind", "option");

  const response = await requestDeribitJson<DeribitGetInstrumentsResponse>(
    fetchFn,
    url,
    rateLimiter,
  );

  if (response.error) {
    throw new Error(
      `Deribit get_instruments failed for ${underlying}: ${response.error.message ?? response.error.code ?? "unknown error"}`,
    );
  }

  if (!Array.isArray(response.result)) {
    throw new Error(
      `Deribit get_instruments returned invalid result for ${underlying}`,
    );
  }

  if (response.result.length === 0) {
    throw new Error(
      `Deribit get_instruments returned no option instruments for ${underlying}`,
    );
  }

  return response.result.map(normalizeDeribitOptionInstrument);
}

async function requestDeribitJson<T>(
  fetchFn: FetchLike,
  url: URL,
  rateLimiter: RateLimiter | undefined,
): Promise<T> {
  const scope: RateLimitScope = {
    venue: "deribit",
    endpointKey: DERIBIT_GET_INSTRUMENTS_ENDPOINT_KEY,
  };
  const requestContext = { scope };
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
      messages: DERIBIT_CATALOG_HTTP_MESSAGES,
    });

    await rateLimiter?.afterResponse(requestContext, {
      status: response.status,
      headers: response.headers,
      reservation,
    });

    return response.body;
  } catch (error) {
    if (isTransportError(error)) {
      await rateLimiter?.onTransportError(requestContext, {
        status: error.status,
        headers: error.headers,
        retryAfterMs: error.retryAfterMs,
        reservation,
      });
    }

    throw error;
  }
}

export class DeribitMarketCatalog {
  private readonly fetchFn: FetchLike;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly underlyings: string[];
  private readonly definitionsBySymbol = new Map<
    string,
    OptionMarketDefinition
  >();

  constructor(options: DeribitMarketCatalogOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.rateLimiter = options.rateLimiter;
    this.underlyings = normalizeDeribitUnderlyings(options.underlyings);
  }

  async loadAll(): Promise<OptionMarketDefinition[]> {
    const markets = await loadDeribitOptionMarkets(this.fetchFn, {
      underlyings: this.underlyings,
      rateLimiter: this.rateLimiter,
    });
    this.definitionsBySymbol.clear();
    for (const market of markets) {
      this.definitionsBySymbol.set(market.symbol, market);
    }

    return markets;
  }

  getDefinition(symbol: string): OptionMarketDefinition | undefined {
    return this.definitionsBySymbol.get(symbol);
  }
}
