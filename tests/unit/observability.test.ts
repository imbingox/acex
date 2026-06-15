import { expect, test } from "bun:test";
import type {
  RawOrderUpdate,
  RawSymbolFeeRate,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { AcexClientImpl } from "../../src/client/runtime.ts";
import { AcexError, type VenueErrorReason } from "../../src/errors.ts";
import { MarketManagerImpl } from "../../src/managers/market-manager.ts";
import { OrderManagerImpl } from "../../src/managers/order-manager.ts";
import type {
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  GetSymbolFeeRateInput,
  HealthEvent,
  MarketDefinition,
  MetricType,
  Venue,
  VenueOrderCapabilities,
} from "../../src/types/index.ts";
import { METRIC_NAMES } from "../../src/types/index.ts";
import { FakeOkxMarketAdapter } from "../support/exchanges/okx.ts";

interface MetricCall {
  name: string;
  value: number;
  type: MetricType;
  tags?: Record<string, string>;
}

class MetricContext implements ClientContext {
  readonly metrics: MetricCall[] = [];
  metricsEnabled: boolean;
  createOrderError: Error | undefined;
  throwOnMetric = false;

  constructor(metricsEnabled = true) {
    this.metricsEnabled = metricsEnabled;
  }

  now(): number {
    return 1710000000000;
  }

  assertStarted(): void {}

  getRegisteredAccount(accountId: string): RegisteredAccountRecord {
    return {
      accountId,
      venue: "binance",
      credentials: {
        apiKey: "key",
        secret: "secret",
      },
    };
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

  createOrder(input: CreateOrderInput): Promise<RawOrderUpdate> {
    if (this.createOrderError) {
      return Promise.reject(this.createOrderError);
    }

    return Promise.resolve({
      orderId: "1001",
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      status: "open",
      price: input.type === "limit" ? input.price : undefined,
      amount: input.amount,
      filled: "0",
      receivedAt: this.now(),
    });
  }

  cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate> {
    return Promise.resolve({
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: "buy",
      type: "limit",
      status: "canceled",
      amount: "1",
      filled: "0",
      receivedAt: this.now(),
    });
  }

  cancelAllOrders(input: CancelAllOrdersInput): Promise<RawOrderUpdate[]> {
    return Promise.resolve([
      {
        orderId: "1002",
        symbol: input.symbol,
        side: "buy",
        type: "limit",
        status: "canceled",
        amount: "1",
        filled: "0",
        receivedAt: this.now(),
      },
    ]);
  }

  fetchSymbolFeeRate(_input: GetSymbolFeeRateInput): Promise<RawSymbolFeeRate> {
    throw new Error("not implemented");
  }

  publishRuntimeError(
    _source: AcexInternalError["source"],
    _error: Error,
    _metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void {}

  publishHealthEvent(_event: HealthEvent): void {}

  emitMetric(
    name: string,
    value: number,
    type: MetricType,
    tags?: Record<string, string>,
  ): void {
    if (this.throwOnMetric) {
      throw new Error("emitMetric should not be called");
    }

    this.metrics.push({ name, value, type, tags });
  }
}

async function waitForValue<T>(
  read: () => T | undefined,
  label: string,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 100) {
    const value = read();
    if (value !== undefined) {
      return value;
    }

    await Bun.sleep(1);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

test("order commands emit RTT timing metrics with operation and outcome tags", async () => {
  const context = new MetricContext();
  const manager = new OrderManagerImpl(context);

  await manager.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "100000",
    amount: "0.001",
  });
  await manager.cancelOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    orderId: "1001",
  });
  await manager.cancelAllOrders({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(context.metrics).toHaveLength(3);
  expect(context.metrics.map((metric) => metric.name)).toEqual([
    METRIC_NAMES.orderCommandRtt,
    METRIC_NAMES.orderCommandRtt,
    METRIC_NAMES.orderCommandRtt,
  ]);
  expect(context.metrics.map((metric) => metric.type)).toEqual([
    "timing",
    "timing",
    "timing",
  ]);
  expect(context.metrics.map((metric) => metric.tags)).toEqual([
    {
      venue: "binance",
      op: "create",
      accountId: "main-binance",
      outcome: "success",
    },
    {
      venue: "binance",
      op: "cancel",
      accountId: "main-binance",
      outcome: "success",
    },
    {
      venue: "binance",
      op: "cancelAll",
      accountId: "main-binance",
      outcome: "success",
    },
  ]);
  for (const metric of context.metrics) {
    expect(metric.value).toBeGreaterThanOrEqual(0);
  }
});

test("order command RTT metrics report error outcome when the command fails", async () => {
  const context = new MetricContext();
  context.createOrderError = new Error("venue rejected order");
  const manager = new OrderManagerImpl(context);

  await expect(
    manager.createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "100000",
      amount: "0.001",
    }),
  ).rejects.toBeInstanceOf(AcexError);

  expect(context.metrics).toHaveLength(1);
  expect(context.metrics[0]).toMatchObject({
    name: METRIC_NAMES.orderCommandRtt,
    type: "timing",
    tags: {
      venue: "binance",
      op: "create",
      accountId: "main-binance",
      outcome: "error",
    },
  });
  expect(context.metrics[0]?.value).toBeGreaterThanOrEqual(0);
});

test("L1 updates emit websocket message latency only when metrics are enabled", async () => {
  const context = new MetricContext();
  const adapter = new FakeOkxMarketAdapter({ venue: "binance" });
  const manager = new MarketManagerImpl(
    context,
    new Map([["binance", adapter]]),
  );

  const l1Lease = await manager.acquireL1BookSubscription({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const subscribePromise = l1Lease.ready;
  const stream = await waitForValue(
    () => adapter.l1BookStreams[0],
    "l1 stream",
  );
  stream.emitUpdate({
    bidPrice: "100000",
    bidSize: "1",
    askPrice: "100001",
    askSize: "2",
    exchangeTs: 1710000000100,
    receivedAt: 1710000000125,
  });
  await subscribePromise;

  expect(context.metrics).toEqual([
    {
      name: METRIC_NAMES.wsMessageLatency,
      value: 25,
      type: "timing",
      tags: {
        venue: "binance",
        channel: "l1book",
        symbol: "BTC/USDT:USDT",
      },
    },
  ]);

  const disabledContext = new MetricContext(false);
  disabledContext.throwOnMetric = true;
  const disabledAdapter = new FakeOkxMarketAdapter({ venue: "binance" });
  const disabledManager = new MarketManagerImpl(
    disabledContext,
    new Map([["binance", disabledAdapter]]),
  );
  const disabledLease = await disabledManager.acquireL1BookSubscription({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const disabledSubscribe = disabledLease.ready;
  const disabledStream = await waitForValue(
    () => disabledAdapter.l1BookStreams[0],
    "disabled l1 stream",
  );
  disabledStream.emitUpdate({
    bidPrice: "100000",
    bidSize: "1",
    askPrice: "100001",
    askSize: "2",
    exchangeTs: 1710000000100,
    receivedAt: 1710000000125,
  });
  await disabledSubscribe;

  expect(disabledContext.metrics).toHaveLength(0);
});

test("event buffer overflow emits a counter metric", async () => {
  const metrics: MetricCall[] = [];
  const client = new AcexClientImpl({
    onMetric(name, value, type, tags) {
      metrics.push({ name, value, type, tags });
    },
  });
  const iterator = client.events
    .health(undefined, { maxBuffer: 1 })
    [Symbol.asyncIterator]();

  client.publishHealthEvent({
    type: "client.status_changed",
    status: "starting",
    ts: 1,
  });
  client.publishHealthEvent({
    type: "client.status_changed",
    status: "running",
    ts: 2,
  });

  expect(metrics).toEqual([
    {
      name: METRIC_NAMES.eventBufferOverflow,
      value: 1,
      type: "counter",
      tags: { stream: "client.health" },
    },
  ]);

  await iterator.return?.();
  await client.stop({ graceful: false });
});

test("onMetric exceptions are swallowed by the runtime emitter", async () => {
  const client = new AcexClientImpl({
    onMetric() {
      throw new Error("observer failed");
    },
  });

  expect(() => {
    client.emitMetric("test.metric", 1, "counter");
  }).not.toThrow();

  await client.stop({ graceful: false });
});
