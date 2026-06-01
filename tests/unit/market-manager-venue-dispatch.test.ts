import { expect, test } from "bun:test";
import { BinanceMarketAdapter } from "../../src/adapters/binance/adapter.ts";
import type {
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawOrderUpdate,
  StreamHandle,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { AcexError } from "../../src/errors.ts";
import { MarketManagerImpl } from "../../src/managers/market-manager.ts";
import type {
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  HealthEvent,
  MarketDefinition,
  Venue,
  VenueMarketCapabilities,
} from "../../src/types/index.ts";
import {
  BINANCE_USDM_WS_BASE_URL,
  installBinanceMarketInfra,
  waitForBinanceControlFrame,
} from "../support/exchanges/binance.ts";
import { FakeOkxMarketAdapter } from "../support/exchanges/okx.ts";
import { FakeWebSocket, waitForSocket } from "../support/test-utils.ts";

class StubMarketContext implements ClientContext {
  readonly errors: AcexInternalError[] = [];
  readonly healthEvents: HealthEvent[] = [];

  now(): number {
    return Date.now();
  }

  assertStarted(): void {}

  getRegisteredAccount(_accountId: string): RegisteredAccountRecord {
    throw new AcexError("ACCOUNT_NOT_FOUND", "Account not found");
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
}

class CountingMarketAdapter implements MarketAdapter {
  readonly venue: Venue;
  readonly marketCapabilities: VenueMarketCapabilities;
  loadMarketsCalls = 0;
  l1BookStreamCalls = 0;
  fundingRateStreamCalls = 0;

  constructor(private readonly inner: MarketAdapter) {
    this.venue = inner.venue;
    this.marketCapabilities = inner.marketCapabilities;
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
