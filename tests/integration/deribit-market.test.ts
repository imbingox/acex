import { expect, test } from "bun:test";
import { createClient, type MarketStatusChangedEvent } from "../../index.ts";
import { installBinanceMarketInfra } from "../support/exchanges/binance.ts";
import {
  DERIBIT_WS_URL,
  installDeribitMarketInfra,
  waitForDeribitControlFrame,
} from "../support/exchanges/deribit.ts";
import {
  type FakeWebSocket,
  nextEvent,
  waitForSocket,
} from "../support/test-utils.ts";

const BTC_CALL_SYMBOL = "BTC/USD:BTC-20260621-57000-C";
const BTC_CALL_INSTRUMENT = "BTC-21JUN26-57000-C";
const BTC_PUT_SYMBOL = "BTC/USD:BTC-20260621-57000-P";
const BTC_PUT_INSTRUMENT = "BTC-21JUN26-57000-P";

function emitDeribitQuote(
  socket: FakeWebSocket,
  instrument: string,
  data: Record<string, unknown>,
): void {
  socket.emitJson({
    jsonrpc: "2.0",
    method: "subscription",
    params: {
      channel: `quote.${instrument}`,
      data,
    },
  });
}

async function nextMatchingStatus(
  iterator: AsyncIterator<MarketStatusChangedEvent>,
  predicate: (event: MarketStatusChangedEvent) => boolean,
): Promise<MarketStatusChangedEvent> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const event = await nextEvent(iterator);
    if (predicate(event)) {
      return event;
    }
  }

  throw new Error("Timed out waiting for matching market status event");
}

test("default client loadMarkets loads runtime-supported Binance and Deribit catalogs", async () => {
  installBinanceMarketInfra();
  const client = createClient();

  await client.market.loadMarkets();

  expect(client.market.listMarkets("binance").length).toBeGreaterThan(0);
  expect(client.market.listOptionMarkets({ venue: "deribit" }).length).toBe(4);
  expect(client.market.listOptionPairs({ venue: "deribit" })).toHaveLength(1);
});

test("Deribit option discovery is a pure catalog read and groups complete pairs", async () => {
  const requestedCurrencies = installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      venues: {
        deribit: {
          underlyings: [" eth ", "BTC", "ETH"],
        },
      },
    },
  });

  expect(client.market.listOptionMarkets({ venue: "deribit" })).toEqual([]);
  expect(client.market.listOptionPairs({ venue: "deribit" })).toEqual([]);
  expect(requestedCurrencies).toEqual([]);

  await client.market.loadMarkets();

  expect(requestedCurrencies).toEqual(["ETH", "BTC"]);
  expect(
    client.market
      .listOptionMarkets({ venue: "deribit", strike: 5.7e4 })
      .map((market) => market.symbol),
  ).toEqual(["BTC/USD:BTC-20260621-57000-C", "BTC/USD:BTC-20260621-57000-P"]);
  expect(
    client.market
      .listOptionMarkets({
        venue: "deribit",
        underlying: " btc ",
        active: true,
      })
      .map((market) => [market.strike, market.optionType]),
  ).toEqual([
    ["57000", "call"],
    ["57000", "put"],
    ["58000", "call"],
  ]);

  const pairs = client.market.listOptionPairs({
    venue: "deribit",
    underlying: "BTC",
    active: true,
  });
  expect(pairs).toHaveLength(1);
  expect(pairs[0]).toMatchObject({
    venue: "deribit",
    underlying: "BTC",
    strikeCurrency: "USD",
    premiumCurrency: "BTC",
    settle: "BTC",
    expiry: Date.UTC(2026, 5, 21),
    strike: "57000",
    call: {
      symbol: "BTC/USD:BTC-20260621-57000-C",
      optionType: "call",
    },
    put: {
      symbol: "BTC/USD:BTC-20260621-57000-P",
      optionType: "put",
    },
  });
});

test("Deribit underlyings config rejects empty input and load fails invalid underlying", async () => {
  expect(() =>
    createClient({
      venues: ["deribit"],
      market: {
        venues: {
          deribit: {
            underlyings: [],
          },
        },
      },
    }),
  ).toThrow("underlyings must not be empty");

  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      venues: {
        deribit: {
          underlyings: ["DOGE"],
        },
      },
    },
  });

  await expect(client.market.loadMarkets()).rejects.toMatchObject({
    code: "MARKET_CATALOG_LOAD_FAILED",
    details: {
      venue: "deribit",
    },
  });
});

test("Deribit partial and empty first quotes resolve L1 ready", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 200,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const callIterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  const putIterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_PUT_SYMBOL })
    [Symbol.asyncIterator]();

  const callLease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const putLease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_PUT_SYMBOL,
  });
  const socket = await waitForSocket(DERIBIT_WS_URL);
  await waitForDeribitControlFrame(socket, "public/subscribe", [
    `quote.${BTC_CALL_INSTRUMENT}`,
    `quote.${BTC_PUT_INSTRUMENT}`,
  ]);

  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000001,
    best_bid_price: 0.101,
    best_bid_amount: 2,
    best_ask_price: null,
    best_ask_amount: null,
  });
  emitDeribitQuote(socket, BTC_PUT_INSTRUMENT, {
    timestamp: 1710000000002,
    best_bid_price: null,
    best_bid_amount: null,
    best_ask_price: null,
    best_ask_amount: null,
  });
  await Promise.all([callLease.ready, putLease.ready]);

  const callEvent = await nextEvent(callIterator);
  expect(callEvent.snapshot).toMatchObject({
    bidPrice: "0.101",
    bidSize: "2",
    askPrice: null,
    askSize: null,
    exchangeTs: 1710000000001,
    version: 1,
    status: {
      ready: true,
      freshness: "fresh",
    },
  });
  expect(callEvent.snapshot.status.reason).toBeUndefined();
  expect(
    client.market.getMarketStatus({
      venue: "deribit",
      symbol: BTC_CALL_SYMBOL,
    })?.reason,
  ).toBeUndefined();

  const putEvent = await nextEvent(putIterator);
  expect(putEvent.snapshot).toMatchObject({
    bidPrice: null,
    bidSize: null,
    askPrice: null,
    askSize: null,
    exchangeTs: 1710000000002,
    version: 1,
    status: {
      ready: true,
      freshness: "fresh",
    },
  });
  expect(putEvent.snapshot.status.reason).toBeUndefined();
  expect(
    client.market.getMarketStatus({
      venue: "deribit",
      symbol: BTC_PUT_SYMBOL,
    })?.reason,
  ).toBeUndefined();

  callLease.close();
  putLease.close();
  await callIterator.return?.();
  await putIterator.return?.();
});

test("Deribit subscribe ACK resolves L1 ready before the first quote", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 50,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const lease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const socket = await waitForSocket(DERIBIT_WS_URL);
  await waitForDeribitControlFrame(socket, "public/subscribe", [
    `quote.${BTC_CALL_INSTRUMENT}`,
  ]);

  await lease.ready;
  expect(
    client.market.getL1Book({ venue: "deribit", symbol: BTC_CALL_SYMBOL }),
  ).toBeUndefined();
  expect(
    client.market.getMarketStatus({
      venue: "deribit",
      symbol: BTC_CALL_SYMBOL,
    }),
  ).toMatchObject({
    activity: "active",
    ready: false,
  });

  lease.close();
});

test("Deribit quote before subscribe ACK updates book and resolves L1 ready", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 200,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const iterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  const lease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const socket = await waitForSocket(DERIBIT_WS_URL);
  const controlId = await waitForDeribitControlFrame(
    socket,
    "public/subscribe",
    [`quote.${BTC_CALL_INSTRUMENT}`],
    300,
    false,
  );
  expect(controlId).toBeDefined();

  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000004,
    best_bid_price: 0.101,
    best_bid_amount: 2,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });

  const event = await nextEvent(iterator);
  expect(event.snapshot).toMatchObject({
    bidPrice: "0.101",
    askPrice: "0.102",
    status: {
      ready: true,
      freshness: "fresh",
    },
  });
  await lease.ready;

  socket.emitJson({
    jsonrpc: "2.0",
    id: controlId,
    result: [`quote.${BTC_CALL_INSTRUMENT}`],
  });
  await lease.ready;

  lease.close();
  await iterator.return?.();
});

test("Deribit subscribe ACK error rejects L1 ready", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 200,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const lease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const readyFailure = lease.ready.catch((error) => error);
  const socket = await waitForSocket(DERIBIT_WS_URL);
  const controlId = await waitForDeribitControlFrame(
    socket,
    "public/subscribe",
    [`quote.${BTC_CALL_INSTRUMENT}`],
    300,
    false,
  );
  expect(controlId).toBeDefined();
  socket.emitJson({
    jsonrpc: "2.0",
    id: controlId,
    error: {
      message: "invalid channel",
    },
  });

  expect(await readyFailure).toMatchObject({
    code: "MARKET_STREAM_TIMEOUT",
    details: {
      venue: "deribit",
      symbol: BTC_CALL_SYMBOL,
    },
  });
  expect(
    client.market.getMarketStatus({
      venue: "deribit",
      symbol: BTC_CALL_SYMBOL,
    }),
  ).toMatchObject({
    activity: "inactive",
    ready: false,
  });
});

test("Deribit ask-only first quote resolves L1 ready", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 200,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const iterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  const lease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const socket = await waitForSocket(DERIBIT_WS_URL);
  await waitForDeribitControlFrame(socket, "public/subscribe", [
    `quote.${BTC_CALL_INSTRUMENT}`,
  ]);

  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000003,
    best_bid_price: null,
    best_bid_amount: null,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });
  await lease.ready;

  const event = await nextEvent(iterator);
  expect(event.snapshot).toMatchObject({
    bidPrice: null,
    bidSize: null,
    askPrice: "0.102",
    askSize: "3",
    exchangeTs: 1710000000003,
    version: 1,
    status: {
      ready: true,
      freshness: "fresh",
    },
  });
  expect(event.snapshot.status.reason).toBeUndefined();
  expect(
    client.market.getL1Book({ venue: "deribit", symbol: BTC_CALL_SYMBOL }),
  ).toEqual(event.snapshot);

  lease.close();
  await iterator.return?.();
});

test("Deribit quote transitions publish nullable L1 updates", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 200,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const iterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  const lease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const socket = await waitForSocket(DERIBIT_WS_URL);
  await waitForDeribitControlFrame(socket, "public/subscribe", [
    `quote.${BTC_CALL_INSTRUMENT}`,
  ]);

  const updates = [
    {
      data: {
        timestamp: 1710000000001,
        best_bid_price: 0.101,
        best_bid_amount: 2,
        best_ask_price: 0.102,
        best_ask_amount: 3,
      },
      expected: {
        bidPrice: "0.101",
        bidSize: "2",
        askPrice: "0.102",
        askSize: "3",
      },
    },
    {
      data: {
        timestamp: 1710000000002,
        best_bid_price: 0.103,
        best_bid_amount: 4,
        best_ask_price: null,
        best_ask_amount: null,
      },
      expected: {
        bidPrice: "0.103",
        bidSize: "4",
        askPrice: null,
        askSize: null,
      },
    },
    {
      data: {
        timestamp: 1710000000003,
        best_bid_price: null,
        best_bid_amount: null,
        best_ask_price: 0.104,
        best_ask_amount: 5,
      },
      expected: {
        bidPrice: null,
        bidSize: null,
        askPrice: "0.104",
        askSize: "5",
      },
    },
    {
      data: {
        timestamp: 1710000000004,
        best_bid_price: null,
        best_bid_amount: null,
        best_ask_price: null,
        best_ask_amount: null,
      },
      expected: {
        bidPrice: null,
        bidSize: null,
        askPrice: null,
        askSize: null,
      },
    },
    {
      data: {
        timestamp: 1710000000005,
        best_bid_price: 0.105,
        best_bid_amount: 6,
        best_ask_price: 0.106,
        best_ask_amount: 7,
      },
      expected: {
        bidPrice: "0.105",
        bidSize: "6",
        askPrice: "0.106",
        askSize: "7",
      },
    },
  ] as const;

  for (const [index, update] of updates.entries()) {
    emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, update.data);
    if (index === 0) {
      await lease.ready;
    }

    const event = await nextEvent(iterator);
    expect(event.snapshot).toMatchObject({
      ...update.expected,
      exchangeTs: update.data.timestamp,
      version: index + 1,
      status: {
        ready: true,
        freshness: "fresh",
      },
    });
    expect(event.snapshot.status.reason).toBeUndefined();

    const latestBook = client.market.getL1Book({
      venue: "deribit",
      symbol: BTC_CALL_SYMBOL,
    });
    expect(latestBook).toEqual(event.snapshot);
    expect(
      client.market.getMarketStatus({
        venue: "deribit",
        symbol: BTC_CALL_SYMBOL,
      }),
    ).toMatchObject({
      ready: true,
      freshness: "fresh",
      reason: undefined,
    });
  }

  lease.close();
  await iterator.return?.();
});

test("Deribit empty quote recovers freshness after heartbeat stale", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 20,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const l1Iterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  const statusIterator = client.market.events
    .status({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  const lease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const socket = await waitForSocket(DERIBIT_WS_URL);
  await waitForDeribitControlFrame(socket, "public/subscribe", [
    `quote.${BTC_CALL_INSTRUMENT}`,
  ]);

  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000001,
    best_bid_price: 0.101,
    best_bid_amount: 2,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });
  await lease.ready;
  await nextEvent(l1Iterator);

  const staleStatus = await nextMatchingStatus(
    statusIterator,
    (event) => event.status.reason === "heartbeat_timeout",
  );
  expect(staleStatus.status).toMatchObject({
    ready: true,
    freshness: "stale",
    reason: "heartbeat_timeout",
  });

  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000002,
    best_bid_price: null,
    best_bid_amount: null,
    best_ask_price: null,
    best_ask_amount: null,
  });

  const emptyEvent = await nextEvent(l1Iterator);
  expect(emptyEvent.snapshot).toMatchObject({
    bidPrice: null,
    bidSize: null,
    askPrice: null,
    askSize: null,
    exchangeTs: 1710000000002,
    version: 2,
    status: {
      ready: true,
      freshness: "fresh",
    },
  });
  expect(emptyEvent.snapshot.status.reason).toBeUndefined();
  expect(
    client.market.getMarketStatus({
      venue: "deribit",
      symbol: BTC_CALL_SYMBOL,
    }),
  ).toMatchObject({
    ready: true,
    freshness: "fresh",
    reason: undefined,
  });

  lease.close();
  await l1Iterator.return?.();
  await statusIterator.return?.();
});

test("Deribit reconnect replays subscription and publishes nullable L1", async () => {
  installDeribitMarketInfra();
  const client = createClient({
    venues: ["deribit"],
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1ReconnectDelayMs: 5,
      l1ReconnectMaxDelayMs: 5,
      venues: {
        deribit: {
          underlyings: ["BTC"],
        },
      },
    },
  });

  await client.market.loadMarkets();
  await client.start();

  const iterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  const lease = await client.market.acquireL1BookSubscription({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  const firstSocket = await waitForSocket(DERIBIT_WS_URL);
  await waitForDeribitControlFrame(firstSocket, "public/subscribe", [
    `quote.${BTC_CALL_INSTRUMENT}`,
  ]);

  emitDeribitQuote(firstSocket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000001,
    best_bid_price: 0.101,
    best_bid_amount: 2,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });
  await lease.ready;
  await nextEvent(iterator);

  firstSocket.disconnect();
  const reconnectSocket = await waitForSocket(DERIBIT_WS_URL, 1, 100);
  await waitForDeribitControlFrame(reconnectSocket, "public/subscribe", [
    `quote.${BTC_CALL_INSTRUMENT}`,
  ]);
  emitDeribitQuote(reconnectSocket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000002,
    best_bid_price: null,
    best_bid_amount: null,
    best_ask_price: 0.104,
    best_ask_amount: 5,
  });

  const replayEvent = await nextEvent(iterator);
  expect(replayEvent.snapshot).toMatchObject({
    bidPrice: null,
    bidSize: null,
    askPrice: "0.104",
    askSize: "5",
    exchangeTs: 1710000000002,
    version: 2,
    status: {
      ready: true,
      freshness: "fresh",
    },
  });
  expect(replayEvent.snapshot.status.reason).toBeUndefined();

  lease.close();
  await iterator.return?.();
});
