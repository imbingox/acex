import { expect, test } from "bun:test";
import { BigNumber, createClient } from "../index.ts";
import {
  installBinanceMarketInfra,
  nextEvent,
  textResponse,
  waitForSocket,
} from "./support/client-test-utils.ts";

test("loadMarkets exposes a unified binance market catalog", async () => {
  installBinanceMarketInfra();
  const client = createClient();

  await client.market.loadMarkets();

  expect(client.market.listMarkets().map((market) => market.symbol)).toEqual([
    "BTC/USD:BTC",
    "BTC/USD:BTC-20250627",
    "BTC/USDT",
    "BTC/USDT:USDT",
    "ETH/USDT",
  ]);

  expect(client.market.getMarket("binance", "BTC/USDT")).toMatchObject({
    exchange: "binance",
    symbol: "BTC/USDT",
    type: "spot",
    contract: false,
    pricePrecision: 2,
    amountPrecision: 4,
  });

  expect(client.market.getMarket("binance", "BTC/USDT:USDT")).toMatchObject({
    type: "swap",
    settle: "USDT",
    linear: true,
    contract: true,
    contractSize: new BigNumber("1"),
    minNotional: new BigNumber("5"),
  });

  expect(client.market.getMarket("binance", "BTC/USD:BTC")).toMatchObject({
    type: "swap",
    settle: "BTC",
    inverse: true,
    contractSize: new BigNumber("100"),
  });

  expect(
    client.market.getMarket("binance", "BTC/USD:BTC-20250627"),
  ).toMatchObject({
    type: "future",
    expiry: Date.UTC(2025, 5, 27),
  });
});

test("market catalog load failure emits an adapter error and wrapped AcexError", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      textResponse("binance down", {
        status: 503,
        statusText: "Service Unavailable",
      }),
  });

  const client = createClient();
  const errors = client.events.errors()[Symbol.asyncIterator]();

  await expect(client.market.loadMarkets()).rejects.toMatchObject({
    code: "MARKET_CATALOG_LOAD_FAILED",
  });

  const errorEvent = await nextEvent(errors);
  expect(errorEvent).toMatchObject({
    source: "adapter",
    exchange: "binance",
  });
  expect(errorEvent.error.message).toContain("Binance request failed: 503");

  await errors.return?.();
});

test("market subscribe is a ready barrier and emits standardized l1 book updates", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 50,
      l1StaleAfterMs: 50,
    },
  });
  const iterator = client.market.events
    .l1BookUpdates({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();
  const subscribePromise = client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const socket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    0,
  );
  socket.emitJson({
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });

  await subscribePromise;

  const book = client.market.getL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const status = client.market.getMarketStatus({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(book).toMatchObject({
    symbol: "BTC/USDT:USDT",
    bidPrice: new BigNumber("102000.10"),
    askPrice: new BigNumber("102000.20"),
    version: 1,
  });
  expect(status).toMatchObject({
    ready: true,
    activity: "active",
    freshness: "fresh",
  });

  const event = await nextEvent(iterator);
  expect(event.snapshot.bidSize).toEqual(new BigNumber("1.500"));

  await client.market.unsubscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    activity: "inactive",
  });

  await iterator.return?.();
});

test("unknown and inactive markets have explicit semantics", async () => {
  installBinanceMarketInfra();
  const client = createClient();

  await client.market.loadMarkets();
  await client.start();

  expect(client.market.getMarket("binance", "DOGE/USDT")).toBeUndefined();

  await expect(
    client.market.subscribeL1Book({
      exchange: "binance",
      symbol: "DOGE/USDT",
    }),
  ).rejects.toMatchObject({
    code: "MARKET_NOT_FOUND",
  });

  await expect(
    client.market.subscribeL1Book({
      exchange: "binance",
      symbol: "ETH/USDT",
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INACTIVE",
  });
});

test("watchdog marks stale data and disconnect marks ws_disconnected", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 50,
      l1StaleAfterMs: 20,
    },
  });

  await client.start();
  const subscribePromise = client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT",
  });
  const socket = await waitForSocket(
    "wss://stream.binance.com:9443/ws/btcusdt@bookTicker",
    0,
  );

  socket.emitJson({
    b: "100000.10",
    B: "0.5000",
    a: "100000.20",
    A: "0.7000",
    T: 1710000000001,
  });

  await subscribePromise;
  await Bun.sleep(30);

  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT",
    }),
  ).toMatchObject({
    activity: "active",
    freshness: "stale",
    reason: "heartbeat_timeout",
  });

  socket.disconnect();
  await Bun.sleep(0);

  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT",
    }),
  ).toMatchObject({
    activity: "active",
    freshness: "stale",
    reason: "ws_disconnected",
  });
});

test("sdk reconnects websocket streams automatically after disconnect", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 50,
      l1StaleAfterMs: 50,
      l1ReconnectDelayMs: 5,
      l1ReconnectMaxDelayMs: 5,
    },
  });

  await client.start();
  const subscribePromise = client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const firstSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    0,
  );
  firstSocket.emitJson({
    b: "101000.10",
    B: "1.000",
    a: "101000.20",
    A: "2.000",
    T: 1710000000010,
  });

  await subscribePromise;
  firstSocket.disconnect();

  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    freshness: "stale",
    reason: "ws_disconnected",
  });

  const secondSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    1,
    100,
  );
  secondSocket.emitJson({
    b: "101500.10",
    B: "1.250",
    a: "101500.20",
    A: "2.250",
    T: 1710000000020,
  });

  await Bun.sleep(0);

  expect(
    client.market.getL1Book({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("101500.10"),
    askPrice: new BigNumber("101500.20"),
    version: 2,
  });
  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    ready: true,
    freshness: "fresh",
    reason: undefined,
  });
});
