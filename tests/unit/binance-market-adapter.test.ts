import { expect, test } from "bun:test";
import { BinanceMarketAdapter } from "../../src/adapters/binance/adapter.ts";
import { loadBinanceMarkets } from "../../src/adapters/binance/market-catalog.ts";
import { fetchBinanceServerTime } from "../../src/adapters/binance/server-time.ts";
import type { L1BookStreamCallbacks } from "../../src/adapters/types.ts";
import { isTransportError } from "../../src/internal/http-client.ts";
import type { RateLimiter } from "../../src/types/index.ts";
import { installBinanceMarketInfra } from "../support/exchanges/binance.ts";
import { jsonResponse, textResponse } from "../support/test-utils.ts";

const callbacks: L1BookStreamCallbacks = {
  onUpdate(): void {},
  onFreshnessChange(): void {},
  onDisconnected(): void {},
  onError(): void {},
};

test("BinanceMarketAdapter rejects stream timing option changes after multiplexer creation", async () => {
  installBinanceMarketInfra();
  const adapter = new BinanceMarketAdapter();
  const markets = await adapter.loadMarkets();
  const market = markets.find((entry) => entry.symbol === "BTC/USDT:USDT");
  if (!market) {
    throw new Error("Expected BTC/USDT:USDT market");
  }

  const now = (): number => 1;
  const handle = adapter.createL1BookStream(market, callbacks, {
    initialMessageTimeoutMs: 1_000,
    staleAfterMs: 1_000,
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    now,
  });

  try {
    expect(() =>
      adapter.createL1BookStream(market, callbacks, {
        initialMessageTimeoutMs: 1_000,
        staleAfterMs: 1_000,
        reconnectDelayMs: 10,
        reconnectMaxDelayMs: 10,
        now: (): number => 1,
      }),
    ).toThrow("stream options differ from the active multiplexer");
  } finally {
    handle.close();
  }
});

test("fetchBinanceServerTime parses USDM time and uses monotonic RTT", async () => {
  const requestedUrls: string[] = [];
  const wallTimes = [1_000, 1_040];
  const monotonicTimes = [10, 17];

  const result = await fetchBinanceServerTime({
    fetchFn: async (input) => {
      requestedUrls.push(input.toString());
      return jsonResponse({ serverTime: 2_000 });
    },
    now: () => wallTimes.shift() ?? 0,
    monotonicNow: () => monotonicTimes.shift() ?? 0,
  });

  expect(requestedUrls).toEqual(["https://fapi.binance.com/fapi/v1/time"]);
  expect(result).toEqual({
    serverTime: 2_000,
    requestSentAt: 1_000,
    responseReceivedAt: 1_040,
    roundTripMs: 7,
    estimatedOffsetMs: 980,
  });
});

test("fetchBinanceServerTime does not retry HTTP failures", async () => {
  let attempts = 0;

  const error = await fetchBinanceServerTime({
    fetchFn: async () => {
      attempts += 1;
      return textResponse("binance down", {
        status: 503,
        statusText: "Service Unavailable",
      });
    },
    now: () => 1_000,
    monotonicNow: () => 10,
  }).catch((caught: unknown) => caught);

  expect(attempts).toBe(1);
  expect(isTransportError(error)).toBe(true);
  if (!isTransportError(error)) {
    throw new Error("Expected TransportError");
  }
  expect(error.attempts).toBe(1);
  expect(error.kind).toBe("http");
});

test("loadBinanceMarkets does not retry catalog HTTP failures", async () => {
  let attempts = 0;

  const error = await loadBinanceMarkets(async () => {
    attempts += 1;
    return textResponse("binance down", {
      status: 503,
      statusText: "Service Unavailable",
    });
  }).catch((caught: unknown) => caught);

  expect(attempts).toBe(3);
  expect(isTransportError(error)).toBe(true);
  if (!isTransportError(error)) {
    throw new Error("Expected TransportError");
  }
  expect(error.attempts).toBe(1);
  expect(error.kind).toBe("http");
});

test("fetchBinanceServerTime rejects missing or non-number serverTime with plain Error", async () => {
  for (const body of [{}, { serverTime: "1710000000000" }]) {
    const error = await fetchBinanceServerTime({
      fetchFn: async () => jsonResponse(body),
      now: () => 1_000,
      monotonicNow: () => 10,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(isTransportError(error)).toBe(false);
    expect((error as Error).message).toContain("serverTime");
  }
});

test("fetchBinanceServerTime samples timestamps after limiter and before HTTP", async () => {
  const order: string[] = [];
  const rateLimiter: RateLimiter = {
    beforeRequest(): void {
      order.push("beforeRequest");
    },
    afterResponse(): void {
      order.push("afterResponse");
    },
    onTransportError(): void {
      order.push("onTransportError");
    },
    getSnapshot(): undefined {
      return undefined;
    },
  };

  await fetchBinanceServerTime({
    rateLimiter,
    fetchFn: async () => {
      order.push("httpRequest");
      return jsonResponse({ serverTime: 2_000 });
    },
    now: () => {
      order.push("wallClock");
      return order.filter((entry) => entry === "wallClock").length === 1
        ? 1_000
        : 1_020;
    },
    monotonicNow: () => {
      order.push("monotonicClock");
      return order.filter((entry) => entry === "monotonicClock").length === 1
        ? 5
        : 8;
    },
  });

  expect(order).toEqual([
    "beforeRequest",
    "wallClock",
    "monotonicClock",
    "httpRequest",
    "wallClock",
    "monotonicClock",
    "afterResponse",
  ]);
});
