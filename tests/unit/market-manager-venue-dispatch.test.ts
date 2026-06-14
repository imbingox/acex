import { expect, test } from "bun:test";
import { BinanceMarketAdapter } from "../../src/adapters/binance/adapter.ts";
import type {
  FetchPublicRawTradesRequest,
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawOrderUpdate,
  RawPublicTradesResult,
  RawSymbolFeeRate,
  StreamHandle,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { AcexError, type VenueErrorReason } from "../../src/errors.ts";
import { MarketManagerImpl } from "../../src/managers/market-manager.ts";
import type {
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  GetSymbolFeeRateInput,
  HealthEvent,
  MarketDefinition,
  Venue,
  VenueMarketCapabilities,
  VenueOrderCapabilities,
  VenueServerTime,
} from "../../src/types/index.ts";
import {
  BINANCE_USDM_WS_BASE_URL,
  installBinanceMarketInfra,
  waitForBinanceControlFrame,
} from "../support/exchanges/binance.ts";
import {
  createFakeOkxSpotMarket,
  createFakeOkxSwapMarket,
  FakeOkxMarketAdapter,
} from "../support/exchanges/okx.ts";
import {
  FakeWebSocket,
  textResponse,
  waitForSocket,
} from "../support/test-utils.ts";

class StubMarketContext implements ClientContext {
  readonly errors: AcexInternalError[] = [];
  readonly healthEvents: HealthEvent[] = [];
  readonly metricsEnabled = false;

  now(): number {
    return Date.now();
  }

  assertStarted(): void {}

  getRegisteredAccount(_accountId: string): RegisteredAccountRecord {
    throw new AcexError("ACCOUNT_NOT_FOUND", "Account not found");
  }

  getMarketDefinition(
    _venue: Venue,
    _symbol: string,
  ): MarketDefinition | undefined {
    return undefined;
  }

  getPrivateOrderCapabilities(
    _venue: Venue,
  ): VenueOrderCapabilities | undefined {
    return undefined;
  }

  normalizeVenueErrorCode(
    _venue: Venue,
    _code: string,
  ): VenueErrorReason | undefined {
    return undefined;
  }

  ensurePrivateCredentials(_accountId: string): void {}

  subscribePrivateAccountFeed(_accountId: string): Promise<void> {
    return Promise.resolve();
  }

  unsubscribePrivateAccountFeed(_accountId: string): void {}

  subscribePrivateOrderFeed(_accountId: string): Promise<void> {
    return Promise.resolve();
  }

  unsubscribePrivateOrderFeed(_accountId: string): void {}

  createOrder(_input: CreateOrderInput): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelOrder(_input: CancelOrderInput): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelAllOrders(_input: CancelAllOrdersInput): Promise<RawOrderUpdate[]> {
    throw new Error("not implemented");
  }

  fetchSymbolFeeRate(_input: GetSymbolFeeRateInput): Promise<RawSymbolFeeRate> {
    throw new Error("not implemented");
  }

  publishRuntimeError(
    source: AcexInternalError["source"],
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void {
    this.errors.push({
      source,
      error,
      ts: this.now(),
      ...metadata,
    });
  }

  publishHealthEvent(event: HealthEvent): void {
    this.healthEvents.push(event);
  }

  emitMetric(): void {}
}

class NotStartedMarketContext extends StubMarketContext {
  override assertStarted(): void {
    throw new AcexError("CLIENT_NOT_STARTED", "Client not started");
  }
}

class CountingMarketAdapter implements MarketAdapter {
  readonly venue: Venue;
  readonly marketCapabilities: VenueMarketCapabilities;
  readonly fetchPublicRawTrades?: MarketAdapter["fetchPublicRawTrades"];
  loadMarketsCalls = 0;
  publicRawTradesCalls = 0;
  l1BookStreamCalls = 0;
  fundingRateStreamCalls = 0;

  constructor(private readonly inner: MarketAdapter) {
    this.venue = inner.venue;
    this.marketCapabilities = inner.marketCapabilities;
    if (inner.fetchPublicRawTrades) {
      const fetchPublicRawTrades = inner.fetchPublicRawTrades.bind(inner);
      this.fetchPublicRawTrades = async (
        market: MarketDefinition,
        request: FetchPublicRawTradesRequest,
      ): Promise<RawPublicTradesResult> => {
        this.publicRawTradesCalls += 1;
        return await fetchPublicRawTrades(market, request);
      };
    }
  }

  async loadMarkets(): Promise<MarketDefinition[]> {
    this.loadMarketsCalls += 1;
    return await this.inner.loadMarkets();
  }

  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle {
    this.l1BookStreamCalls += 1;
    return this.inner.createL1BookStream(market, callbacks, options);
  }

  createFundingRateStream(
    market: MarketDefinition,
    callbacks: FundingRateStreamCallbacks,
    options: FundingRateStreamOptions,
  ): StreamHandle {
    this.fundingRateStreamCalls += 1;
    return this.inner.createFundingRateStream(market, callbacks, options);
  }
}

async function waitForValue<T>(
  read: () => T | undefined,
  timeoutMs = 100,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value) {
      return value;
    }

    await Bun.sleep(1);
  }

  throw new Error("Timed out waiting for value");
}

function createFakeSpotMarket(
  venue: Venue,
  symbol: string,
  id: string,
  base: string,
): MarketDefinition {
  return {
    ...createFakeOkxSpotMarket(venue),
    symbol,
    id,
    base,
    raw: { source: "fake-okx", id },
  };
}

test("MarketManager reloadMarkets refreshes one venue catalog and reports added symbols", async () => {
  const markets = [createFakeOkxSwapMarket("okx")];
  const okxAdapter = new FakeOkxMarketAdapter({ markets });
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await manager.loadMarkets();
  expect(okxAdapter.loadMarketsCalls).toBe(1);

  markets.push(createFakeSpotMarket("okx", "ETH/USDT", "ETH-USDT", "ETH"));
  const summaries = await manager.reloadMarkets("okx");

  expect(okxAdapter.loadMarketsCalls).toBe(2);
  expect(summaries).toEqual([
    {
      venue: "okx",
      added: ["ETH/USDT"],
      removed: [],
      total: 2,
      ok: true,
    },
  ]);
  expect(manager.getMarket("okx", "ETH/USDT")?.id).toBe("ETH-USDT");
  expect(manager.listMarkets("okx").map((market) => market.symbol)).toEqual([
    "BTC/USDT:USDT",
    "ETH/USDT",
  ]);
});

test("MarketManager reloadMarkets reports catalog failures without dropping the old catalog", async () => {
  const context = new StubMarketContext();
  const oldMarkets = [createFakeOkxSwapMarket("okx")];
  const okxAdapter = new FakeOkxMarketAdapter({
    loadMarketsResults: [oldMarkets, new Error("okx reload failed")],
  });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await manager.loadMarkets();
  const summaries = await manager.reloadMarkets("okx");

  expect(okxAdapter.loadMarketsCalls).toBe(2);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({
    venue: "okx",
    added: [],
    removed: [],
    total: 1,
    ok: false,
    error: { code: "MARKET_CATALOG_LOAD_FAILED" },
  });
  expect(manager.listMarkets("okx").map((market) => market.symbol)).toEqual([
    "BTC/USDT:USDT",
  ]);
  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "adapter",
    venue: "okx",
  });
});

test("MarketManager reloadMarkets rejects mixed-venue catalog results without replacing the old catalog", async () => {
  const context = new StubMarketContext();
  const oldMarkets = [createFakeOkxSwapMarket("okx")];
  const mixedMarkets = [
    createFakeOkxSwapMarket("okx"),
    createFakeSpotMarket("binance", "ETH/USDT", "ETH-USDT", "ETH"),
  ];
  const okxAdapter = new FakeOkxMarketAdapter({
    loadMarketsResults: [oldMarkets, mixedMarkets],
  });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await manager.loadMarkets();
  const summaries = await manager.reloadMarkets("okx");

  expect(summaries[0]).toMatchObject({
    venue: "okx",
    ok: false,
    error: { code: "MARKET_CATALOG_LOAD_FAILED" },
  });
  expect(manager.listMarkets("okx").map((market) => market.symbol)).toEqual([
    "BTC/USDT:USDT",
  ]);
  expect(manager.getMarket("binance", "ETH/USDT")).toBeUndefined();
  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]?.error.message).toContain("included binance market");
});

test("MarketManager reloadMarkets leaves existing L1 and funding subscriptions running", async () => {
  const markets = [createFakeOkxSwapMarket("okx")];
  const okxAdapter = new FakeOkxMarketAdapter({ markets });
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
    { initialL1TimeoutMs: 200 },
  );

  const l1Subscribe = manager.subscribeL1Book({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const l1Stream = await waitForValue(() => okxAdapter.l1BookStreams[0]);
  l1Stream.emitUpdate({
    bidPrice: "101.1",
    bidSize: "2",
    askPrice: "101.2",
    askSize: "3",
    receivedAt: 1710000000100,
  });
  await l1Subscribe;

  const fundingSubscribe = manager.subscribeFundingRate({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const fundingStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[0],
  );
  fundingStream.emitUpdate({
    fundingRate: "0.0001",
    receivedAt: 1710000000200,
  });
  await fundingSubscribe;

  markets.push(createFakeSpotMarket("okx", "ETH/USDT", "ETH-USDT", "ETH"));
  await manager.reloadMarkets("okx");

  l1Stream.emitUpdate({
    bidPrice: "102.1",
    bidSize: "4",
    askPrice: "102.2",
    askSize: "5",
    receivedAt: 1710000000300,
  });
  fundingStream.emitUpdate({
    fundingRate: "0.0002",
    receivedAt: 1710000000400,
  });

  expect(l1Stream.closeCalls).toBe(0);
  expect(fundingStream.closeCalls).toBe(0);
  expect(okxAdapter.l1BookStreams).toHaveLength(1);
  expect(okxAdapter.fundingRateStreams).toHaveLength(1);
  expect(
    manager.getL1Book({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ bidPrice: "102.1", version: 2 });
  expect(
    manager.getFundingRate({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ fundingRate: "0.0002", version: 2 });
});

test("MarketManager resumes market streams concurrently and isolates failures", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
    { initialL1TimeoutMs: 200 },
  );

  const l1Subscribe = manager.subscribeL1Book({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const initialL1Stream = await waitForValue(() => okxAdapter.l1BookStreams[0]);
  initialL1Stream.emitUpdate({
    bidPrice: "101.1",
    bidSize: "2",
    askPrice: "101.2",
    askSize: "3",
    receivedAt: 1710000000100,
  });
  await l1Subscribe;

  const fundingSubscribe = manager.subscribeFundingRate({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const initialFundingStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[0],
  );
  initialFundingStream.emitUpdate({
    fundingRate: "0.0001",
    receivedAt: 1710000000200,
  });
  await fundingSubscribe;

  manager.onClientStopping(1710000000300);
  manager.onClientStarted();

  const resumedL1Stream = await waitForValue(() => okxAdapter.l1BookStreams[1]);
  const resumedFundingStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[1],
  );

  resumedL1Stream.rejectReady(new Error("resumed l1 ready failed"));
  resumedFundingStream.emitUpdate({
    fundingRate: "0.0002",
    receivedAt: 1710000000400,
  });

  await waitForValue(() => {
    const fundingRate = manager.getFundingRate({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    });
    return fundingRate?.version === 2 ? fundingRate : undefined;
  });

  expect(resumedL1Stream.closeCalls).toBe(1);
  expect(context.errors).toContainEqual(
    expect.objectContaining({
      source: "runtime",
      error: expect.objectContaining({ code: "MARKET_STREAM_TIMEOUT" }),
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    }),
  );
  expect(
    manager.getFundingRate({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ fundingRate: "0.0002", version: 2 });
});

test("MarketManager closes failed initial market streams before dropping them", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const l1Subscribe = manager
    .subscribeL1Book({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    })
    .catch((error) => error);
  const l1Stream = await waitForValue(() => okxAdapter.l1BookStreams[0]);
  const l1Cause = new Error("l1 ready failed");
  l1Stream.rejectReady(l1Cause);

  const l1Failure = await l1Subscribe;
  expect(l1Failure).toBeInstanceOf(AcexError);
  expect(l1Failure).toMatchObject({
    code: "MARKET_STREAM_TIMEOUT",
    details: {
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    },
  });
  expect(l1Failure.cause).toBe(l1Cause);
  expect(l1Stream.closeCalls).toBe(1);

  const fundingSubscribe = manager
    .subscribeFundingRate({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    })
    .catch((error) => error);
  const fundingStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[0],
  );
  const fundingCause = new Error("funding ready failed");
  fundingStream.rejectReady(fundingCause);

  const fundingFailure = await fundingSubscribe;
  expect(fundingFailure).toBeInstanceOf(AcexError);
  expect(fundingFailure).toMatchObject({
    code: "MARKET_STREAM_TIMEOUT",
    details: {
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    },
  });
  expect(fundingFailure.cause).toBe(fundingCause);
  expect(fundingStream.closeCalls).toBe(1);
});

test("MarketManager coalesces concurrent reloadMarkets calls for the same venue", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await manager.loadMarkets();
  const results = await Promise.all([
    manager.reloadMarkets("okx"),
    manager.reloadMarkets("okx"),
    manager.reloadMarkets("okx"),
  ]);

  expect(okxAdapter.loadMarketsCalls).toBe(2);
  expect(results.map((summaries) => summaries[0])).toEqual([
    { venue: "okx", added: [], removed: [], total: 1, ok: true },
    { venue: "okx", added: [], removed: [], total: 1, ok: true },
    { venue: "okx", added: [], removed: [], total: 1, ok: true },
  ]);
});

test("MarketManager reloadMarkets isolates venues and full reload refreshes every registered venue", async () => {
  const okxMarkets = [createFakeOkxSwapMarket("okx")];
  const binanceMarkets = [createFakeOkxSwapMarket("binance")];
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
    markets: okxMarkets,
  });
  const binanceAdapter = new FakeOkxMarketAdapter({
    venue: "binance",
    markets: binanceMarkets,
  });
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([
      [okxAdapter.venue, okxAdapter],
      [binanceAdapter.venue, binanceAdapter],
    ]),
  );

  await manager.loadMarkets();
  okxMarkets.push(createFakeSpotMarket("okx", "ETH/USDT", "ETH-USDT", "ETH"));
  const okxOnly = await manager.reloadMarkets("okx");

  expect(okxOnly[0]).toMatchObject({
    venue: "okx",
    added: ["ETH/USDT"],
    total: 2,
    ok: true,
  });
  expect(okxAdapter.loadMarketsCalls).toBe(2);
  expect(binanceAdapter.loadMarketsCalls).toBe(1);
  expect(manager.getMarket("binance", "ETH/USDT")).toBeUndefined();

  binanceMarkets.push(
    createFakeSpotMarket("binance", "SOL/USDT", "SOL-USDT", "SOL"),
  );
  const full = await manager.reloadMarkets();

  expect(okxAdapter.loadMarketsCalls).toBe(3);
  expect(binanceAdapter.loadMarketsCalls).toBe(2);
  expect(full).toEqual([
    { venue: "okx", added: [], removed: [], total: 2, ok: true },
    {
      venue: "binance",
      added: ["SOL/USDT"],
      removed: [],
      total: 2,
      ok: true,
    },
  ]);
});

test("MarketManager full reload returns ok false only for venues with catalog failures", async () => {
  const context = new StubMarketContext();
  const okxMarkets = [createFakeOkxSwapMarket("okx")];
  const binanceMarkets = [createFakeOkxSwapMarket("binance")];
  const binanceReloadMarkets = [
    ...binanceMarkets,
    createFakeSpotMarket("binance", "SOL/USDT", "SOL-USDT", "SOL"),
  ];
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
    loadMarketsResults: [okxMarkets, new Error("okx full reload failed")],
  });
  const binanceAdapter = new FakeOkxMarketAdapter({
    venue: "binance",
    loadMarketsResults: [binanceMarkets, binanceReloadMarkets],
  });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([
      [okxAdapter.venue, okxAdapter],
      [binanceAdapter.venue, binanceAdapter],
    ]),
  );

  await manager.loadMarkets();
  const summaries = await manager.reloadMarkets();

  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toMatchObject({
    venue: "okx",
    added: [],
    removed: [],
    total: 1,
    ok: false,
    error: { code: "MARKET_CATALOG_LOAD_FAILED" },
  });
  expect(summaries[1]).toEqual({
    venue: "binance",
    added: ["SOL/USDT"],
    removed: [],
    total: 2,
    ok: true,
  });
  expect(manager.listMarkets("okx").map((market) => market.symbol)).toEqual([
    "BTC/USDT:USDT",
  ]);
  expect(manager.getMarket("binance", "SOL/USDT")?.id).toBe("SOL-USDT");
  expect(context.errors).toHaveLength(1);
});

test("MarketManager reloadMarkets throws for legal venues without registered market adapters", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(manager.reloadMarkets("bybit")).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
  });
  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "client",
    venue: "bybit",
  });
  expect(okxAdapter.loadMarketsCalls).toBe(0);
});

test("MarketManager reloadMarkets does not require a started client lifecycle", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(manager.reloadMarkets("okx")).resolves.toMatchObject([
    { venue: "okx", ok: true, total: 1 },
  ]);

  manager.onClientStopping(Date.now());

  await expect(manager.reloadMarkets("okx")).resolves.toMatchObject([
    { venue: "okx", ok: true, total: 1 },
  ]);
  expect(okxAdapter.loadMarketsCalls).toBe(2);
});

test("MarketManager fetchServerTime wraps Binance HTTP failures without retrying", async () => {
  let attempts = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      attempts += 1;
      return textResponse("binance down", {
        status: 503,
        statusText: "Service Unavailable",
      });
    },
  });

  const context = new StubMarketContext();
  const binanceAdapter = new BinanceMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[binanceAdapter.venue, binanceAdapter]]),
  );

  const failure = await manager
    .fetchServerTime("binance")
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "MARKET_SERVER_TIME_FETCH_FAILED",
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
  expect((failure as AcexError).cause).toBeInstanceOf(Error);
  expect((failure as AcexError).details?.venueError).toBeUndefined();
  expect((failure as AcexError).details?.orderState).toBeUndefined();

  expect(attempts).toBe(1);
  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "adapter",
    venue: "binance",
  });
  expect(context.errors[0]?.error).toMatchObject({
    name: "TransportError",
    attempts: 1,
  });
});

test("MarketManager fetchServerTime does not require a started client lifecycle", async () => {
  const serverTime: VenueServerTime = {
    serverTime: 2_000,
    requestSentAt: 1_000,
    responseReceivedAt: 1_020,
    roundTripMs: 7,
    estimatedOffsetMs: 990,
  };
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
  }) as FakeOkxMarketAdapter & {
    fetchServerTime(): Promise<VenueServerTime>;
  };
  okxAdapter.fetchServerTime = async () => serverTime;
  const manager = new MarketManagerImpl(
    new NotStartedMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(manager.fetchServerTime("okx")).resolves.toEqual(serverTime);
});

test("MarketManager fetchServerTime rejects venues without support", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter({ venue: "okx" });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(manager.fetchServerTime("okx")).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
  });
  await expect(manager.fetchServerTime("bybit")).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
  });

  expect(context.errors).toHaveLength(2);
  expect(context.errors.map((event) => event.venue)).toEqual(["okx", "bybit"]);
  expect(context.errors.every((event) => event.source === "client")).toBe(true);
});

test("MarketManager fetchPublicRawTrades does not require start and canonicalizes adapter output", async () => {
  const requests: Array<{
    market: MarketDefinition;
    request: FetchPublicRawTradesRequest;
  }> = [];
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
  }) as FakeOkxMarketAdapter & {
    fetchPublicRawTrades(
      market: MarketDefinition,
      request: FetchPublicRawTradesRequest,
    ): Promise<RawPublicTradesResult>;
  };
  okxAdapter.fetchPublicRawTrades = async (
    market,
    request,
  ): Promise<RawPublicTradesResult> => {
    requests.push({ market, request });
    return {
      trades: [
        {
          id: "10",
          price: "100.1000",
          amount: "0.0100",
          cost: "1.001000",
          side: "buy",
          exchangeTs: 1_000,
          receivedAt: 1_500,
          raw: {
            id: 10,
            price: "100.1000",
            qty: "0.0100",
          },
        },
      ],
      truncated: true,
      nextFromId: "11",
    };
  };
  const manager = new MarketManagerImpl(
    new NotStartedMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const result = await manager.fetchPublicRawTrades({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
    startTs: 1_000,
    limit: 1,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.market.symbol).toBe("BTC/USDT:USDT");
  expect(requests[0]?.request).toEqual({
    startTs: 1_000,
    limit: 1,
  });
  expect(result).toEqual({
    trades: [
      {
        venue: "okx",
        symbol: "BTC/USDT:USDT",
        id: "10",
        price: "100.1",
        amount: "0.01",
        cost: "1.001",
        side: "buy",
        exchangeTs: 1_000,
        receivedAt: 1_500,
        raw: {
          id: 10,
          price: "100.1000",
          qty: "0.0100",
        },
      },
    ],
    startTs: 1_000,
    limit: 1,
    truncated: true,
    nextFromId: "11",
  });
});

test("MarketManager fetchPublicRawTrades validates time-window inputs before loading catalogs", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.fetchPublicRawTrades({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1_000,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });
  await expect(
    manager.fetchPublicRawTrades({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1_000,
      endTs: 1_000,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });
  await expect(
    manager.fetchPublicRawTrades({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1_000,
      limit: 0,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });

  expect(okxAdapter.loadMarketsCalls).toBe(0);
  expect(context.errors).toHaveLength(3);
  expect(context.errors.every((event) => event.source === "market")).toBe(true);
});

test("MarketManager fetchPublicRawTrades rejects adapters without support", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter({ venue: "okx" });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.fetchPublicRawTrades({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1_000,
      limit: 1,
    }),
  ).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
    details: {
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    },
  });

  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "client",
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
});

test("MarketManager fetchPublicRawTrades wraps adapter failures", async () => {
  const context = new StubMarketContext();
  const cause = new Error("okx raw trades failed");
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
  }) as FakeOkxMarketAdapter & {
    fetchPublicRawTrades(
      market: MarketDefinition,
      request: FetchPublicRawTradesRequest,
    ): Promise<RawPublicTradesResult>;
  };
  okxAdapter.fetchPublicRawTrades = async () => {
    throw cause;
  };
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const failure = await manager
    .fetchPublicRawTrades({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1_000,
      limit: 1,
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "MARKET_PUBLIC_TRADES_FETCH_FAILED",
    details: {
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    },
  });
  expect((failure as AcexError).cause).toBe(cause);
  expect(context.errors).toContainEqual(
    expect.objectContaining({
      source: "adapter",
      error: cause,
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    }),
  );
});

test("MarketManager dispatches L1 subscriptions to the adapter for each venue", async () => {
  installBinanceMarketInfra();
  const binanceAdapter = new CountingMarketAdapter(new BinanceMarketAdapter());
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([
      [binanceAdapter.venue, binanceAdapter],
      [okxAdapter.venue, okxAdapter],
    ]),
    {
      initialL1TimeoutMs: 200,
      l1StaleAfterMs: 1_000,
    },
  );

  const binanceSubscribe = manager.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const binanceSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL);
  await waitForBinanceControlFrame(binanceSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
  ]);
  binanceSocket.emitJson({
    s: "BTCUSDT",
    b: "102000.10",
    B: "1.500",
    a: "102000.20",
    A: "2.500",
    T: 1710000000000,
  });
  await binanceSubscribe;

  expect(binanceAdapter.loadMarketsCalls).toBe(1);
  expect(binanceAdapter.l1BookStreamCalls).toBe(1);
  expect(okxAdapter.loadMarketsCalls).toBe(0);
  expect(okxAdapter.l1BookStreams).toHaveLength(0);
  expect(FakeWebSocket.instances).toHaveLength(1);

  const okxSubscribe = manager.subscribeL1Book({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const okxStream = await waitForValue(() => okxAdapter.l1BookStreams[0]);
  okxStream.emitUpdate({
    bidPrice: "101.1",
    bidSize: "2",
    askPrice: "101.2",
    askSize: "3",
    receivedAt: 1710000000100,
  });
  await okxSubscribe;

  expect(binanceAdapter.loadMarketsCalls).toBe(1);
  expect(binanceAdapter.l1BookStreamCalls).toBe(1);
  expect(okxAdapter.loadMarketsCalls).toBe(1);
  expect(okxAdapter.l1BookStreamMarkets.map((market) => market.venue)).toEqual([
    "okx",
  ]);

  expect(
    manager.getL1Book({ venue: "binance", symbol: "BTC/USDT:USDT" })?.venue,
  ).toBe("binance");
  expect(
    manager.getL1Book({ venue: "okx", symbol: "BTC/USDT:USDT" })?.venue,
  ).toBe("okx");
});

test("MarketManager rejects subscriptions for unregistered venues", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.subscribeL1Book({
      venue: "bybit",
      symbol: "BTC/USDT:USDT",
    }),
  ).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
  });

  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "client",
    venue: "bybit",
  });
  expect(okxAdapter.loadMarketsCalls).toBe(0);
});

test("MarketManager keeps one venue catalog failure isolated from another venue", async () => {
  const context = new StubMarketContext();
  const failingBinanceAdapter = new FakeOkxMarketAdapter({
    venue: "binance",
    failLoadMarkets: true,
  });
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([
      [failingBinanceAdapter.venue, failingBinanceAdapter],
      [okxAdapter.venue, okxAdapter],
    ]),
    {
      initialL1TimeoutMs: 200,
    },
  );

  await expect(
    manager.subscribeL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).rejects.toMatchObject({
    code: "MARKET_CATALOG_LOAD_FAILED",
  });

  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "adapter",
    venue: "binance",
  });
  expect(failingBinanceAdapter.loadMarketsCalls).toBe(1);

  const okxSubscribe = manager.subscribeL1Book({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const okxStream = await waitForValue(() => okxAdapter.l1BookStreams[0]);
  okxStream.emitUpdate({
    bidPrice: "101.1",
    bidSize: "2",
    askPrice: "101.2",
    askSize: "3",
    receivedAt: 1710000000200,
  });
  await okxSubscribe;

  expect(okxAdapter.loadMarketsCalls).toBe(1);
  expect(okxAdapter.l1BookStreams).toHaveLength(1);
  expect(manager.getMarket("okx", "BTC/USDT:USDT")?.venue).toBe("okx");
});
