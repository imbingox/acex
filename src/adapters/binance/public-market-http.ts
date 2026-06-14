import {
  type HttpClientMessages,
  httpRequest,
  isTransportError,
} from "../../internal/http-client.ts";
import type { RateLimiter, RateLimitScope } from "../../types/index.ts";
import { parseBinanceRateLimitUsage } from "./rate-limit.ts";
import { getBinancePublicMarketRateLimitPlanId } from "./rate-limit-topology.ts";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BinancePublicMarketEndpoint {
  readonly baseUrl: string;
  readonly path: string;
  readonly endpointKey: string;
}

export interface RequestBinancePublicMarketJsonInput {
  readonly endpoint: BinancePublicMarketEndpoint;
  readonly fetchFn: FetchLike;
  readonly rateLimiter?: RateLimiter;
  readonly query: Record<string, string | number | undefined>;
  readonly headers?: RequestInit["headers"];
  readonly messages: HttpClientMessages;
}

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export async function requestBinancePublicMarketJson(
  input: RequestBinancePublicMarketJsonInput,
): Promise<unknown> {
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
      headers: input.headers,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      parseAs: "json",
      jsonParseMode: "response",
      retryPolicy: {
        idempotent: true,
        maxAttempts: 1,
      },
      messages: input.messages,
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
