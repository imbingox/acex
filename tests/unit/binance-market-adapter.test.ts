import { expect, test } from "bun:test";
import { BinanceMarketAdapter } from "../../src/adapters/binance/adapter.ts";
import {
  type BinanceMarketDefinition,
  loadBinanceMarkets,
} from "../../src/adapters/binance/market-catalog.ts";
import { fetchBinancePublicRawTrades } from "../../src/adapters/binance/public-trades.ts";
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

const binanceUsdmMarket: BinanceMarketDefinition = {
  venue: "binance",
  family: "usdm",
  symbol: "BTC/USDT:USDT",
  id: "BTCUSDT",
  type: "swap",
  base: "BTC",
  quote: "USDT",
  settle: "USDT",
  active: true,
  contract: true,
  linear: true,
  contractSize: "1",
  pricePrecision: 1,
  amountPrecision: 3,
  priceStep: "0.1",
  amountStep: "0.001",
  raw: {},
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

test("fetchBinancePublicRawTrades locates raw ids with aggTrades and filters by raw trade time", async () => {
  const requestedUrls: string[] = [];
  const result = await fetchBinancePublicRawTrades(
    binanceUsdmMarket,
    {
      startTs: 1_000,
      endTs: 2_000,
    },
    {
      now: () => 5_000,
      fetchFn: async (input) => {
        const url = input.toString();
        requestedUrls.push(url);
        const parsed = new URL(url);

        if (parsed.pathname === "/fapi/v1/aggTrades") {
          expect(parsed.searchParams.get("symbol")).toBe("BTCUSDT");
          expect(parsed.searchParams.get("startTime")).toBe("1000");
          expect(parsed.searchParams.get("endTime")).toBe("1999");
          expect(parsed.searchParams.get("limit")).toBe("1");
          return jsonResponse([
            {
              a: 10,
              p: "100.10",
              q: "0.010",
              f: 100,
              l: 102,
              T: 1_000,
              m: false,
            },
          ]);
        }

        if (parsed.pathname === "/fapi/v1/historicalTrades") {
          expect(parsed.searchParams.get("symbol")).toBe("BTCUSDT");
          expect(parsed.searchParams.get("fromId")).toBe("100");
          expect(parsed.searchParams.get("limit")).toBe("500");
          return jsonResponse([
            {
              id: 100,
              price: "100.10",
              qty: "0.010",
              quoteQty: "1.001",
              time: 1_000,
              isBuyerMaker: false,
            },
            {
              id: 101,
              price: "100.20",
              qty: "0.020",
              quoteQty: "2.004",
              time: 1_999,
              isBuyerMaker: true,
            },
            {
              id: 102,
              price: "100.30",
              qty: "0.030",
              quoteQty: "3.009",
              time: 2_000,
              isBuyerMaker: false,
            },
          ]);
        }

        throw new Error(`Unexpected URL: ${url}`);
      },
    },
  );

  expect(requestedUrls).toHaveLength(2);
  expect(result).toEqual({
    trades: [
      {
        id: "100",
        price: "100.10",
        amount: "0.010",
        cost: "1.001",
        side: "buy",
        exchangeTs: 1_000,
        receivedAt: 5_000,
        raw: {
          id: 100,
          price: "100.10",
          qty: "0.010",
          quoteQty: "1.001",
          time: 1_000,
          isBuyerMaker: false,
        },
      },
      {
        id: "101",
        price: "100.20",
        amount: "0.020",
        cost: "2.004",
        side: "sell",
        exchangeTs: 1_999,
        receivedAt: 5_000,
        raw: {
          id: 101,
          price: "100.20",
          qty: "0.020",
          quoteQty: "2.004",
          time: 1_999,
          isBuyerMaker: true,
        },
      },
    ],
    truncated: false,
  });
});

test("fetchBinancePublicRawTrades returns nextFromId when the requested limit is reached", async () => {
  const historicalFromIds: string[] = [];
  const result = await fetchBinancePublicRawTrades(
    binanceUsdmMarket,
    {
      startTs: 1_000,
      limit: 2,
    },
    {
      now: () => 5_000,
      fetchFn: async (input) => {
        const parsed = new URL(input.toString());

        if (parsed.pathname === "/fapi/v1/aggTrades") {
          expect(parsed.searchParams.get("endTime")).toBeNull();
          return jsonResponse([{ f: "100", l: "102", T: 1_000 }]);
        }

        if (parsed.pathname === "/fapi/v1/historicalTrades") {
          historicalFromIds.push(parsed.searchParams.get("fromId") ?? "");
          expect(parsed.searchParams.get("limit")).toBe("2");
          return jsonResponse([
            {
              id: 100,
              price: "100.10",
              qty: "0.010",
              time: 1_000,
              isBuyerMaker: false,
            },
            {
              id: 101,
              price: "100.20",
              qty: "0.020",
              time: 1_001,
              isBuyerMaker: true,
            },
          ]);
        }

        throw new Error(`Unexpected URL: ${parsed.toString()}`);
      },
    },
  );

  expect(historicalFromIds).toEqual(["100"]);
  expect(result.trades.map((trade) => trade.id)).toEqual(["100", "101"]);
  expect(result).toMatchObject({
    truncated: true,
    nextFromId: "102",
  });
});

test("fetchBinancePublicRawTrades returns an empty result when no aggregate trade covers the window", async () => {
  const requestedPaths: string[] = [];
  const result = await fetchBinancePublicRawTrades(
    binanceUsdmMarket,
    {
      startTs: 1_000,
      endTs: 2_000,
    },
    {
      fetchFn: async (input) => {
        const parsed = new URL(input.toString());
        requestedPaths.push(parsed.pathname);
        return jsonResponse([]);
      },
    },
  );

  expect(requestedPaths).toEqual(["/fapi/v1/aggTrades"]);
  expect(result).toEqual({
    trades: [],
    truncated: false,
  });
});
