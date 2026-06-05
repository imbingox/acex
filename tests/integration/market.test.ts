import { expect, test } from "bun:test";
import { AcexError, BigNumber, createClient } from "../../index.ts";
import {
  BINANCE_SPOT_WS_BASE_URL,
  BINANCE_USDM_MARKET_WS_BASE_URL,
  BINANCE_USDM_WS_BASE_URL,
  installBinanceMarketInfra,
  waitForBinanceControlFrame,
} from "../support/exchanges/binance.ts";
import {
  FakeWebSocket,
  nextEvent,
  textResponse,
  waitForSocket,
} from "../support/test-utils.ts";

function emitBookTicker(
  socket: FakeWebSocket,
  symbol: string,
  bidPrice: string,
): void {
  socket.emitJson({
    s: symbol,
    b: bidPrice,
    B: "1.000",
    a: `${Number.parseFloat(bidPrice) + 0.1}`,
    A: "2.000",
    T: 1710000000000,
  });
}

async function expectNoEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<void> {
  const result = await Promise.race([
    iterator.next().then((value) => ({ kind: "event" as const, value })),
    Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);

  if (result.kind === "event") {
    if (result.value.done) {
      throw new Error("Expected no event, iterator closed unexpectedly");
    }

    throw new Error(
      `Expected no event, received ${JSON.stringify(result.value.value)}`,
    );
  }
}

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
    "ETH/USDT:USDT",
  ]);

  expect(client.market.getMarket("binance", "BTC/USDT")).toMatchObject({
    venue: "binance",
    symbol: "BTC/USDT",
    type: "spot",
    contract: false,
    pricePrecision: 2,
    amountPrecision: 4,
  });

  const btcUsdtSwap = client.market.getMarket("binance", "BTC/USDT:USDT");
  expect(btcUsdtSwap).toBeDefined();
  if (!btcUsdtSwap) {
    throw new Error("Expected BTC/USDT:USDT market");
  }

  expect(btcUsdtSwap).toMatchObject({
    type: "swap",
    settle: "USDT",
    linear: true,
    contract: true,
    contractSize: new BigNumber("1").toFixed(),
    minNotional: new BigNumber("5").toFixed(),
  });
  expect(client.market.getMarkets("BTC/USDT:USDT")).toEqual([btcUsdtSwap]);

  expect(client.market.getMarket("binance", "BTC/USD:BTC")).toMatchObject({
    type: "swap",
    settle: "BTC",
    inverse: true,
    contractSize: new BigNumber("100").toFixed(),
  });

  expect(
    client.market.getMarket("binance", "BTC/USD:BTC-20250627"),
  ).toMatchObject({
    type: "future",
    expiry: Date.UTC(2025, 5, 27),
  });
});

test("normalizeOrderInput floors price and amount to market steps", async () => {
  installBinanceMarketInfra();
  const client = createClient();

  await client.market.loadMarkets();

  expect(
    client.market.normalizeOrderInput({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
      price: "101000.123456789",
      amount: "0.010987654321",
    }),
  ).toEqual({
    price: "101000.1",
    amount: "0.01",
    rawPrice: "101000.123456789",
    rawAmount: "0.010987654321",
    adjusted: true,
    accepted: true,
    priceStep: "0.1",
    amountStep: "0.001",
    minAmount: "0.001",
    minNotional: "5",
  });
});

test("normalizeOrderInput reports min-notional rejection after normalization", async () => {
  installBinanceMarketInfra();
  const client = createClient();

  await client.market.loadMarkets();

  expect(
    client.market.normalizeOrderInput({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
      price: "1000.09",
      amount: "0.0049",
    }),
  ).toMatchObject({
    price: "1000",
    amount: "0.004",
    adjusted: true,
    accepted: false,
    rejectReason: "notional_below_min",
  });
});

test("normalizeOrderInput rejects non-finite input without throwing", async () => {
  installBinanceMarketInfra();
  const client = createClient();

  await client.market.loadMarkets();

  expect(
    client.market.normalizeOrderInput({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
      price: "NaN",
      amount: "0.01",
    }),
  ).toMatchObject({
    accepted: false,
    rejectReason: "price_not_positive",
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

  const failure = await client.market.loadMarkets().catch((error) => error);
  expect(failure).toBeInstanceOf(AcexError);
  if (!(failure instanceof AcexError)) {
    throw new Error("Expected AcexError");
  }
  expect(failure).toMatchObject({
    code: "MARKET_CATALOG_LOAD_FAILED",
    details: {
      venue: "binance",
      transport: {
        kind: "http",
        status: 503,
        statusText: "Service Unavailable",
        rawBody: "binance down",
      },
    },
  });
  expect(failure.cause).toBeInstanceOf(Error);
  expect(failure.details?.venueError).toBeUndefined();

  const errorEvent = await nextEvent(errors);
  expect(errorEvent).toMatchObject({
    source: "adapter",
    venue: "binance",
  });
  expect(errorEvent.error.message).toContain("Binance request failed: 503");

  await errors.return?.();
});

test("fetchServerTime works before client start and returns latency fields", async () => {
  installBinanceMarketInfra();
  const client = createClient();

  const result = await client.market.fetchServerTime("binance");

  expect(result).toMatchObject({
    serverTime: 1710000000123,
  });
  expect(Number.isFinite(result.requestSentAt)).toBe(true);
  expect(Number.isFinite(result.responseReceivedAt)).toBe(true);
  expect(Number.isFinite(result.roundTripMs)).toBe(true);
  expect(result.roundTripMs).toBeGreaterThanOrEqual(0);
  expect(result.estimatedOffsetMs).toBe(
    result.serverTime - (result.requestSentAt + result.responseReceivedAt) / 2,
  );
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
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();
  const subscribePromise = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@bookTicker"]);
  socket.emitJson({
    s: "BTCUSDT",
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });

  await subscribePromise;

  const book = client.market.getL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const status = client.market.getMarketStatus({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(book).toBeDefined();
  if (!book) {
    throw new Error("Expected l1 book snapshot");
  }

  expect(book).toMatchObject({
    symbol: "BTC/USDT:USDT",
    bidPrice: new BigNumber("102000.10").toFixed(),
    askPrice: new BigNumber("102000.20").toFixed(),
    version: 1,
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
  });
  expect(client.market.getL1Books("BTC/USDT:USDT")).toEqual([book]);
  expect(client.market.getL1Books("BTC/USDT")).toEqual([]);
  expect(status).toMatchObject({
    ready: true,
    activity: "active",
    freshness: "fresh",
  });

  const event = await nextEvent(iterator);
  expect(event.snapshot.bidSize).toEqual(new BigNumber("1.500").toFixed());

  await client.market.unsubscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(
    client.market.getMarketStatus({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    activity: "inactive",
  });

  await iterator.return?.();
});

test("l1 book snapshots canonicalize decimal string output", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });

  await client.start();
  const subscribePromise = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@bookTicker"]);
  socket.emitJson({
    s: "BTCUSDT",
    b: "1e-7",
    B: "0.1234567890123456789000",
    a: "1e21",
    A: "-0.0100",
    T: 1710000000000,
  });

  await subscribePromise;

  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: "0.0000001",
    bidSize: "0.1234567890123456789",
    askPrice: "1000000000000000000000",
    askSize: "-0.01",
  });

  await client.market.unsubscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
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
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();
  const subscribePromise = client.market.subscribeFundingRate({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const socket = await waitForSocket(BINANCE_USDM_MARKET_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@markPrice"]);
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
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const status = client.market.getMarketStatus({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(fundingRate).toBeDefined();
  if (!fundingRate) {
    throw new Error("Expected funding rate snapshot");
  }

  expect(fundingRate).toMatchObject({
    symbol: "BTC/USDT:USDT",
    fundingRate: new BigNumber("0.00010000").toFixed(),
    markPrice: new BigNumber("102100.12345678").toFixed(),
    indexPrice: new BigNumber("102000.00000000").toFixed(),
    nextFundingTime: 1710028800000,
    exchangeTs: 1710000000000,
    version: 1,
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
  });
  expect(client.market.getFundingRates("BTC/USDT:USDT")).toEqual([fundingRate]);
  expect(client.market.getFundingRates("BTC/USDT")).toEqual([]);
  expect(status).toMatchObject({
    ready: true,
    activity: "active",
    freshness: "fresh",
  });

  const event = await nextEvent(iterator);
  expect(event.snapshot.fundingRate).toEqual(
    new BigNumber("0.00010000").toFixed(),
  );

  await client.market.unsubscribeFundingRate({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(
    client.market.getMarketStatus({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    activity: "inactive",
  });

  await iterator.return?.();
});

test("binance l1 multiplexes multiple symbols onto one websocket", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const btcSubscribe = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const ethSubscribe = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "ETH/USDT:USDT",
  });
  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
    "ethusdt@bookTicker",
  ]);

  expect(
    FakeWebSocket.instances.filter(
      (instance) => instance.url === BINANCE_USDM_WS_BASE_URL,
    ),
  ).toHaveLength(1);

  emitBookTicker(socket, "BTCUSDT", "102000.10");
  emitBookTicker(socket, "ETHUSDT", "3000.10");
  await Promise.all([btcSubscribe, ethSubscribe]);

  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("102000.10").toFixed(),
    version: 1,
  });
  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "ETH/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("3000.10").toFixed(),
    version: 1,
  });
});

test("binance l1 unsubscribe removes one logical stream and keeps others active", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const btcSubscribe = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const ethSubscribe = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "ETH/USDT:USDT",
  });
  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
    "ethusdt@bookTicker",
  ]);

  emitBookTicker(socket, "BTCUSDT", "102000.10");
  emitBookTicker(socket, "ETHUSDT", "3000.10");
  await Promise.all([btcSubscribe, ethSubscribe]);

  await client.market.unsubscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  await waitForBinanceControlFrame(socket, "UNSUBSCRIBE", [
    "btcusdt@bookTicker",
  ]);

  emitBookTicker(socket, "BTCUSDT", "102500.10");
  emitBookTicker(socket, "ETHUSDT", "3001.10");
  await Bun.sleep(0);

  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("102000.10").toFixed(),
    version: 1,
    status: {
      activity: "inactive",
    },
  });
  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "ETH/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("3001.10").toFixed(),
    version: 2,
    status: {
      activity: "active",
      freshness: "fresh",
    },
  });
});

test("binance l1 replay active subscriptions after reconnect", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
      l1ReconnectDelayMs: 5,
      l1ReconnectMaxDelayMs: 5,
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const btcSubscribe = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const ethSubscribe = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "ETH/USDT:USDT",
  });
  const firstSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(firstSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
    "ethusdt@bookTicker",
  ]);

  emitBookTicker(firstSocket, "BTCUSDT", "102000.10");
  emitBookTicker(firstSocket, "ETHUSDT", "3000.10");
  await Promise.all([btcSubscribe, ethSubscribe]);

  firstSocket.disconnect();

  const reconnectSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 1, 100);
  await waitForBinanceControlFrame(reconnectSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
    "ethusdt@bookTicker",
  ]);

  emitBookTicker(reconnectSocket, "BTCUSDT", "102100.10");
  emitBookTicker(reconnectSocket, "ETHUSDT", "3001.10");
  await Bun.sleep(0);

  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("102100.10").toFixed(),
    version: 2,
  });
  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "ETH/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("3001.10").toFixed(),
    version: 2,
  });
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
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const firstSocket = await waitForSocket(BINANCE_USDM_MARKET_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(firstSocket, "SUBSCRIBE", [
    "btcusdt@markPrice",
  ]);

  firstSocket.emitJson({
    e: "markPriceUpdate",
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
      venue: "binance",
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
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    freshness: "stale",
    reason: "ws_disconnected",
  });

  const secondSocket = await waitForSocket(
    BINANCE_USDM_MARKET_WS_BASE_URL,
    1,
    100,
  );
  await waitForBinanceControlFrame(secondSocket, "SUBSCRIBE", [
    "btcusdt@markPrice",
  ]);
  secondSocket.emitJson({
    e: "markPriceUpdate",
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
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    fundingRate: new BigNumber("0.00020000").toFixed(),
    version: 2,
    status: {
      freshness: "fresh",
      reason: undefined,
    },
  });
  expect(
    client.market.getMarketStatus({
      venue: "binance",
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
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const bookSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(bookSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
  ]);
  bookSocket.emitJson({
    s: "BTCUSDT",
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });
  await bookSubscribePromise;

  const fundingSubscribePromise = client.market.subscribeFundingRate({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const fundingSocket = await waitForSocket(BINANCE_USDM_MARKET_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(fundingSocket, "SUBSCRIBE", [
    "btcusdt@markPrice",
  ]);
  fundingSocket.emitJson({
    e: "markPriceUpdate",
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
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    freshness: "stale",
    reason: "ws_disconnected",
  });
  expect(
    client.market.getFundingRate({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    status: {
      freshness: "stale",
      reason: "ws_disconnected",
    },
  });

  await client.market.unsubscribeFundingRate({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(
    client.market.getMarketStatus({
      venue: "binance",
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
      venue: "binance",
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
      venue: "binance",
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
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();
  const fundingIterator = client.market.events
    .fundingRateUpdates({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();

  const bookSubscribePromise = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const bookSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(bookSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
  ]);
  bookSocket.emitJson({
    s: "BTCUSDT",
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });
  await bookSubscribePromise;

  const fundingSubscribePromise = client.market.subscribeFundingRate({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const fundingSocket = await waitForSocket(BINANCE_USDM_MARKET_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(fundingSocket, "SUBSCRIBE", [
    "btcusdt@markPrice",
  ]);
  fundingSocket.emitJson({
    e: "markPriceUpdate",
    E: 1710000000000,
    s: "BTCUSDT",
    p: "102100.10",
    i: "102000.00",
    r: "0.00010000",
    T: 1710028800000,
  });
  await fundingSubscribePromise;

  await client.market.unsubscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  await client.market.unsubscribeFundingRate({
    venue: "binance",
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
      venue: "binance",
      symbol: "BTC/USDT",
    }),
  ).rejects.toMatchObject({
    code: "MARKET_FUNDING_RATE_UNSUPPORTED",
  });

  const errorEvent = await nextEvent(errors);
  expect(errorEvent).toMatchObject({
    source: "market",
    venue: "binance",
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
      venue: "binance",
      symbol: "DOGE/USDT",
    }),
  ).rejects.toMatchObject({
    code: "MARKET_NOT_FOUND",
  });

  await expect(
    client.market.subscribeL1Book({
      venue: "binance",
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
    venue: "binance",
    symbol: "BTC/USDT",
  });
  const socket = await waitForSocket(BINANCE_SPOT_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@bookTicker"]);

  socket.emitJson({
    s: "BTCUSDT",
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
      venue: "binance",
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
      venue: "binance",
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
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const firstSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(firstSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
  ]);
  firstSocket.emitJson({
    s: "BTCUSDT",
    b: "101000.10",
    B: "1.000",
    a: "101000.20",
    A: "2.000",
    T: 1710000000010,
  });

  await subscribePromise;
  const statusIterator = client.market.events
    .status({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  firstSocket.disconnect();

  expect(await nextEvent(statusIterator)).toMatchObject({
    type: "market.status_changed",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    status: {
      freshness: "stale",
      reason: "ws_disconnected",
    },
  });
  await expectNoEvent(statusIterator, 20);
  await statusIterator.return?.();

  expect(
    client.market.getMarketStatus({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    freshness: "stale",
    reason: "ws_disconnected",
  });

  const secondSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 1, 100);
  await waitForBinanceControlFrame(secondSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
  ]);
  secondSocket.emitJson({
    s: "BTCUSDT",
    b: "101500.10",
    B: "1.250",
    a: "101500.20",
    A: "2.250",
    T: 1710000000020,
  });

  await Bun.sleep(0);

  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("101500.10").toFixed(),
    askPrice: new BigNumber("101500.20").toFixed(),
    version: 2,
  });
  expect(
    client.market.getMarketStatus({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    ready: true,
    freshness: "fresh",
    reason: undefined,
  });
});

test("market all and status streams expose public event filtering", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });
  const allIterator = client.market.events
    .all({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();
  const statusIterator = client.market.events
    .status({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();
  const subscribePromise = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@bookTicker"]);

  const pendingStatus = {
    type: "market.status_changed",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    status: {
      activity: "active",
      ready: false,
    },
  };

  expect(await nextEvent(statusIterator)).toMatchObject(pendingStatus);
  expect(await nextEvent(allIterator)).toMatchObject(pendingStatus);

  socket.emitJson({
    s: "BTCUSDT",
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });
  await subscribePromise;

  const freshStatus = {
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
  };

  let readyStatusEvent: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const event = await nextEvent(statusIterator);
    if (event.status.ready) {
      readyStatusEvent = event;
      break;
    }
  }

  expect(readyStatusEvent).toMatchObject(freshStatus);
  let l1AllEvent: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const event = await nextEvent(allIterator);
    if (event.type === "l1_book.updated") {
      l1AllEvent = event;
      break;
    }
  }

  expect(l1AllEvent).toMatchObject({
    type: "l1_book.updated",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    snapshot: {
      bidPrice: new BigNumber("102000.10").toFixed(),
      version: 1,
    },
  });
  expect(await nextEvent(allIterator)).toMatchObject(freshStatus);

  await client.market.unsubscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  let inactiveStatusEvent: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const event = await nextEvent(statusIterator);
    if (event.status.activity === "inactive") {
      inactiveStatusEvent = event;
      break;
    }
  }

  expect(inactiveStatusEvent).toMatchObject({
    status: {
      activity: "inactive",
      ready: false,
    },
  });
  let inactiveAllEvent: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const event = await nextEvent(allIterator);
    if ("status" in event && event.status.activity === "inactive") {
      inactiveAllEvent = event;
      break;
    }
  }

  expect(inactiveAllEvent).toMatchObject({
    status: {
      activity: "inactive",
      ready: false,
    },
  });

  await allIterator.return?.();
  await statusIterator.return?.();
});
