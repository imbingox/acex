import {
  type HttpClientMessages,
  httpRequest,
  isTransportError,
} from "../../internal/http-client.ts";
import type {
  RateLimiter,
  RateLimitScope,
  VenueServerTime,
} from "../../types/index.ts";
import { parseBinanceRateLimitUsage } from "./rate-limit.ts";
import { getBinanceServerTimeRateLimitPlanId } from "./rate-limit-topology.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface BinanceServerTimeResponse {
  serverTime?: unknown;
}

export interface FetchBinanceServerTimeOptions {
  readonly rateLimiter?: RateLimiter;
  readonly fetchFn?: FetchLike;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
}

const BINANCE_USDM_SERVER_TIME_URL = "https://fapi.binance.com/fapi/v1/time";
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const BINANCE_SERVER_TIME_HTTP_MESSAGES: HttpClientMessages = {
  http: ({ status, statusText }) =>
    `Binance server time request failed: ${status} ${statusText ?? ""}`,
};

export async function fetchBinanceServerTime(
  options: FetchBinanceServerTimeOptions = {},
): Promise<VenueServerTime> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const scope: RateLimitScope = {
    venue: "binance",
    endpointKey: "GET /fapi/v1/time",
  };
  const requestContext = {
    scope,
    planId: getBinanceServerTimeRateLimitPlanId(),
  };

  const reservation =
    (await options.rateLimiter?.beforeRequest(requestContext)) ?? undefined;

  const requestSentAt = now();
  const startMono = monotonicNow();

  try {
    const response = await httpRequest<BinanceServerTimeResponse>({
      fetchFn,
      url: BINANCE_USDM_SERVER_TIME_URL,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      parseAs: "json",
      jsonParseMode: "response",
      retryPolicy: {
        idempotent: true,
        maxAttempts: 1,
      },
      messages: BINANCE_SERVER_TIME_HTTP_MESSAGES,
    });
    const responseReceivedAt = now();
    const endMono = monotonicNow();

    await options.rateLimiter?.afterResponse(requestContext, {
      status: response.status,
      headers: response.headers,
      usage: parseBinanceRateLimitUsage(response.headers),
      reservation,
    });

    const { serverTime } = response.body;
    if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) {
      throw new Error(
        "Binance server time response missing numeric serverTime",
      );
    }

    return {
      serverTime,
      requestSentAt,
      responseReceivedAt,
      roundTripMs: endMono - startMono,
      estimatedOffsetMs: serverTime - (requestSentAt + responseReceivedAt) / 2,
    };
  } catch (error) {
    if (isTransportError(error)) {
      await options.rateLimiter?.onTransportError(requestContext, {
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
