import { expect, test } from "bun:test";
import { createClient, type MarketStatusChangedEvent } from "../../index.ts";
import { installBinanceMarketInfra } from "../support/exchanges/binance.ts";
import {
  DERIBIT_WS_URL,
  installDeribitMarketInfra,
  waitForDeribitControlFrame,
} from "../support/exchanges/deribit.ts";
import {
  expectPending,
  type FakeWebSocket,
  nextEvent,
  waitForSocket,
} from "../support/test-utils.ts";

const BTC_CALL_SYMBOL = "BTC/USD:BTC-20260621-57000-C";
const BTC_CALL_INSTRUMENT = "BTC-21JUN26-57000-C";

async function expectNoEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    iterator.next().then((value) => ({ kind: "event" as const, value })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }

  if (result.kind === "timeout") {
    await iterator.return?.();
    return;
  }

  if (result.kind === "event") {
    if (result.value.done) {
      throw new Error("Expected no event, iterator closed unexpectedly");
    }

    throw new Error(
      `Expected no event, received ${JSON.stringify(result.value.value)}`,
    );
  }
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

test("Deribit quote no_quote does not resolve ready or publish partial L1", async () => {
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
    best_bid_price: null,
    best_bid_amount: 2,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });

  await expectPending(lease.ready, 25);
  expect(
    client.market.getL1Book({ venue: "deribit", symbol: BTC_CALL_SYMBOL }),
  ).toBeUndefined();

  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000002,
    best_bid_price: 0.101,
    best_bid_amount: 2,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });
  await lease.ready;

  const completeBook = client.market.getL1Book({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  expect(completeBook).toMatchObject({
    bidPrice: "0.101",
    bidSize: "2",
    askPrice: "0.102",
    askSize: "3",
    exchangeTs: 1710000000002,
    version: 1,
    status: {
      freshness: "fresh",
    },
  });
  if (!completeBook) {
    throw new Error("Expected complete Deribit L1 book");
  }

  const noQuoteL1Iterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  await Bun.sleep(2);
  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000003,
    best_bid_price: 0.101,
    best_bid_amount: 0,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });

  const noQuoteStatus = await nextMatchingStatus(
    statusIterator,
    (event) => event.status.ready && event.status.reason === "no_quote",
  );
  expect(noQuoteStatus.status).toMatchObject({
    freshness: "stale",
    reason: "no_quote",
  });
  expect(noQuoteStatus.status.lastReceivedAt).toBeGreaterThanOrEqual(
    completeBook.receivedAt,
  );
  await expectNoEvent(noQuoteL1Iterator, 25);

  const staleBook = client.market.getL1Book({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  expect(staleBook).toMatchObject({
    bidPrice: completeBook.bidPrice,
    bidSize: completeBook.bidSize,
    askPrice: completeBook.askPrice,
    askSize: completeBook.askSize,
    exchangeTs: completeBook.exchangeTs,
    receivedAt: completeBook.receivedAt,
    updatedAt: completeBook.updatedAt,
    version: completeBook.version,
    status: {
      freshness: "stale",
      reason: "no_quote",
    },
  });
  expect(staleBook?.status.lastReceivedAt).toBeGreaterThanOrEqual(
    completeBook.receivedAt,
  );

  await Bun.sleep(2);
  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000004,
    best_bid_price: 0.101,
    best_bid_amount: 0,
    best_ask_price: 0.102,
    best_ask_amount: 3,
  });
  const repeatedNoQuoteStatus = await nextMatchingStatus(
    statusIterator,
    (event) =>
      event.status.ready &&
      event.status.reason === "no_quote" &&
      (event.status.lastReceivedAt ?? 0) >
        (noQuoteStatus.status.lastReceivedAt ?? 0),
  );
  expect(repeatedNoQuoteStatus.status).toMatchObject({
    freshness: "stale",
    reason: "no_quote",
  });
  const repeatedStaleBook = client.market.getL1Book({
    venue: "deribit",
    symbol: BTC_CALL_SYMBOL,
  });
  expect(repeatedStaleBook).toMatchObject({
    bidPrice: completeBook.bidPrice,
    bidSize: completeBook.bidSize,
    askPrice: completeBook.askPrice,
    askSize: completeBook.askSize,
    exchangeTs: completeBook.exchangeTs,
    receivedAt: completeBook.receivedAt,
    updatedAt: completeBook.updatedAt,
    version: completeBook.version,
    status: {
      freshness: "stale",
      reason: "no_quote",
    },
  });

  const l1Iterator = client.market.events
    .l1BookUpdates({ venue: "deribit", symbol: BTC_CALL_SYMBOL })
    [Symbol.asyncIterator]();
  emitDeribitQuote(socket, BTC_CALL_INSTRUMENT, {
    timestamp: 1710000000005,
    best_bid_price: 0.103,
    best_bid_amount: 4,
    best_ask_price: 0.104,
    best_ask_amount: 5,
  });

  const freshEvent = await nextEvent(l1Iterator);
  expect(freshEvent.snapshot).toMatchObject({
    bidPrice: "0.103",
    bidSize: "4",
    askPrice: "0.104",
    askSize: "5",
    exchangeTs: 1710000000005,
    version: 2,
    status: {
      freshness: "fresh",
      reason: undefined,
    },
  });

  lease.close();
  await statusIterator.return?.();
  await l1Iterator.return?.();
});
