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
      l1InitialMessageTimeoutMs: 200,
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
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
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

test("funding rate subscribe emits standardized binance mark price updates", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });
  const iterator = client.market.events
    .fundingRateUpdates({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();
  const subscribePromise = client.market.subscribeFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const socket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@markPrice@1s",
    0,
  );
  socket.emitJson({
    e: "markPriceUpdate",
    E: 1710000000000,
    s: "BTCUSDT",
    p: "102100.12345678",
    i: "102000.00000000",
    r: "0.00010000",
    T: 1710028800000,
  });

  await subscribePromise;

  const fundingRate = client.market.getFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const status = client.market.getMarketStatus({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(fundingRate).toMatchObject({
    symbol: "BTC/USDT:USDT",
    fundingRate: new BigNumber("0.00010000"),
    markPrice: new BigNumber("102100.12345678"),
    indexPrice: new BigNumber("102000.00000000"),
    nextFundingTime: 1710028800000,
    exchangeTs: 1710000000000,
    version: 1,
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
  });
  expect(status).toMatchObject({
    ready: true,
    activity: "active",
    freshness: "fresh",
  });

  const event = await nextEvent(iterator);
  expect(event.snapshot.fundingRate).toEqual(new BigNumber("0.00010000"));

  await client.market.unsubscribeFundingRate({
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

test("funding rate stream handles stale disconnect and reconnect", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 20,
      l1ReconnectDelayMs: 5,
      l1ReconnectMaxDelayMs: 5,
    },
  });

  await client.start();
  const subscribePromise = client.market.subscribeFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const firstSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@markPrice@1s",
    0,
  );

  firstSocket.emitJson({
    E: 1710000000000,
    s: "BTCUSDT",
    p: "102100.10",
    i: "102000.00",
    r: "0.00010000",
    T: 1710028800000,
  });

  await subscribePromise;
  await Bun.sleep(30);

  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    freshness: "stale",
    reason: "heartbeat_timeout",
  });

  firstSocket.disconnect();
  await Bun.sleep(0);

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
    "wss://fstream.binance.com/ws/btcusdt@markPrice@1s",
    1,
    100,
  );
  secondSocket.emitJson({
    E: 1710000001000,
    s: "BTCUSDT",
    p: "102200.10",
    i: "102100.00",
    r: "0.00020000",
    T: 1710057600000,
  });

  await Bun.sleep(0);

  expect(
    client.market.getFundingRate({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    fundingRate: new BigNumber("0.00020000"),
    version: 2,
    status: {
      freshness: "fresh",
      reason: undefined,
    },
  });
  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    freshness: "fresh",
    reason: undefined,
  });
});

test("unsubscribe funding keeps active l1 status fresh", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });

  await client.start();
  const bookSubscribePromise = client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const bookSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    0,
  );
  bookSocket.emitJson({
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });
  await bookSubscribePromise;

  const fundingSubscribePromise = client.market.subscribeFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const fundingSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@markPrice@1s",
    0,
  );
  fundingSocket.emitJson({
    E: 1710000000000,
    s: "BTCUSDT",
    p: "102100.10",
    i: "102000.00",
    r: "0.00010000",
    T: 1710028800000,
  });
  await fundingSubscribePromise;

  fundingSocket.disconnect();
  await Bun.sleep(0);

  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    freshness: "stale",
    reason: "ws_disconnected",
  });
  expect(
    client.market.getFundingRate({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    status: {
      freshness: "stale",
      reason: "ws_disconnected",
    },
  });

  await client.market.unsubscribeFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(
    client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    activity: "active",
    ready: true,
    freshness: "fresh",
    reason: undefined,
  });
  expect(
    client.market.getFundingRate({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    status: {
      activity: "inactive",
      ready: true,
      freshness: undefined,
      reason: undefined,
    },
  });
  expect(
    client.market.getL1Book({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
      reason: undefined,
    },
  });
});

test("market update events keep publish-time snapshot status", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });
  const l1Iterator = client.market.events
    .l1BookUpdates({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();
  const fundingIterator = client.market.events
    .fundingRateUpdates({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();

  const bookSubscribePromise = client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const bookSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    0,
  );
  bookSocket.emitJson({
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });
  await bookSubscribePromise;

  const fundingSubscribePromise = client.market.subscribeFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const fundingSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@markPrice@1s",
    0,
  );
  fundingSocket.emitJson({
    E: 1710000000000,
    s: "BTCUSDT",
    p: "102100.10",
    i: "102000.00",
    r: "0.00010000",
    T: 1710028800000,
  });
  await fundingSubscribePromise;

  await client.market.unsubscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });
  await client.market.unsubscribeFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const l1Event = await nextEvent(l1Iterator);
  const fundingEvent = await nextEvent(fundingIterator);

  expect(l1Event.snapshot.status).toMatchObject({
    activity: "active",
    ready: true,
    freshness: "fresh",
  });
  expect(fundingEvent.snapshot.status).toMatchObject({
    activity: "active",
    ready: true,
    freshness: "fresh",
  });

  await l1Iterator.return?.();
  await fundingIterator.return?.();
});

test("spot funding rate subscriptions fail explicitly", async () => {
  installBinanceMarketInfra();
  const client = createClient();
  const errors = client.events.errors()[Symbol.asyncIterator]();

  await client.start();

  await expect(
    client.market.subscribeFundingRate({
      exchange: "binance",
      symbol: "BTC/USDT",
    }),
  ).rejects.toMatchObject({
    code: "MARKET_FUNDING_RATE_UNSUPPORTED",
  });

  const errorEvent = await nextEvent(errors);
  expect(errorEvent).toMatchObject({
    source: "market",
    exchange: "binance",
    symbol: "BTC/USDT",
  });

  await errors.return?.();
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
      l1InitialMessageTimeoutMs: 200,
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
      l1InitialMessageTimeoutMs: 200,
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
