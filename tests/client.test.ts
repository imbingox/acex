import { afterEach, expect, test } from "bun:test";
import { AcexError, createClient } from "../index.ts";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

const SPOT_EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo";
const USDM_EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COINM_EXCHANGE_INFO_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

const binanceFixtures = {
  spot: {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.01",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.0001",
            stepSize: "0.0001",
          },
          {
            filterType: "MIN_NOTIONAL",
            minNotional: "10",
          },
        ],
      },
      {
        symbol: "ETHUSDT",
        status: "BREAK",
        baseAsset: "ETH",
        quoteAsset: "USDT",
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.01",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.001",
            stepSize: "0.001",
          },
        ],
      },
    ],
  },
  usdm: {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        pricePrecision: 2,
        quantityPrecision: 3,
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.10",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.001",
            stepSize: "0.001",
          },
          {
            filterType: "MIN_NOTIONAL",
            minNotional: "5",
          },
        ],
      },
    ],
  },
  coinm: {
    symbols: [
      {
        symbol: "BTCUSD_PERP",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "BTC",
        quoteAsset: "USD",
        marginAsset: "BTC",
        contractSize: 100,
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.1",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "1",
            stepSize: "1",
          },
        ],
      },
      {
        symbol: "BTCUSD_250627",
        status: "TRADING",
        contractType: "CURRENT_QUARTER",
        deliveryDate: Date.UTC(2025, 5, 27),
        baseAsset: "BTC",
        quoteAsset: "USD",
        marginAsset: "BTC",
        contractSize: 100,
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.1",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "1",
            stepSize: "1",
          },
        ],
      },
    ],
  },
};

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) {
        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static getByUrl(url: string): FakeWebSocket {
    const socket = FakeWebSocket.instances.find(
      (instance) => instance.url === url,
    );
    if (!socket) {
      throw new Error(`Missing FakeWebSocket for ${url}`);
    }

    return socket;
  }

  send(): void {}

  emitJson(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  disconnect(code = 1006, reason = "network down"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason,
        wasClean: false,
      }),
    );
  }

  close(code = 1000, reason = "manual close"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason,
        wasClean: true,
      }),
    );
  }
}

async function waitForSocket(
  url: string,
  instanceIndex = 0,
  timeoutMs = 100,
): Promise<FakeWebSocket> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const matches = FakeWebSocket.instances.filter(
      (instance) => instance.url === url,
    );
    const socket = matches[instanceIndex];
    if (socket) {
      return socket;
    }

    await Bun.sleep(1);
  }

  throw new Error(`Timed out waiting for FakeWebSocket ${url}`);
}

interface ContinuousBookTickerFeed {
  readonly done: Promise<number>;
  readonly totalTicks: number;
  stop(): void;
}

function startContinuousBookTickerFeed(
  socket: FakeWebSocket,
  options: {
    durationMs: number;
    intervalMs: number;
    startPrice: number;
  },
): ContinuousBookTickerFeed {
  const totalTicks = Math.floor(options.durationMs / options.intervalMs) + 1;
  let ticks = 0;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let resolveDone: ((ticks: number) => void) | undefined;

  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const stop = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }

    resolveDone?.(ticks);
    resolveDone = undefined;
  };

  const emit = () => {
    if (stopped) {
      return;
    }

    ticks += 1;
    const price = options.startPrice + ticks;
    socket.emitJson({
      b: `${price}.10`,
      B: `1.${`${ticks}`.padStart(3, "0")}`,
      a: `${price}.20`,
      A: `2.${`${ticks}`.padStart(3, "0")}`,
      T: 1710000000000 + ticks * options.intervalMs,
    });

    if (ticks >= totalTicks) {
      stop();
    }
  };

  emit();
  interval = setInterval(emit, options.intervalMs);

  return {
    done,
    totalTicks,
    stop,
  };
}

function installBinanceMarketInfra(): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();

      switch (url) {
        case SPOT_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.spot);
        case USDM_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.usdm);
        case COINM_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.coinm);
        default:
          throw new Error(`Unexpected fetch URL: ${url}`);
      }
    },
  });

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
}

async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs = 1000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = (await Promise.race([
    iterator.next().then((value) => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      return value;
    }),
    new Promise<IteratorResult<T>>((_, reject) => {
      timeout = setTimeout(() => {
        timeout = undefined;
        reject(new Error("Timed out waiting for event"));
      }, timeoutMs);
    }),
  ])) as IteratorResult<T>;

  if (result.done) {
    throw new Error("Event stream closed unexpectedly");
  }

  return result.value;
}

afterEach(() => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originalWebSocket,
  });
});

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

  expect(client.market.getMarket("BTC/USDT")).toMatchObject({
    exchange: "binance",
    symbol: "BTC/USDT",
    type: "spot",
    contract: false,
    pricePrecision: 2,
    amountPrecision: 4,
  });

  expect(client.market.getMarket("BTC/USDT:USDT")).toMatchObject({
    type: "swap",
    settle: "USDT",
    linear: true,
    contract: true,
    contractSize: "1",
    minNotional: "5",
  });

  expect(client.market.getMarket("BTC/USD:BTC")).toMatchObject({
    type: "swap",
    settle: "BTC",
    inverse: true,
    contractSize: "100",
  });

  expect(client.market.getMarket("BTC/USD:BTC-20250627")).toMatchObject({
    type: "future",
    expiry: Date.UTC(2025, 5, 27),
  });
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
    bidPrice: "102000.10",
    askPrice: "102000.20",
    version: 1,
  });
  expect(status).toMatchObject({
    ready: true,
    activity: "active",
    freshness: "fresh",
  });

  const event = await nextEvent(iterator);
  expect(event.snapshot.bidSize).toBe("1.500");

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

  expect(client.market.getMarket("DOGE/USDT")).toBeUndefined();

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
    bidPrice: "101500.10",
    askPrice: "101500.20",
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

test("caller can observe l1 book keep changing for one minute", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 1_000,
      l1StaleAfterMs: 5_000,
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
    1_000,
  );
  const feed = startContinuousBookTickerFeed(socket, {
    durationMs: 60_000,
    intervalMs: 1_000,
    startPrice: 102000,
  });

  try {
    await subscribePromise;

    let eventCount = 0;
    let firstBidPrice: string | undefined;
    let lastBidPrice: string | undefined;
    let previousVersion = 0;

    while (eventCount < feed.totalTicks) {
      const event = await nextEvent(iterator, 5_000);
      eventCount += 1;

      if (eventCount === 1) {
        firstBidPrice = event.snapshot.bidPrice;
        expect(event.snapshot.version).toBe(1);
      } else {
        expect(event.snapshot.version).toBe(previousVersion + 1);
      }

      previousVersion = event.snapshot.version;
      lastBidPrice = event.snapshot.bidPrice;
    }

    const emittedTicks = await feed.done;
    const finalBook = client.market.getL1Book({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    });
    const finalStatus = client.market.getMarketStatus({
      exchange: "binance",
      symbol: "BTC/USDT:USDT",
    });

    expect(emittedTicks).toBe(feed.totalTicks);
    expect(eventCount).toBe(feed.totalTicks);
    expect(previousVersion).toBe(feed.totalTicks);
    expect(firstBidPrice).not.toBe(lastBidPrice);
    expect(finalBook).toMatchObject({
      version: feed.totalTicks,
      bidPrice: lastBidPrice,
    });
    expect(finalStatus).toMatchObject({
      ready: true,
      activity: "active",
      freshness: "fresh",
    });
  } finally {
    feed.stop();
    await feed.done;
    await iterator.return?.();
  }
}, 75_000);

test("private subscriptions validate credentials at subscribe time", async () => {
  const client = createClient();

  await client.start();
  await client.registerAccount({
    accountId: "main-binance",
    exchange: "binance",
  });

  await expect(
    client.account.subscribeAccount({
      accountId: "main-binance",
    }),
  ).rejects.toBeInstanceOf(AcexError);

  await client.updateAccountCredentials("main-binance", {
    apiKey: "key",
    secret: "secret",
  });

  await client.account.subscribeAccount({
    accountId: "main-binance",
  });

  const snapshot = client.account.getAccountSnapshot("main-binance");
  const status = client.account.getAccountStatus("main-binance");

  expect(snapshot).toBeDefined();
  expect(status?.ready).toBe(true);
  expect(status?.activity).toBe("active");
});

test("removeAccount auto-cleans active private subscriptions and caches", async () => {
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    exchange: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  await client.removeAccount("main-binance");

  expect(client.account.getAccountSnapshot("main-binance")).toBeUndefined();
  expect(client.order.getOrderStatus("main-binance")).toBeUndefined();
  expect(client.getHealth().accounts).toHaveLength(0);
  expect(client.getHealth().orders).toHaveLength(0);
});
