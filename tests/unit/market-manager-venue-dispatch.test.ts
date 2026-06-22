import { expect, test } from "bun:test";
import { BinanceMarketAdapter } from "../../src/adapters/binance/adapter.ts";
import type {
  FetchFundingRateHistoryRequest,
  FetchPublicRawTradesRequest,
  FetchPublicTradesRequest,
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawFundingRateHistoryResult,
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
  expectPending,
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

  fetchFundingFeeHistory(): never {
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
  readonly fetchPublicTrades?: MarketAdapter["fetchPublicTrades"];
  readonly fetchPublicRawTrades?: MarketAdapter["fetchPublicRawTrades"];
  loadMarketsCalls = 0;
  publicTradesCalls = 0;
  publicRawTradesCalls = 0;
  l1BookStreamCalls = 0;
  fundingRateStreamCalls = 0;

  constructor(private readonly inner: MarketAdapter) {
    this.venue = inner.venue;
    this.marketCapabilities = inner.marketCapabilities;
    if (inner.fetchPublicTrades) {
      const fetchPublicTrades = inner.fetchPublicTrades.bind(inner);
      this.fetchPublicTrades = async (
        market: MarketDefinition,
        request: FetchPublicTradesRequest,
      ): Promise<RawPublicTradesResult> => {
        this.publicTradesCalls += 1;
        return await fetchPublicTrades(market, request);
      };
    }
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

class ThrowingCreateMarketAdapter extends FakeOkxMarketAdapter {
  failNextL1BookStream = false;
  failNextFundingRateStream = false;

  override createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle {
    if (this.failNextL1BookStream) {
      this.failNextL1BookStream = false;
      throw new Error("sync l1 create failed");
    }

    return super.createL1BookStream(market, callbacks, options);
  }

  override createFundingRateStream(
    market: MarketDefinition,
    callbacks: FundingRateStreamCallbacks,
    options: FundingRateStreamOptions,
  ): StreamHandle {
    if (this.failNextFundingRateStream) {
      this.failNextFundingRateStream = false;
      throw new Error("sync funding create failed");
    }

    return super.createFundingRateStream(market, callbacks, options);
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

  const l1Lease = await manager.acquireL1BookSubscription({
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
  await l1Lease.ready;

  const fundingLease = await manager.acquireFundingRateSubscription({
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
  await fundingLease.ready;

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

  const l1Lease = await manager.acquireL1BookSubscription({
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
  await l1Lease.ready;

  const fundingLease = await manager.acquireFundingRateSubscription({
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
  await fundingLease.ready;

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

  const l1Lease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const l1Subscribe = l1Lease.ready.catch((error) => error);
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

  const fundingLease = await manager.acquireFundingRateSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const fundingSubscribe = fundingLease.ready.catch((error) => error);
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

test("MarketManager L1 leases share one stream and close only after the last lease", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const [firstLease, secondLease] = await Promise.all([
    manager.acquireL1BookSubscription({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    }),
    manager.acquireL1BookSubscription({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    }),
  ]);
  const stream = await waitForValue(() => okxAdapter.l1BookStreams[0]);

  expect(okxAdapter.l1BookStreams).toHaveLength(1);
  stream.emitUpdate({
    bidPrice: "101.1",
    bidSize: "2",
    askPrice: "101.2",
    askSize: "3",
    receivedAt: 1710000000100,
  });
  await Promise.all([firstLease.ready, secondLease.ready]);

  firstLease.close();
  firstLease.close();
  expect(stream.closeCalls).toBe(0);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "active", ready: true });

  stream.emitUpdate({
    bidPrice: "102.1",
    bidSize: "4",
    askPrice: "102.2",
    askSize: "5",
    receivedAt: 1710000000200,
  });
  expect(
    manager.getL1Book({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ bidPrice: "102.1", version: 2 });

  secondLease.close();
  expect(stream.closeCalls).toBe(1);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });
});

test("MarketManager funding leases share one stream and close only after the last lease", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const [firstLease, secondLease] = await Promise.all([
    manager.acquireFundingRateSubscription({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    }),
    manager.acquireFundingRateSubscription({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    }),
  ]);
  const stream = await waitForValue(() => okxAdapter.fundingRateStreams[0]);

  expect(okxAdapter.fundingRateStreams).toHaveLength(1);
  stream.emitUpdate({
    fundingRate: "0.0001",
    receivedAt: 1710000000100,
  });
  await Promise.all([firstLease.ready, secondLease.ready]);

  firstLease.close();
  expect(stream.closeCalls).toBe(0);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "active", ready: true });

  secondLease.close();
  secondLease.close();
  expect(stream.closeCalls).toBe(1);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });
});

test("MarketManager initial stream failure rejects pending leases and allows a fresh acquire", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const firstLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const secondLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const firstFailure = firstLease.ready.catch((error) => error);
  const secondFailure = secondLease.ready.catch((error) => error);
  const failedStream = await waitForValue(() => okxAdapter.l1BookStreams[0]);

  failedStream.rejectReady(new Error("initial l1 failed"));

  expect(await firstFailure).toMatchObject({ code: "MARKET_STREAM_TIMEOUT" });
  expect(await secondFailure).toMatchObject({ code: "MARKET_STREAM_TIMEOUT" });
  expect(failedStream.closeCalls).toBe(1);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });

  const recoveredLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const recoveredStream = await waitForValue(() => okxAdapter.l1BookStreams[1]);
  recoveredStream.emitUpdate({
    bidPrice: "103.1",
    bidSize: "6",
    askPrice: "103.2",
    askSize: "7",
    receivedAt: 1710000000300,
  });
  await recoveredLease.ready;

  expect(okxAdapter.l1BookStreams).toHaveLength(2);
  expect(
    manager.getL1Book({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ bidPrice: "103.1", version: 1 });
});

test("MarketManager L1 reacquire after close waits for the new stream before ready", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const firstLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const firstStream = await waitForValue(() => okxAdapter.l1BookStreams[0]);
  firstStream.emitUpdate({
    bidPrice: "103.1",
    bidSize: "6",
    askPrice: "103.2",
    askSize: "7",
    receivedAt: 1710000000300,
  });
  await firstLease.ready;
  firstLease.close();

  expect(
    manager.getL1Book({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ bidPrice: "103.1" });
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });

  const reacquiredLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  await expectPending(reacquiredLease.ready, 10);
  const readyFailure = reacquiredLease.ready.catch((error) => error);
  const failedStream = await waitForValue(() => okxAdapter.l1BookStreams[1]);

  failedStream.rejectReady(new Error("fresh l1 failed"));

  expect(await readyFailure).toMatchObject({ code: "MARKET_STREAM_TIMEOUT" });
  expect(failedStream.closeCalls).toBe(1);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });

  const recoveredLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const recoveredStream = await waitForValue(() => okxAdapter.l1BookStreams[2]);
  recoveredStream.emitUpdate({
    bidPrice: "104.1",
    bidSize: "8",
    askPrice: "104.2",
    askSize: "9",
    receivedAt: 1710000000400,
  });
  await recoveredLease.ready;
  expect(okxAdapter.l1BookStreams).toHaveLength(3);
});

test("MarketManager funding reacquire after close waits for the new stream before ready", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const firstLease = await manager.acquireFundingRateSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const firstStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[0],
  );
  firstStream.emitUpdate({
    fundingRate: "0.0001",
    receivedAt: 1710000000300,
  });
  await firstLease.ready;
  firstLease.close();

  expect(
    manager.getFundingRate({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ fundingRate: "0.0001" });
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });

  const reacquiredLease = await manager.acquireFundingRateSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  await expectPending(reacquiredLease.ready, 10);
  const readyFailure = reacquiredLease.ready.catch((error) => error);
  const failedStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[1],
  );

  failedStream.rejectReady(new Error("fresh funding failed"));

  expect(await readyFailure).toMatchObject({ code: "MARKET_STREAM_TIMEOUT" });
  expect(failedStream.closeCalls).toBe(1);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });

  const recoveredLease = await manager.acquireFundingRateSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const recoveredStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[2],
  );
  recoveredStream.emitUpdate({
    fundingRate: "0.0002",
    receivedAt: 1710000000400,
  });
  await recoveredLease.ready;
  expect(okxAdapter.fundingRateStreams).toHaveLength(3);
});

test("MarketManager pending leases survive client stop and resolve after restart", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const lease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const initialStream = await waitForValue(() => okxAdapter.l1BookStreams[0]);

  manager.onClientStopping(1710000000100);

  expect(initialStream.closeCalls).toBe(1);
  await expectPending(lease.ready, 10);

  manager.onClientStarted();
  const resumedStream = await waitForValue(() => okxAdapter.l1BookStreams[1]);
  resumedStream.emitUpdate({
    bidPrice: "104.1",
    bidSize: "8",
    askPrice: "104.2",
    askSize: "9",
    receivedAt: 1710000000200,
  });
  await lease.ready;

  expect(
    manager.getL1Book({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ bidPrice: "104.1", version: 1 });
});

test("MarketManager restart stream creation failure rejects pending leases", async () => {
  const okxAdapter = new ThrowingCreateMarketAdapter();
  const context = new StubMarketContext();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const l1Lease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const fundingLease = await manager.acquireFundingRateSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const l1Failure = l1Lease.ready.catch((error) => error);
  const fundingFailure = fundingLease.ready.catch((error) => error);
  const l1Stream = await waitForValue(() => okxAdapter.l1BookStreams[0]);
  const fundingStream = await waitForValue(
    () => okxAdapter.fundingRateStreams[0],
  );

  manager.onClientStopping(1710000000100);
  okxAdapter.failNextL1BookStream = true;
  okxAdapter.failNextFundingRateStream = true;
  manager.onClientStarted();

  expect(l1Stream.closeCalls).toBe(1);
  expect(fundingStream.closeCalls).toBe(1);
  expect(await l1Failure).toMatchObject({ code: "MARKET_STREAM_TIMEOUT" });
  expect(await fundingFailure).toMatchObject({
    code: "MARKET_STREAM_TIMEOUT",
  });
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });
  expect(context.errors).toHaveLength(2);

  const recoveredLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const recoveredStream = await waitForValue(() => okxAdapter.l1BookStreams[1]);
  recoveredStream.emitUpdate({
    bidPrice: "106.1",
    bidSize: "12",
    askPrice: "106.2",
    askSize: "13",
    receivedAt: 1710000000300,
  });
  await recoveredLease.ready;
});

test("MarketManager closing a pending stopped lease prevents restart recovery", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const lease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const readyFailure = lease.ready.catch((error) => error);
  const initialStream = await waitForValue(() => okxAdapter.l1BookStreams[0]);

  manager.onClientStopping(1710000000100);
  lease.close();
  manager.onClientStarted();

  expect(initialStream.closeCalls).toBe(1);
  expect(await readyFailure).toMatchObject({
    message: expect.stringContaining("closed before ready"),
  });
  await Bun.sleep(5);
  expect(okxAdapter.l1BookStreams).toHaveLength(1);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive", ready: false });
});

test("MarketManager close before ready rejects that lease without closing other active leases", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const firstLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const secondLease = await manager.acquireL1BookSubscription({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
  });
  const firstFailure = firstLease.ready.catch((error) => error);
  const stream = await waitForValue(() => okxAdapter.l1BookStreams[0]);

  firstLease.close();

  expect(await firstFailure).toMatchObject({
    message: expect.stringContaining("closed before ready"),
  });
  expect(stream.closeCalls).toBe(0);

  stream.emitUpdate({
    bidPrice: "105.1",
    bidSize: "10",
    askPrice: "105.2",
    askSize: "11",
    receivedAt: 1710000000300,
  });
  await secondLease.ready;
  expect(
    manager.getL1Book({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ bidPrice: "105.1", version: 1 });
});

test("MarketManager L1 and funding leases are independent for the same market", async () => {
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    new StubMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const l1Lease = await manager.acquireL1BookSubscription({
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
  await l1Lease.ready;

  const fundingLease = await manager.acquireFundingRateSubscription({
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
  await fundingLease.ready;

  l1Lease.close();

  expect(l1Stream.closeCalls).toBe(1);
  expect(fundingStream.closeCalls).toBe(0);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "active", ready: true });
  expect(
    manager.getFundingRate({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({
    status: {
      activity: "active",
      freshness: "fresh",
    },
  });

  fundingLease.close();
  expect(fundingStream.closeCalls).toBe(1);
  expect(
    manager.getMarketStatus({ venue: "okx", symbol: "BTC/USDT:USDT" }),
  ).toMatchObject({ activity: "inactive" });
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

test("MarketManager fetchPublicTrades does not require start and canonicalizes adapter output", async () => {
  const requests: Array<{
    market: MarketDefinition;
    request: FetchPublicTradesRequest;
  }> = [];
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
  }) as FakeOkxMarketAdapter & {
    fetchPublicTrades(
      market: MarketDefinition,
      request: FetchPublicTradesRequest,
    ): Promise<RawPublicTradesResult>;
  };
  okxAdapter.fetchPublicTrades = async (
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

  const result = await manager.fetchPublicTrades({
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
  });
});

test("MarketManager fetchPublicTrades validates time-window inputs before loading catalogs", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.fetchPublicTrades({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1_000,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });
  await expect(
    manager.fetchPublicTrades({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1_000,
      endTs: 1_000,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });
  await expect(
    manager.fetchPublicTrades({
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

test("MarketManager fetchPublicTrades rejects adapters without support", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter({ venue: "okx" });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.fetchPublicTrades({
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

test("MarketManager fetchPublicTrades wraps adapter failures", async () => {
  const context = new StubMarketContext();
  const cause = new Error("okx trades failed");
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
  }) as FakeOkxMarketAdapter & {
    fetchPublicTrades(
      market: MarketDefinition,
      request: FetchPublicTradesRequest,
    ): Promise<RawPublicTradesResult>;
  };
  okxAdapter.fetchPublicTrades = async () => {
    throw cause;
  };
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const failure = await manager
    .fetchPublicTrades({
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
          id: "100",
          price: "100.1000",
          amount: "0.0100",
          cost: "1.001000",
          side: "sell",
          exchangeTs: 1_000,
          receivedAt: 1_500,
          raw: {
            id: 100,
            price: "100.1000",
            qty: "0.0100",
          },
        },
      ],
      truncated: false,
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
    endTs: 2_000,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.market.symbol).toBe("BTC/USDT:USDT");
  expect(requests[0]?.request).toEqual({
    startTs: 1_000,
    endTs: 2_000,
  });
  expect(result).toEqual({
    trades: [
      {
        venue: "okx",
        symbol: "BTC/USDT:USDT",
        id: "100",
        price: "100.1",
        amount: "0.01",
        cost: "1.001",
        side: "sell",
        exchangeTs: 1_000,
        receivedAt: 1_500,
        raw: {
          id: 100,
          price: "100.1000",
          qty: "0.0100",
        },
      },
    ],
    startTs: 1_000,
    endTs: 2_000,
    truncated: false,
  });
});

test("MarketManager fetchPublicRawTrades rejects adapters without support before loading catalogs", async () => {
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

  expect(okxAdapter.loadMarketsCalls).toBe(0);
  expect(context.errors).toContainEqual(
    expect.objectContaining({
      source: "client",
      venue: "okx",
      symbol: "BTC/USDT:USDT",
    }),
  );
});

test("MarketManager fetchFundingRateHistory does not require start and canonicalizes adapter output", async () => {
  const requests: Array<{
    market: MarketDefinition;
    request: FetchFundingRateHistoryRequest;
  }> = [];
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
  }) as FakeOkxMarketAdapter & {
    fetchFundingRateHistory(
      market: MarketDefinition,
      request: FetchFundingRateHistoryRequest,
    ): Promise<RawFundingRateHistoryResult>;
  };
  okxAdapter.fetchFundingRateHistory = async (
    market,
    request,
  ): Promise<RawFundingRateHistoryResult> => {
    requests.push({ market, request });
    return {
      rates: [
        {
          fundingRate: "0.00010000",
          fundingTime: 1_700_000_000_000,
          markPrice: "34287.5461996300",
          receivedAt: 1_700_000_000_500,
          raw: {
            fundingRate: "0.00010000",
            fundingTime: 1_700_000_000_000,
            markPrice: "34287.5461996300",
          },
        },
      ],
      truncated: true,
    };
  };
  const manager = new MarketManagerImpl(
    new NotStartedMarketContext(),
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const result = await manager.fetchFundingRateHistory({
    venue: "okx",
    symbol: "BTC/USDT:USDT",
    startTs: 1_000,
    endTs: 2_000,
    limit: 1,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.market.symbol).toBe("BTC/USDT:USDT");
  expect(requests[0]?.request).toEqual({
    startTs: 1_000,
    endTs: 2_000,
    limit: 1,
  });
  expect(result).toEqual({
    rates: [
      {
        venue: "okx",
        symbol: "BTC/USDT:USDT",
        fundingRate: "0.0001",
        fundingTime: 1_700_000_000_000,
        markPrice: "34287.54619963",
        receivedAt: 1_700_000_000_500,
        raw: {
          fundingRate: "0.00010000",
          fundingTime: 1_700_000_000_000,
          markPrice: "34287.5461996300",
        },
      },
    ],
    startTs: 1_000,
    endTs: 2_000,
    limit: 1,
    truncated: true,
  });
});

test("MarketManager fetchFundingRateHistory validates inputs before loading catalogs", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter();
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.fetchFundingRateHistory({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 1.5,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });
  await expect(
    manager.fetchFundingRateHistory({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      startTs: 2_000,
      endTs: 1_000,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });
  await expect(
    manager.fetchFundingRateHistory({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      limit: 0,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });
  await expect(
    manager.fetchFundingRateHistory({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      limit: 1_001,
    }),
  ).rejects.toMatchObject({
    code: "MARKET_INPUT_INVALID",
  });

  expect(okxAdapter.loadMarketsCalls).toBe(0);
  expect(context.errors).toHaveLength(4);
  expect(context.errors.every((event) => event.source === "market")).toBe(true);
});

test("MarketManager fetchFundingRateHistory rejects non-swap markets", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
    markets: [createFakeOkxSpotMarket("okx")],
  });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.fetchFundingRateHistory({
      venue: "okx",
      symbol: "BTC/USDT",
    }),
  ).rejects.toMatchObject({
    code: "MARKET_FUNDING_RATE_UNSUPPORTED",
    details: {
      venue: "okx",
      symbol: "BTC/USDT",
    },
  });
});

test("MarketManager fetchFundingRateHistory rejects adapters without support", async () => {
  const context = new StubMarketContext();
  const okxAdapter = new FakeOkxMarketAdapter({ venue: "okx" });
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  await expect(
    manager.fetchFundingRateHistory({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
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

test("MarketManager fetchFundingRateHistory wraps adapter failures", async () => {
  const context = new StubMarketContext();
  const cause = new Error("okx funding history failed");
  const okxAdapter = new FakeOkxMarketAdapter({
    venue: "okx",
  }) as FakeOkxMarketAdapter & {
    fetchFundingRateHistory(
      market: MarketDefinition,
      request: FetchFundingRateHistoryRequest,
    ): Promise<RawFundingRateHistoryResult>;
  };
  okxAdapter.fetchFundingRateHistory = async () => {
    throw cause;
  };
  const manager = new MarketManagerImpl(
    context,
    new Map<Venue, MarketAdapter>([[okxAdapter.venue, okxAdapter]]),
  );

  const failure = await manager
    .fetchFundingRateHistory({
      venue: "okx",
      symbol: "BTC/USDT:USDT",
      limit: 1,
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED",
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

  const binanceLease = await manager.acquireL1BookSubscription({
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
  await binanceLease.ready;

  expect(binanceAdapter.loadMarketsCalls).toBe(1);
  expect(binanceAdapter.l1BookStreamCalls).toBe(1);
  expect(okxAdapter.loadMarketsCalls).toBe(0);
  expect(okxAdapter.l1BookStreams).toHaveLength(0);
  expect(FakeWebSocket.instances).toHaveLength(1);

  const okxLease = await manager.acquireL1BookSubscription({
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
  await okxLease.ready;

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
    manager.acquireL1BookSubscription({
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
    manager.acquireL1BookSubscription({
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

  const okxLease = await manager.acquireL1BookSubscription({
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
  await okxLease.ready;

  expect(okxAdapter.loadMarketsCalls).toBe(1);
  expect(okxAdapter.l1BookStreams).toHaveLength(1);
  expect(manager.getMarket("okx", "BTC/USDT:USDT")?.venue).toBe("okx");
});
