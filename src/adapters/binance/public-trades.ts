import {
  type HttpClientMessages,
  httpRequest,
  isTransportError,
} from "../../internal/http-client.ts";
import type { RateLimiter, RateLimitScope } from "../../types/index.ts";
import type {
  FetchPublicRawTradesRequest,
  RawPublicTrade,
  RawPublicTradesResult,
} from "../types.ts";
import type {
  BinanceMarketDefinition,
  BinanceMarketFamily,
} from "./market-catalog.ts";
import { parseBinanceRateLimitUsage } from "./rate-limit.ts";
import { getBinancePublicMarketRateLimitPlanId } from "./rate-limit-topology.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type BinancePublicTradeEndpointKind = "aggTrades" | "historicalTrades";

interface BinancePublicTradeEndpoint {
  readonly baseUrl: string;
  readonly path: string;
  readonly endpointKey: string;
}

interface FetchBinancePublicRawTradesOptions {
  readonly rateLimiter?: RateLimiter;
  readonly fetchFn?: FetchLike;
  readonly now?: () => number;
}

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_PUBLIC_RAW_TRADES_LIMIT = 10_000;
const MAX_PUBLIC_RAW_TRADE_PAGES = 1_000;
const BINANCE_AGG_TRADES_PAGE_LIMIT = 1_000;
const BINANCE_SPOT_RAW_TRADES_PAGE_LIMIT = 1_000;
const BINANCE_DERIVATIVES_RAW_TRADES_PAGE_LIMIT = 500;
const BINANCE_PUBLIC_TRADES_HTTP_MESSAGES: HttpClientMessages = {
  http: ({ status, statusText }) =>
    `Binance public trades request failed: ${status} ${statusText ?? ""}`,
};

export async function fetchBinancePublicRawTrades(
  market: BinanceMarketDefinition,
  request: FetchPublicRawTradesRequest,
  options: FetchBinancePublicRawTradesOptions = {},
): Promise<RawPublicTradesResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const firstRawTradeId = await findFirstRawTradeId(market, request, {
    ...options,
    fetchFn,
  });

  if (!firstRawTradeId) {
    return {
      trades: [],
      truncated: false,
    };
  }

  const outputLimit = request.limit ?? DEFAULT_PUBLIC_RAW_TRADES_LIMIT;
  const rawPageLimit = rawTradesPageLimit(market.family);
  const trades: RawPublicTrade[] = [];
  let fromId = firstRawTradeId;
  let nextFromId: string | undefined = firstRawTradeId;
  let endedByTime = false;
  let stoppedByPageGuard = false;

  for (let pageCount = 0; trades.length < outputLimit; pageCount += 1) {
    if (pageCount >= MAX_PUBLIC_RAW_TRADE_PAGES) {
      stoppedByPageGuard = true;
      break;
    }

    const pageLimit = Math.min(rawPageLimit, outputLimit - trades.length);
    const rawPage = await requestHistoricalTrades(market, {
      fetchFn,
      rateLimiter: options.rateLimiter,
      fromId,
      limit: pageLimit,
    });
    const receivedAt = now();

    if (rawPage.length === 0) {
      nextFromId = undefined;
      break;
    }

    let lastTradeId: string | undefined;
    for (const rawTrade of rawPage) {
      const trade = normalizeRawTrade(rawTrade, receivedAt);
      lastTradeId = trade.id;

      if (trade.exchangeTs < request.startTs) {
        continue;
      }

      if (request.endTs !== undefined && trade.exchangeTs >= request.endTs) {
        endedByTime = true;
        break;
      }

      trades.push(trade);
      if (trades.length >= outputLimit) {
        break;
      }
    }

    if (!lastTradeId) {
      nextFromId = undefined;
      break;
    }

    nextFromId = incrementNumericId(lastTradeId);
    if (!nextFromId || endedByTime) {
      break;
    }

    fromId = nextFromId;

    if (rawPage.length < pageLimit) {
      nextFromId = undefined;
      break;
    }
  }

  const hitLimit = trades.length >= outputLimit;
  const truncated =
    stoppedByPageGuard ||
    (hitLimit && !endedByTime && nextFromId !== undefined);

  return {
    trades,
    truncated,
    ...(truncated && nextFromId ? { nextFromId } : {}),
  };
}

async function findFirstRawTradeId(
  market: BinanceMarketDefinition,
  request: FetchPublicRawTradesRequest,
  options: FetchBinancePublicRawTradesOptions & { readonly fetchFn: FetchLike },
): Promise<string | undefined> {
  const endTime =
    request.endTs === undefined ? undefined : Math.max(0, request.endTs - 1);
  const aggTrades = await requestAggregateTrades(market, {
    fetchFn: options.fetchFn,
    rateLimiter: options.rateLimiter,
    startTime: request.startTs,
    endTime,
    limit: 1,
  });

  const first = aggTrades[0];
  if (!first) {
    return undefined;
  }

  return readNumericId(first, "f", "Binance aggregate trade first raw id");
}

async function requestAggregateTrades(
  market: BinanceMarketDefinition,
  input: {
    readonly fetchFn: FetchLike;
    readonly rateLimiter?: RateLimiter;
    readonly startTime: number;
    readonly endTime?: number;
    readonly limit: number;
  },
): Promise<Record<string, unknown>[]> {
  const endpoint = endpointForFamily(market.family, "aggTrades");
  const response = await requestBinancePublicMarketJson({
    endpoint,
    fetchFn: input.fetchFn,
    rateLimiter: input.rateLimiter,
    query: {
      symbol: market.id,
      startTime: input.startTime,
      endTime: input.endTime,
      limit: Math.min(input.limit, BINANCE_AGG_TRADES_PAGE_LIMIT),
    },
  });

  return readRecordArray(response, "Binance aggregate trades response");
}

async function requestHistoricalTrades(
  market: BinanceMarketDefinition,
  input: {
    readonly fetchFn: FetchLike;
    readonly rateLimiter?: RateLimiter;
    readonly fromId: string;
    readonly limit: number;
  },
): Promise<Record<string, unknown>[]> {
  const endpoint = endpointForFamily(market.family, "historicalTrades");
  const response = await requestBinancePublicMarketJson({
    endpoint,
    fetchFn: input.fetchFn,
    rateLimiter: input.rateLimiter,
    query: {
      symbol: market.id,
      fromId: input.fromId,
      limit: input.limit,
    },
  });

  return readRecordArray(response, "Binance historical trades response");
}

async function requestBinancePublicMarketJson(input: {
  readonly endpoint: BinancePublicTradeEndpoint;
  readonly fetchFn: FetchLike;
  readonly rateLimiter?: RateLimiter;
  readonly query: Record<string, string | number | undefined>;
}): Promise<unknown> {
  const url = new URL(`${input.endpoint.baseUrl}${input.endpoint.path}`);
  for (const [key, value] of Object.entries(input.query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const scope: RateLimitScope = {
    venue: "binance",
    endpointKey: input.endpoint.endpointKey,
  };
  const requestContext = {
    scope,
    planId: getBinancePublicMarketRateLimitPlanId("GET", input.endpoint.path),
  };
  const reservation =
    (await input.rateLimiter?.beforeRequest(requestContext)) ?? undefined;

  try {
    const response = await httpRequest<unknown>({
      fetchFn: input.fetchFn,
      url,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      parseAs: "json",
      jsonParseMode: "response",
      retryPolicy: {
        idempotent: true,
        maxAttempts: 1,
      },
      messages: BINANCE_PUBLIC_TRADES_HTTP_MESSAGES,
    });

    await input.rateLimiter?.afterResponse(requestContext, {
      status: response.status,
      headers: response.headers,
      usage: parseBinanceRateLimitUsage(response.headers),
      reservation,
    });

    return response.body;
  } catch (error) {
    if (isTransportError(error)) {
      await input.rateLimiter?.onTransportError(requestContext, {
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

function endpointForFamily(
  family: BinanceMarketFamily,
  kind: BinancePublicTradeEndpointKind,
): BinancePublicTradeEndpoint {
  switch (family) {
    case "spot":
      return {
        baseUrl: "https://api.binance.com",
        path:
          kind === "aggTrades"
            ? "/api/v3/aggTrades"
            : "/api/v3/historicalTrades",
        endpointKey:
          kind === "aggTrades"
            ? "GET /api/v3/aggTrades"
            : "GET /api/v3/historicalTrades",
      };
    case "usdm":
      return {
        baseUrl: "https://fapi.binance.com",
        path:
          kind === "aggTrades"
            ? "/fapi/v1/aggTrades"
            : "/fapi/v1/historicalTrades",
        endpointKey:
          kind === "aggTrades"
            ? "GET /fapi/v1/aggTrades"
            : "GET /fapi/v1/historicalTrades",
      };
    case "coinm":
      return {
        baseUrl: "https://dapi.binance.com",
        path:
          kind === "aggTrades"
            ? "/dapi/v1/aggTrades"
            : "/dapi/v1/historicalTrades",
        endpointKey:
          kind === "aggTrades"
            ? "GET /dapi/v1/aggTrades"
            : "GET /dapi/v1/historicalTrades",
      };
  }
}

function rawTradesPageLimit(family: BinanceMarketFamily): number {
  return family === "spot"
    ? BINANCE_SPOT_RAW_TRADES_PAGE_LIMIT
    : BINANCE_DERIVATIVES_RAW_TRADES_PAGE_LIMIT;
}

function normalizeRawTrade(
  rawTrade: Record<string, unknown>,
  receivedAt: number,
): RawPublicTrade {
  const isBuyerMaker = rawTrade.isBuyerMaker;

  return {
    id: readNumericId(rawTrade, "id", "Binance raw trade id"),
    price: readDecimalString(rawTrade, "price", "Binance raw trade price"),
    amount: readDecimalString(rawTrade, "qty", "Binance raw trade quantity"),
    cost: readOptionalDecimalString(rawTrade, "quoteQty"),
    side:
      typeof isBuyerMaker === "boolean"
        ? isBuyerMaker
          ? "sell"
          : "buy"
        : undefined,
    exchangeTs: readTimestampMs(rawTrade, "time", "Binance raw trade time"),
    receivedAt,
    raw: { ...rawTrade },
  };
}

function readRecordArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} item ${index} must be an object`);
    }

    return entry as Record<string, unknown>;
  });
}

function readNumericId(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return value;
  }

  throw new Error(`${label} missing non-negative integer ${key}`);
}

function readDecimalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new Error(`${label} missing decimal ${key}`);
}

function readOptionalDecimalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  return readDecimalString(record, key, `Binance raw trade ${key}`);
}

function readTimestampMs(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  throw new Error(`${label} missing epoch millisecond ${key}`);
}

function incrementNumericId(value: string): string | undefined {
  try {
    return (BigInt(value) + 1n).toString();
  } catch {
    return undefined;
  }
}
