import type { HttpClientMessages } from "../../internal/http-client.ts";
import type { RateLimiter } from "../../types/index.ts";
import type {
  FetchFundingRateHistoryRequest,
  RawFundingRateHistoryEntry,
  RawFundingRateHistoryResult,
} from "../types.ts";
import type {
  BinanceMarketDefinition,
  BinanceMarketFamily,
} from "./market-catalog.ts";
import {
  type BinancePublicMarketEndpoint,
  type FetchLike,
  requestBinancePublicMarketJson,
} from "./public-market-http.ts";

interface FetchBinanceFundingRateHistoryOptions {
  readonly rateLimiter?: RateLimiter;
  readonly fetchFn?: FetchLike;
  readonly now?: () => number;
}

const BINANCE_FUNDING_RATE_HISTORY_HTTP_MESSAGES: HttpClientMessages = {
  http: ({ status, statusText }) =>
    `Binance funding rate history request failed: ${status} ${statusText ?? ""}`,
};

export async function fetchBinanceFundingRateHistory(
  market: BinanceMarketDefinition,
  request: FetchFundingRateHistoryRequest,
  options: FetchBinanceFundingRateHistoryOptions = {},
): Promise<RawFundingRateHistoryResult> {
  if (!market.contract || market.type !== "swap") {
    throw new Error(
      `Binance funding rate history is only supported for perpetual futures: ${market.symbol}`,
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const endpoint = endpointForFamily(market.family);
  const response = await requestBinancePublicMarketJson({
    endpoint,
    fetchFn,
    rateLimiter: options.rateLimiter,
    messages: BINANCE_FUNDING_RATE_HISTORY_HTTP_MESSAGES,
    query: {
      symbol: market.id,
      startTime: request.startTs,
      endTime: request.endTs,
      limit: request.limit,
    },
  });
  const receivedAt = now();
  const rates = readRecordArray(
    response,
    "Binance funding rate history response",
  ).map((entry) => normalizeFundingRateHistoryEntry(entry, receivedAt));

  return {
    rates,
    truncated: request.limit !== undefined && rates.length >= request.limit,
  };
}

function endpointForFamily(
  family: BinanceMarketFamily,
): BinancePublicMarketEndpoint {
  switch (family) {
    case "spot":
      throw new Error(
        "Binance spot markets do not support funding rate history",
      );
    case "usdm":
      return {
        baseUrl: "https://fapi.binance.com",
        path: "/fapi/v1/fundingRate",
        endpointKey: "GET /fapi/v1/fundingRate",
      };
    case "coinm":
      return {
        baseUrl: "https://dapi.binance.com",
        path: "/dapi/v1/fundingRate",
        endpointKey: "GET /dapi/v1/fundingRate",
      };
  }
}

function normalizeFundingRateHistoryEntry(
  rawEntry: Record<string, unknown>,
  receivedAt: number,
): RawFundingRateHistoryEntry {
  return {
    fundingRate: readDecimalString(
      rawEntry,
      "fundingRate",
      "Binance funding rate history fundingRate",
    ),
    fundingTime: readTimestampMs(
      rawEntry,
      "fundingTime",
      "Binance funding rate history fundingTime",
    ),
    markPrice: readOptionalDecimalString(rawEntry, "markPrice"),
    receivedAt,
    raw: { ...rawEntry },
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

  return readDecimalString(record, key, `Binance funding rate history ${key}`);
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
