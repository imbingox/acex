import { expect, test } from "bun:test";
import { BinanceMarketAdapter } from "../../src/adapters/binance/adapter.ts";
import { fetchBinanceFundingRateHistory } from "../../src/adapters/binance/funding-history.ts";
import {
  type BinanceMarketDefinition,
  loadBinanceMarkets,
} from "../../src/adapters/binance/market-catalog.ts";
import {
  fetchBinancePublicRawTrades,
  fetchBinancePublicTrades,
} from "../../src/adapters/binance/public-trades.ts";
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

const binanceCoinmMarket: BinanceMarketDefinition = {
  venue: "binance",
  family: "coinm",
  symbol: "BTC/USD:BTC",
  id: "BTCUSD_PERP",
  type: "swap",
  base: "BTC",
  quote: "USD",
  settle: "BTC",
  active: true,
  contract: true,
  inverse: true,
  contractSize: "100",
  pricePrecision: 1,
  amountPrecision: 0,
  priceStep: "0.1",
  amountStep: "1",
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

test("fetchBinancePublicTrades queries aggregate trades and filters by aggregate trade time", async () => {
  const requestedUrls: string[] = [];
  const result = await fetchBinancePublicTrades(
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
          expect(parsed.searchParams.get("fromId")).toBeNull();
          expect(parsed.searchParams.get("limit")).toBe("1000");
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
            {
              a: 11,
              p: "100.20",
              q: "0.020",
              f: 103,
              l: 103,
              T: 1_999,
              m: true,
            },
            {
              a: 12,
              p: "100.30",
              q: "0.030",
              f: 104,
              l: 104,
              T: 2_000,
              m: false,
            },
          ]);
        }

        throw new Error(`Unexpected URL: ${url}`);
      },
    },
  );

  expect(requestedUrls).toHaveLength(1);
  expect(result).toEqual({
    trades: [
      {
        id: "10",
        price: "100.10",
        amount: "0.010",
        side: "buy",
        exchangeTs: 1_000,
        receivedAt: 5_000,
        raw: {
          a: 10,
          p: "100.10",
          q: "0.010",
          f: 100,
          l: 102,
          T: 1_000,
          m: false,
        },
      },
      {
        id: "11",
        price: "100.20",
        amount: "0.020",
        side: "sell",
        exchangeTs: 1_999,
        receivedAt: 5_000,
        raw: {
          a: 11,
          p: "100.20",
          q: "0.020",
          f: 103,
          l: 103,
          T: 1_999,
          m: true,
        },
      },
    ],
    truncated: false,
  });
});

test("fetchBinancePublicRawTrades requires an API key before network requests", async () => {
  let attempts = 0;

  const error = await fetchBinancePublicRawTrades(
    binanceUsdmMarket,
    {
      startTs: 1_000,
      limit: 1,
    },
    {
      fetchFn: async () => {
        attempts += 1;
        return jsonResponse([]);
      },
    },
  ).catch((caught: unknown) => caught);

  expect(attempts).toBe(0);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("market API key");
});

test("fetchBinancePublicRawTrades locates raw ids and sends the market API key", async () => {
  const requestedUrls: string[] = [];
  const historicalApiKeys: Array<string | null> = [];
  const result = await fetchBinancePublicRawTrades(
    binanceUsdmMarket,
    {
      startTs: 1_000,
      endTs: 2_000,
    },
    {
      apiKey: "market-key",
      now: () => 5_000,
      fetchFn: async (input, init) => {
        const url = input.toString();
        requestedUrls.push(url);
        const parsed = new URL(url);

        if (parsed.pathname === "/fapi/v1/aggTrades") {
          expect(parsed.searchParams.get("symbol")).toBe("BTCUSDT");
          expect(parsed.searchParams.get("startTime")).toBe("1000");
          expect(parsed.searchParams.get("endTime")).toBeNull();
          expect(parsed.searchParams.get("limit")).toBe("1");
          return jsonResponse([
            {
              a: 10,
              f: 100,
              l: 102,
              T: 1_000,
            },
          ]);
        }

        if (parsed.pathname === "/fapi/v1/historicalTrades") {
          historicalApiKeys.push(
            new Headers(init?.headers).get("X-MBX-APIKEY"),
          );
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
  expect(historicalApiKeys).toEqual(["market-key"]);
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

test("fetchBinancePublicRawTrades avoids historical request when locator is outside the requested window", async () => {
  const requestedPaths: string[] = [];
  const result = await fetchBinancePublicRawTrades(
    binanceUsdmMarket,
    {
      startTs: 1_000,
      endTs: 2_000,
    },
    {
      apiKey: "market-key",
      fetchFn: async (input) => {
        const parsed = new URL(input.toString());
        requestedPaths.push(parsed.pathname);

        if (parsed.pathname === "/fapi/v1/aggTrades") {
          expect(parsed.searchParams.get("startTime")).toBe("1000");
          expect(parsed.searchParams.get("endTime")).toBeNull();
          return jsonResponse([
            {
              a: 10,
              f: 100,
              l: 102,
              T: 2_000,
            },
          ]);
        }

        throw new Error(`Unexpected URL: ${parsed.toString()}`);
      },
    },
  );

  expect(requestedPaths).toEqual(["/fapi/v1/aggTrades"]);
  expect(result).toEqual({
    trades: [],
    truncated: false,
  });
});

test("fetchBinancePublicTrades returns aggregate nextFromId when the requested limit is reached", async () => {
  const result = await fetchBinancePublicTrades(
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
          expect(parsed.searchParams.get("limit")).toBe("2");
          return jsonResponse([
            {
              a: 100,
              p: "100.10",
              q: "0.010",
              T: 1_000,
              m: false,
            },
            {
              a: 101,
              p: "100.20",
              q: "0.020",
              T: 1_001,
              m: true,
            },
          ]);
        }

        throw new Error(`Unexpected URL: ${parsed.toString()}`);
      },
    },
  );

  expect(result.trades.map((trade) => trade.id)).toEqual(["100", "101"]);
  expect(result).toMatchObject({
    truncated: true,
    nextFromId: "102",
  });
});

test("fetchBinancePublicTrades returns an empty result when no aggregate trade covers the window", async () => {
  const requestedPaths: string[] = [];
  const result = await fetchBinancePublicTrades(
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

test("fetchBinanceFundingRateHistory queries USDM history and preserves funding time", async () => {
  const requestedUrls: string[] = [];
  const result = await fetchBinanceFundingRateHistory(
    binanceUsdmMarket,
    {
      startTs: 1_000,
      endTs: 2_000,
      limit: 2,
    },
    {
      now: () => 5_000,
      fetchFn: async (input) => {
        const url = input.toString();
        requestedUrls.push(url);
        const parsed = new URL(url);

        expect(parsed.origin).toBe("https://fapi.binance.com");
        expect(parsed.pathname).toBe("/fapi/v1/fundingRate");
        expect(parsed.searchParams.get("symbol")).toBe("BTCUSDT");
        expect(parsed.searchParams.get("startTime")).toBe("1000");
        expect(parsed.searchParams.get("endTime")).toBe("2000");
        expect(parsed.searchParams.get("limit")).toBe("2");

        return jsonResponse([
          {
            symbol: "BTCUSDT",
            fundingRate: "0.00010000",
            fundingTime: 1_000,
            markPrice: "34287.54619963",
          },
          {
            symbol: "BTCUSDT",
            fundingRate: "-0.00020000",
            fundingTime: 2_000,
            markPrice: "34300.00000000",
          },
        ]);
      },
    },
  );

  expect(requestedUrls).toHaveLength(1);
  expect(result).toEqual({
    rates: [
      {
        fundingRate: "0.00010000",
        fundingTime: 1_000,
        markPrice: "34287.54619963",
        receivedAt: 5_000,
        raw: {
          symbol: "BTCUSDT",
          fundingRate: "0.00010000",
          fundingTime: 1_000,
          markPrice: "34287.54619963",
        },
      },
      {
        fundingRate: "-0.00020000",
        fundingTime: 2_000,
        markPrice: "34300.00000000",
        receivedAt: 5_000,
        raw: {
          symbol: "BTCUSDT",
          fundingRate: "-0.00020000",
          fundingTime: 2_000,
          markPrice: "34300.00000000",
        },
      },
    ],
    truncated: true,
  });
});

test("fetchBinanceFundingRateHistory queries COIN-M history with optional mark price", async () => {
  const result = await fetchBinanceFundingRateHistory(
    binanceCoinmMarket,
    {},
    {
      now: () => 6_000,
      fetchFn: async (input) => {
        const parsed = new URL(input.toString());

        expect(parsed.origin).toBe("https://dapi.binance.com");
        expect(parsed.pathname).toBe("/dapi/v1/fundingRate");
        expect(parsed.searchParams.get("symbol")).toBe("BTCUSD_PERP");
        expect(parsed.searchParams.get("startTime")).toBeNull();
        expect(parsed.searchParams.get("endTime")).toBeNull();
        expect(parsed.searchParams.get("limit")).toBeNull();

        return jsonResponse([
          {
            symbol: "BTCUSD_PERP",
            fundingTime: 1_596_038_400_000,
            fundingRate: "-0.00300000",
          },
        ]);
      },
    },
  );

  expect(result).toEqual({
    rates: [
      {
        fundingRate: "-0.00300000",
        fundingTime: 1_596_038_400_000,
        markPrice: undefined,
        receivedAt: 6_000,
        raw: {
          symbol: "BTCUSD_PERP",
          fundingTime: 1_596_038_400_000,
          fundingRate: "-0.00300000",
        },
      },
    ],
    truncated: false,
  });
});
