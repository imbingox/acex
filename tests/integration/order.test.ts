import { expect, test } from "bun:test";
import type {
  RateLimiter,
  RateLimitRequestContext,
  VenueErrorReason,
} from "../../index.ts";
import {
  AcexError,
  BigNumber,
  createClient,
  isOrderStateUnknown,
} from "../../index.ts";
import { TransportError } from "../../src/internal/http-client.ts";
import {
  installBinancePrivateAccountInfra,
  PAPI_ACCOUNT_WS_URL,
} from "../support/exchanges/binance.ts";
import {
  FakeWebSocket,
  nextEvent,
  waitForSocket,
} from "../support/test-utils.ts";

async function waitForCondition<T>(
  check: () => T | undefined,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(5);
  }

  throw new Error(message);
}

async function nextMatchingEvent<T>(
  iterator: AsyncIterator<T>,
  check: (event: T) => boolean,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(message);
    }

    let event: T;
    try {
      event = await nextEvent(iterator, remainingMs);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Timed out waiting for event"
      ) {
        throw new Error(message);
      }
      throw error;
    }

    if (check(event)) {
      return event;
    }
  }
}

async function expectNoMatchingEvent<T>(
  iterator: AsyncIterator<T>,
  check: (event: T) => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    let event: T;
    try {
      event = await nextEvent(iterator, remainingMs);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Timed out waiting for event"
      ) {
        return;
      }
      throw error;
    }

    if (check(event)) {
      throw new Error(message);
    }
  }
}

type BinanceOrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

interface BinanceOrderUpdateInput {
  symbol?: string;
  orderId?: number;
  clientOrderId?: string;
  side?: "BUY" | "SELL";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  executionType?: string;
  tradeId?: number | string;
  status?: BinanceOrderStatus;
  price?: string;
  amount?: string;
  filled?: string;
  lastQty?: string;
  lastPrice?: string;
  feeCost?: string;
  feeAsset?: string;
  realizedPnl?: string;
  maker?: boolean;
  updateTime?: number;
}

interface OrderManagerDebugView {
  records: Map<
    string,
    {
      pendingClientOrderIdIndex: Map<string, unknown>;
    }
  >;
}

interface ClientDebugView {
  createOrder(input: unknown): Promise<unknown>;
  cancelAllOrders(input: unknown): Promise<unknown>;
  orderManager: OrderManagerDebugView;
}

function setDebugCreateOrder(
  client: object,
  createOrder: (input: unknown) => Promise<unknown>,
): void {
  if (!Reflect.set(client, "createOrder", createOrder)) {
    throw new Error("Failed to override debug createOrder");
  }
}

function unsetDebugVenueErrorNormalizer(client: object, venue: string): void {
  const privateAdapters = Reflect.get(client, "privateAdapters");
  if (!(privateAdapters instanceof Map)) {
    throw new Error("Expected debug private adapter map");
  }

  const adapter: unknown = privateAdapters.get(venue);
  if (!adapter || typeof adapter !== "object") {
    throw new Error(`Expected debug private adapter for ${venue}`);
  }
  if (!Reflect.set(adapter, "normalizeVenueErrorCode", undefined)) {
    throw new Error("Failed to unset debug venue error normalizer");
  }
}

async function createSubscribedOrderClient(options: {
  maxClosedOrdersPerSymbol?: number;
}): Promise<{
  client: ReturnType<typeof createClient>;
  socket: FakeWebSocket;
}> {
  installBinancePrivateAccountInfra({
    openOrders: [],
  });
  const orderOptions =
    options.maxClosedOrdersPerSymbol === undefined
      ? undefined
      : {
          maxClosedOrdersPerSymbol: options.maxClosedOrdersPerSymbol,
        };
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
    order: orderOptions,
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  return {
    client,
    socket: await waitForSocket(PAPI_ACCOUNT_WS_URL),
  };
}

function emitBinanceOrderUpdate(
  socket: FakeWebSocket,
  input: BinanceOrderUpdateInput,
): void {
  const status = input.status ?? "FILLED";
  const amount = input.amount ?? "0.010";
  const filled =
    input.filled ?? (status === "NEW" || status === "REJECTED" ? "0" : amount);
  const updateTime = input.updateTime ?? 1710000000500;
  const order: Record<string, unknown> = {
    s: input.symbol ?? "BTCUSDT",
    S: input.side ?? "BUY",
    o: "LIMIT",
    X: status,
    p: input.price ?? "100500.00",
    sp: "0",
    q: amount,
    z: filled,
    ap: filled === "0" ? "0" : (input.price ?? "100500.00"),
    R: false,
    ps: input.positionSide ?? "BOTH",
  };

  if (input.orderId !== undefined) {
    order.i = input.orderId;
  }
  if (input.clientOrderId !== undefined) {
    order.c = input.clientOrderId;
  }
  if (input.executionType !== undefined) {
    order.x = input.executionType;
  }
  if (input.tradeId !== undefined) {
    order.t = input.tradeId;
  }
  if (input.lastQty !== undefined) {
    order.l = input.lastQty;
  }
  if (input.lastPrice !== undefined) {
    order.L = input.lastPrice;
  }
  if (input.feeCost !== undefined) {
    order.n = input.feeCost;
  }
  if (input.feeAsset !== undefined) {
    order.N = input.feeAsset;
  }
  if (input.realizedPnl !== undefined) {
    order.rp = input.realizedPnl;
  }
  if (input.maker !== undefined) {
    order.m = input.maker;
  }

  socket.emitJson({
    e: "ORDER_TRADE_UPDATE",
    E: updateTime,
    T: updateTime,
    o: order,
  });
}

async function waitForStoredOrderCount(
  client: ReturnType<typeof createClient>,
  ids: number[],
  expectedCount: number,
  timeoutMs: number,
  message: string,
  symbol = "BTC/USDT:USDT",
): Promise<void> {
  await waitForCondition(
    () => {
      const storedCount = ids.filter((id) =>
        client.order.getOrder({
          accountId: "main-binance",
          symbol,
          orderId: String(id),
        }),
      ).length;
      const latestId = ids.at(-1);
      const latestStored =
        latestId === undefined ||
        client.order.getOrder({
          accountId: "main-binance",
          symbol,
          orderId: String(latestId),
        });

      return latestStored && storedCount === expectedCount ? true : undefined;
    },
    timeoutMs,
    message,
  );
}

async function expectInvalidClosedOrderLimitUsesDefault(
  maxClosedOrdersPerSymbol: number,
  firstOrderId: number,
): Promise<void> {
  const { client, socket } = await createSubscribedOrderClient({
    maxClosedOrdersPerSymbol,
  });
  const ids = Array.from({ length: 501 }, (_, index) => firstOrderId + index);

  for (const id of ids) {
    emitBinanceOrderUpdate(socket, {
      orderId: id,
      clientOrderId: `cid-default-${id}`,
      updateTime: 1710000000000 + id,
    });
  }

  await waitForStoredOrderCount(
    client,
    ids,
    451,
    500,
    "invalid closed order limit did not fall back to the default batch trim",
  );
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: String(firstOrderId),
    }),
  ).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: String(firstOrderId + 49),
    }),
  ).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: String(firstOrderId + 50),
    }),
  ).toMatchObject({
    status: "filled",
  });
}

test("order subscribe bootstraps open orders, applies websocket updates, and reuses the account private socket", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });
  const iterator = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
    options: {
      timestamp: 1710000000000,
      recvWindow: 5000,
    },
  });

  await client.start();
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  expect(
    FakeWebSocket.instances.filter(
      (instance) => instance.url === PAPI_ACCOUNT_WS_URL,
    ),
  ).toHaveLength(1);

  expect(await nextEvent(iterator)).toMatchObject({
    type: "order.snapshot_replaced",
    accountId: "main-binance",
    venue: "binance",
    snapshot: [
      {
        orderId: "1001",
        clientOrderId: "cid-1001",
        symbol: "BTC/USDT:USDT",
        side: "buy",
        status: "open",
      },
    ],
  });

  expect(
    client.order.getOrder({
      accountId: "main-binance",
      orderId: "1001",
    }),
  ).toMatchObject({
    price: new BigNumber("100500.00").toFixed(),
    amount: new BigNumber("0.020").toFixed(),
    filled: new BigNumber("0.005").toFixed(),
  });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(1);

  socket.emitJson({
    e: "ORDER_TRADE_UPDATE",
    E: 1710000000500,
    T: 1710000000500,
    o: {
      s: "BTCUSDT",
      i: 1001,
      c: "cid-1001",
      S: "BUY",
      o: "LIMIT",
      X: "PARTIALLY_FILLED",
      p: "100500.00",
      sp: "0",
      q: "0.020",
      z: "0.010",
      ap: "100450.00",
      R: false,
      ps: "BOTH",
    },
  });

  expect(await nextEvent(iterator)).toMatchObject({
    type: "order.updated",
    symbol: "BTC/USDT:USDT",
    snapshot: {
      status: "partially_filled",
      filled: new BigNumber("0.010").toFixed(),
      avgFillPrice: new BigNumber("100450.00").toFixed(),
    },
  });

  expect(
    client.order.getOrder({
      accountId: "main-binance",
      clientOrderId: "cid-1001",
    }),
  ).toMatchObject({
    filled: new BigNumber("0.010").toFixed(),
    remaining: new BigNumber("0.010").toFixed(),
  });

  await iterator.return?.();
});

test("order trades stream publishes Binance per-trade fee, maker flag, realized pnl, and seq", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const iterator = client.order.events
    .trades({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    orderId: 3001,
    clientOrderId: "cid-3001",
    side: "SELL",
    positionSide: "SHORT",
    executionType: "TRADE",
    tradeId: 9001,
    status: "PARTIALLY_FILLED",
    price: "100500.00",
    amount: "0.0100",
    filled: "0.0050",
    lastQty: "0.0050",
    lastPrice: "100450.000",
    feeCost: "0",
    feeAsset: "USDT",
    realizedPnl: "0.0000",
    maker: true,
    updateTime: 1710000000500,
  });

  const first = await nextEvent(iterator);
  expect(first).toMatchObject({
    type: "order.trade",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    side: "sell",
    orderId: "3001",
    clientOrderId: "cid-3001",
    seq: 1,
    orderSeq: 1,
    trade: {
      tradeId: "9001",
      price: new BigNumber("100450.000").toFixed(),
      qty: new BigNumber("0.0050").toFixed(),
      fee: {
        cost: "0",
        asset: "USDT",
      },
      realizedPnl: "0",
      maker: true,
      positionSide: "short",
      exchangeTs: 1710000000500,
    },
  });
  expect(typeof first.trade.receivedAt).toBe("number");

  emitBinanceOrderUpdate(socket, {
    orderId: 3001,
    clientOrderId: "cid-3001",
    side: "SELL",
    positionSide: "SHORT",
    executionType: "TRADE",
    tradeId: 9002,
    status: "FILLED",
    price: "100500.00",
    amount: "0.0100",
    filled: "0.0100",
    lastQty: "0.0050",
    lastPrice: "100500.00",
    feeCost: "-0.0000100",
    feeAsset: "BNB",
    realizedPnl: "1.2300",
    maker: false,
    updateTime: 1710000000600,
  });

  const second = await nextEvent(iterator);
  expect(second).toMatchObject({
    type: "order.trade",
    seq: 2,
    orderSeq: 2,
    trade: {
      tradeId: "9002",
      price: new BigNumber("100500.00").toFixed(),
      qty: new BigNumber("0.0050").toFixed(),
      fee: {
        cost: new BigNumber("-0.0000100").toFixed(),
        asset: "BNB",
      },
      realizedPnl: new BigNumber("1.2300").toFixed(),
      maker: false,
      positionSide: "short",
    },
  });

  await iterator.return?.();
});

test("order trades stream filters by account, venue, and symbol", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const iterator = client.order.events
    .trades({
      accountId: "main-binance",
      venue: "binance",
      symbol: "ETH/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    orderId: 3101,
    clientOrderId: "cid-3101",
    executionType: "TRADE",
    tradeId: 9101,
    status: "FILLED",
    amount: "0.010",
    filled: "0.010",
    lastQty: "0.010",
    lastPrice: "100500.00",
    updateTime: 1710000000500,
  });
  emitBinanceOrderUpdate(socket, {
    symbol: "ETHUSDT",
    orderId: 3102,
    clientOrderId: "cid-3102",
    executionType: "TRADE",
    tradeId: 9102,
    status: "FILLED",
    amount: "0.100",
    filled: "0.100",
    lastQty: "0.100",
    lastPrice: "3000.00",
    updateTime: 1710000000600,
  });

  expect(await nextEvent(iterator)).toMatchObject({
    type: "order.trade",
    symbol: "ETH/USDT:USDT",
    trade: {
      tradeId: "9102",
      price: new BigNumber("3000.00").toFixed(),
      qty: new BigNumber("0.100").toFixed(),
    },
  });

  await iterator.return?.();
});

test("order trades stream ignores non-trade executions and zero-quantity trades", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const iterator = client.order.events.trades()[Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    orderId: 3201,
    clientOrderId: "cid-3201",
    executionType: "NEW",
    tradeId: 9201,
    status: "NEW",
    amount: "0.010",
    filled: "0",
    lastQty: "0.010",
    lastPrice: "100500.00",
    updateTime: 1710000000500,
  });
  emitBinanceOrderUpdate(socket, {
    orderId: 3201,
    clientOrderId: "cid-3201",
    executionType: "TRADE",
    tradeId: 9202,
    status: "PARTIALLY_FILLED",
    amount: "0.010",
    filled: "0",
    lastQty: "0",
    lastPrice: "100500.00",
    updateTime: 1710000000600,
  });

  await expectNoMatchingEvent(
    iterator,
    () => true,
    50,
    "non-trade or zero-quantity update published a trade event",
  );

  await iterator.return?.();
});

test("order trades stream deduplicates repeated tradeId but publishes trades without tradeId", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const iterator = client.order.events.trades()[Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    orderId: 3301,
    clientOrderId: "cid-3301",
    executionType: "TRADE",
    tradeId: 9301,
    status: "PARTIALLY_FILLED",
    amount: "0.010",
    filled: "0.005",
    lastQty: "0.005",
    lastPrice: "100500.00",
    updateTime: 1710000000500,
  });
  expect(await nextEvent(iterator)).toMatchObject({
    type: "order.trade",
    seq: 1,
    trade: {
      tradeId: "9301",
    },
  });

  emitBinanceOrderUpdate(socket, {
    orderId: 3301,
    clientOrderId: "cid-3301",
    executionType: "TRADE",
    tradeId: 9301,
    status: "FILLED",
    amount: "0.010",
    filled: "0.010",
    lastQty: "0.005",
    lastPrice: "100600.00",
    updateTime: 1710000000600,
  });

  for (const updateTime of [1710000000700, 1710000000800]) {
    emitBinanceOrderUpdate(socket, {
      orderId: 3302,
      clientOrderId: "cid-3302",
      executionType: "TRADE",
      status: "PARTIALLY_FILLED",
      amount: "0.020",
      filled: "0.010",
      lastQty: "0.010",
      lastPrice: "100700.00",
      updateTime,
    });
  }

  const firstMissingId = await nextEvent(iterator);
  const secondMissingId = await nextEvent(iterator);
  expect(firstMissingId.trade.tradeId).toBeUndefined();
  expect(secondMissingId.trade.tradeId).toBeUndefined();
  expect([firstMissingId.seq, secondMissingId.seq]).toEqual([2, 3]);

  await iterator.return?.();
});

test("order trades stream does not deduplicate the same tradeId across symbols", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const iterator = client.order.events.trades()[Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    orderId: 3311,
    clientOrderId: "cid-3311",
    executionType: "TRADE",
    tradeId: 9302,
    status: "PARTIALLY_FILLED",
    amount: "0.010",
    filled: "0.005",
    lastQty: "0.005",
    lastPrice: "100500.00",
    updateTime: 1710000000500,
  });
  emitBinanceOrderUpdate(socket, {
    symbol: "ETHUSDT",
    orderId: 3312,
    clientOrderId: "cid-3312",
    executionType: "TRADE",
    tradeId: 9302,
    status: "PARTIALLY_FILLED",
    amount: "0.100",
    filled: "0.050",
    lastQty: "0.050",
    lastPrice: "3000.00",
    updateTime: 1710000000600,
  });

  const btcTrade = await nextEvent(iterator);
  const ethTrade = await nextEvent(iterator);

  expect(btcTrade).toMatchObject({
    type: "order.trade",
    symbol: "BTC/USDT:USDT",
    seq: 1,
    trade: {
      tradeId: "9302",
      price: new BigNumber("100500.00").toFixed(),
      qty: new BigNumber("0.005").toFixed(),
    },
  });
  expect(ethTrade).toMatchObject({
    type: "order.trade",
    symbol: "ETH/USDT:USDT",
    seq: 2,
    trade: {
      tradeId: "9302",
      price: new BigNumber("3000.00").toFixed(),
      qty: new BigNumber("0.050").toFixed(),
    },
  });

  await iterator.return?.();
});

test("order trade publishes even when an out-of-order update is rejected by snapshot watermark", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const updates = client.order.events.updates()[Symbol.asyncIterator]();
  const trades = client.order.events.trades()[Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    orderId: 3401,
    clientOrderId: "cid-3401",
    status: "FILLED",
    amount: "0.010",
    filled: "0.010",
    updateTime: 1710000000600,
  });
  await nextMatchingEvent(
    updates,
    (event) =>
      event.type === "order.filled" && event.snapshot.orderId === "3401",
    200,
    "newer order fill was not applied before stale trade test",
  );

  emitBinanceOrderUpdate(socket, {
    orderId: 3401,
    clientOrderId: "cid-3401",
    executionType: "TRADE",
    tradeId: 9401,
    status: "PARTIALLY_FILLED",
    amount: "0.010",
    filled: "0.005",
    lastQty: "0.005",
    lastPrice: "100450.00",
    updateTime: 1710000000500,
  });

  const trade = await nextEvent(trades);
  expect(trade).toMatchObject({
    type: "order.trade",
    orderId: "3401",
    trade: {
      tradeId: "9401",
      qty: new BigNumber("0.005").toFixed(),
    },
  });
  expect(trade.orderSeq).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3401",
    }),
  ).toMatchObject({
    status: "filled",
    filled: new BigNumber("0.010").toFixed(),
  });
  await expectNoMatchingEvent(
    updates,
    (event) =>
      event.type !== "order.snapshot_replaced" &&
      event.snapshot.orderId === "3401" &&
      event.snapshot.filled === new BigNumber("0.005").toFixed(),
    50,
    "stale trade update also published a snapshot update",
  );

  await updates.return?.();
  await trades.return?.();
});

test("REST-only order updates do not publish trade events", async () => {
  const { client } = await createSubscribedOrderClient({});
  const trades = client.order.events.trades()[Symbol.asyncIterator]();

  await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
    clientOrderId: "cid-rest-only",
  });

  await expectNoMatchingEvent(
    trades,
    () => true,
    50,
    "REST order command unexpectedly published a trade event",
  );

  await trades.return?.();
});

test("order trades stream uses buffered overflow reporting", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const errors = client.events.errors()[Symbol.asyncIterator]();
  const trades = client.order.events
    .trades(undefined, { maxBuffer: 1 })
    [Symbol.asyncIterator]();

  for (const index of [1, 2, 3]) {
    emitBinanceOrderUpdate(socket, {
      orderId: 3500 + index,
      clientOrderId: `cid-350${index}`,
      executionType: "TRADE",
      tradeId: 9500 + index,
      status: "FILLED",
      amount: "0.010",
      filled: "0.010",
      lastQty: "0.010",
      lastPrice: "100500.00",
      updateTime: 1710000000500 + index,
    });
  }

  const overflow = await nextEvent(errors);
  expect(overflow).toMatchObject({
    source: "order",
    stream: "order.trades",
    maxBuffer: 1,
  });
  expect(overflow.error).toBeInstanceOf(AcexError);
  expect((overflow.error as AcexError).code).toBe("EVENT_BUFFER_OVERFLOW");

  expect(await nextEvent(trades)).toMatchObject({
    type: "order.trade",
    seq: 3,
    trade: {
      tradeId: "9503",
    },
  });

  await errors.return?.();
  await trades.return?.();
});

test("order status enters reconnecting on disconnect and recovers after websocket reconnect", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    ready: true,
    runtimeStatus: "healthy",
  });

  socket.disconnect();
  await Bun.sleep(0);

  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    ready: true,
    runtimeStatus: "reconnecting",
    reason: "ws_disconnected",
  });

  const reconnectSocket = await waitForSocket(PAPI_ACCOUNT_WS_URL, 1, 100);
  await Bun.sleep(0);

  expect(reconnectSocket.readyState).toBe(FakeWebSocket.OPEN);
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    ready: true,
    runtimeStatus: "healthy",
    reason: undefined,
  });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(1);
});

test("private order reconcile backfills terminal status for disappeared open orders", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrderResponses: [
      [
        {
          symbol: "BTCUSDT",
          orderId: 1001,
          clientOrderId: "cid-1001",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "100500.00",
          stopPrice: "0",
          origQty: "0.020",
          executedQty: "0.005",
          avgPrice: "100400.00",
          reduceOnly: false,
          positionSide: "BOTH",
          updateTime: 1710000000300,
        },
      ],
      [],
    ],
    queryOrder: {
      symbol: "BTCUSDT",
      orderId: 1001,
      clientOrderId: "cid-1001",
      side: "BUY",
      type: "LIMIT",
      status: "FILLED",
      price: "100500.00",
      stopPrice: "0",
      origQty: "0.020",
      executedQty: "0.020",
      avgPrice: "100450.00",
      reduceOnly: false,
      positionSide: "BOTH",
      updateTime: 1710000000600,
    },
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
  });
  const iterator = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  expect(await nextEvent(iterator)).toMatchObject({
    type: "order.snapshot_replaced",
  });
  const filled = await nextMatchingEvent(
    iterator,
    (event) => event.type === "order.filled",
    200,
    "order reconcile did not publish filled event",
  );
  expect(filled).toMatchObject({
    type: "order.filled",
    snapshot: {
      orderId: "1001",
      status: "filled",
      filled: new BigNumber("0.020").toFixed(),
    },
  });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      orderId: "1001",
    }),
  ).toMatchObject({
    status: "filled",
    avgFillPrice: new BigNumber("100450.00").toFixed(),
  });
  expect(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.url.pathname === "/papi/v1/um/order" &&
        request.url.searchParams.get("orderId") === "1001",
    ),
  ).toBe(true);

  await iterator.return?.();
});

test("order bootstrap backfills terminal status for cached disappeared open orders", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrderResponses: [[], []],
    createOrder: {
      symbol: "BTCUSDT",
      orderId: 2001,
      clientOrderId: "cid-bootstrap-2001",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "101000.00",
      stopPrice: "0",
      origQty: "0.010",
      executedQty: "0",
      avgPrice: "0",
      reduceOnly: false,
      positionSide: "BOTH",
      updateTime: 1710000000400,
    },
    queryOrder: {
      symbol: "BTCUSDT",
      orderId: 2001,
      clientOrderId: "cid-bootstrap-2001",
      side: "BUY",
      type: "LIMIT",
      status: "FILLED",
      price: "101000.00",
      stopPrice: "0",
      origQty: "0.010",
      executedQty: "0.010",
      avgPrice: "100900.00",
      reduceOnly: false,
      positionSide: "BOTH",
      updateTime: 1710000000600,
    },
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
  });
  const iterator = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
    clientOrderId: "cid-bootstrap-2001",
  });

  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  const filled = await nextMatchingEvent(
    iterator,
    (event) => event.type === "order.filled",
    200,
    "order bootstrap did not backfill filled event",
  );
  expect(filled).toMatchObject({
    snapshot: {
      orderId: "2001",
      status: "filled",
      filled: new BigNumber("0.010").toFixed(),
    },
  });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "2001",
    }),
  ).toMatchObject({
    status: "filled",
  });
  expect(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.url.pathname === "/papi/v1/um/order" &&
        request.url.searchParams.get("orderId") === "2001",
    ),
  ).toBe(true);

  await iterator.return?.();
});

test("private order reconcile evicts disappeared open orders after confirmed missing checks", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrderResponses: [
      [
        {
          symbol: "BTCUSDT",
          orderId: 1001,
          clientOrderId: "cid-1001",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "100500.00",
          stopPrice: "0",
          origQty: "0.020",
          executedQty: "0.005",
          avgPrice: "100400.00",
          reduceOnly: false,
          positionSide: "BOTH",
          updateTime: 1710000000300,
        },
      ],
      [],
    ],
    failQueryOrder: true,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
    order: {
      missingOrderEvictionThreshold: 3,
    },
  });
  const updates = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();
  const errors = client.events.errors()[Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  const unknownEvent = await nextMatchingEvent(
    updates,
    (event) =>
      event.type === "order.canceled" &&
      event.snapshot.orderId === "1001" &&
      event.snapshot.status === "unknown",
    500,
    "order reconcile did not evict confirmed missing order",
  );
  expect(unknownEvent).toMatchObject({
    type: "order.canceled",
    snapshot: {
      orderId: "1001",
      status: "unknown",
    },
  });

  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      orderId: "1001",
    }),
  ).toMatchObject({
    status: "unknown",
  });
  const queryOrderRequests = requests.filter(
    (request) =>
      request.method === "GET" &&
      request.url.pathname === "/papi/v1/um/order" &&
      request.url.searchParams.get("orderId") === "1001",
  );
  expect(queryOrderRequests.length).toBeGreaterThanOrEqual(3);

  const runtimeError = await nextMatchingEvent(
    errors,
    (event) =>
      event.source === "order" &&
      event.error.message.includes("confirmed missing checks"),
    100,
    "missing order eviction did not publish runtime error",
  );
  expect(runtimeError).toMatchObject({
    source: "order",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  await expectNoMatchingEvent(
    updates,
    (event) =>
      event.type === "order.canceled" &&
      event.snapshot.orderId === "1001" &&
      event.snapshot.status === "unknown",
    50,
    "missing order eviction published duplicate terminal event",
  );
  await expectNoMatchingEvent(
    errors,
    (event) =>
      event.source === "order" &&
      event.error.message.includes("confirmed missing checks"),
    50,
    "missing order eviction published duplicate runtime error",
  );

  await updates.return?.();
  await errors.return?.();
});

test("private order reconcile keeps disappeared open orders on network backfill errors", async () => {
  installBinancePrivateAccountInfra({
    openOrderResponses: [
      [
        {
          symbol: "BTCUSDT",
          orderId: 1001,
          clientOrderId: "cid-1001",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "100500.00",
          stopPrice: "0",
          origQty: "0.020",
          executedQty: "0.005",
          avgPrice: "100400.00",
          reduceOnly: false,
          positionSide: "BOTH",
          updateTime: 1710000000300,
        },
      ],
      [],
    ],
    networkErrorQueryOrder: true,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
    order: {
      missingOrderEvictionThreshold: 2,
    },
  });
  const updates = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  await waitForCondition(
    () =>
      client.order.getOrderStatus("main-binance")?.runtimeStatus === "degraded"
        ? true
        : undefined,
    1_000,
    "order reconcile did not degrade on network backfill error",
  );

  expect(client.order.getOpenOrders("main-binance")).toHaveLength(1);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      orderId: "1001",
    }),
  ).toMatchObject({
    status: "open",
  });
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    runtimeStatus: "degraded",
    reason: "http_failed",
  });
  await expectNoMatchingEvent(
    updates,
    (event) => event.type !== "order.snapshot_replaced",
    50,
    "network backfill error unexpectedly published a terminal order event",
  );

  await updates.return?.();
});

test("successful order reconcile clears previous HTTP degraded status", async () => {
  installBinancePrivateAccountInfra({
    openOrderResponses: [
      [
        {
          symbol: "BTCUSDT",
          orderId: 1001,
          clientOrderId: "cid-1001",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "100500.00",
          stopPrice: "0",
          origQty: "0.020",
          executedQty: "0.005",
          avgPrice: "100400.00",
          reduceOnly: false,
          positionSide: "BOTH",
          updateTime: 1710000000300,
        },
      ],
      [],
      [
        {
          symbol: "BTCUSDT",
          orderId: 1001,
          clientOrderId: "cid-1001",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "100500.00",
          stopPrice: "0",
          origQty: "0.020",
          executedQty: "0.005",
          avgPrice: "100400.00",
          reduceOnly: false,
          positionSide: "BOTH",
          updateTime: 1710000000300,
        },
      ],
    ],
    networkErrorQueryOrderCount: 3,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  await waitForCondition(
    () =>
      client.order.getOrderStatus("main-binance")?.runtimeStatus === "degraded"
        ? true
        : undefined,
    1_000,
    "order reconcile did not degrade",
  );
  await waitForCondition(
    () =>
      client.order.getOrderStatus("main-binance")?.runtimeStatus === "healthy"
        ? true
        : undefined,
    1_000,
    "successful order reconcile did not clear degraded status",
  );
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    runtimeStatus: "healthy",
    reason: undefined,
  });
});

test("order bootstrap rate limit maps to rate_limited status without changing public code", async () => {
  installBinancePrivateAccountInfra({ rateLimitOpenOrders: true });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  const failure = await client.order
    .subscribeOrders({
      accountId: "main-binance",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "ORDER_BOOTSTRAP_FAILED",
    details: {
      accountId: "main-binance",
      venue: "binance",
      venueError: {
        code: "-1003",
        message: "Too many requests",
      },
      transport: {
        kind: "rate_limited",
        status: 429,
        statusText: "Too Many Requests",
        retryAfterMs: 2000,
      },
    },
  });
  expect((failure as AcexError).cause).toBeInstanceOf(Error);
  expect((failure as AcexError).message).toContain(
    "Binance rejected: Too many requests",
  );
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    ready: false,
    runtimeStatus: "degraded",
    reason: "rate_limited",
  });
});

test("order bootstrap ban maps to rate_limited status without changing public code", async () => {
  installBinancePrivateAccountInfra({ banOpenOrders: true });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  const failure = await client.order
    .subscribeOrders({
      accountId: "main-binance",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "ORDER_BOOTSTRAP_FAILED",
    details: {
      accountId: "main-binance",
      venue: "binance",
      venueError: {
        code: "-1003",
        message: "IP banned",
      },
      transport: {
        kind: "rate_limited",
        status: 418,
        statusText: "I'm a teapot",
        retryAfterMs: 60000,
      },
    },
  });
  expect((failure as AcexError).cause).toBeInstanceOf(Error);
  expect((failure as AcexError).message).toContain(
    "Binance rejected: IP banned",
  );
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    ready: false,
    runtimeStatus: "degraded",
    reason: "rate_limited",
  });
});

test("order bootstrap auth failure keeps auth_failed reason and does not over-report rate_limited", async () => {
  installBinancePrivateAccountInfra({ failOpenOrders: true });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  const failure = await client.order
    .subscribeOrders({
      accountId: "main-binance",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "ORDER_BOOTSTRAP_FAILED",
    details: {
      accountId: "main-binance",
      venue: "binance",
      venueError: {
        code: "-2015",
        message: "Invalid API-key",
      },
      transport: {
        kind: "http",
        status: 401,
        statusText: "Unauthorized",
      },
    },
  });
  expect((failure as AcexError).cause).toBeInstanceOf(Error);
  expect((failure as AcexError).message).toContain(
    "Binance rejected: Invalid API-key",
  );
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    ready: false,
    runtimeStatus: "degraded",
    reason: "auth_failed",
  });
});

test("createOrder sends the expected Binance PAPI request and stores the returned snapshot", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
    options: {
      timestamp: 1710000000000,
      recvWindow: 5000,
    },
  });

  await client.start();

  const snapshot = await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
    clientOrderId: "cid-2001",
  });

  expect(snapshot).toMatchObject({
    accountId: "main-binance",
    venue: "binance",
    orderId: "2001",
    clientOrderId: "cid-2001",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "LIMIT",
    status: "open",
    price: new BigNumber("101000.00").toFixed(),
    amount: new BigNumber("0.010").toFixed(),
    filled: new BigNumber("0").toFixed(),
    remaining: new BigNumber("0.010").toFixed(),
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      orderId: "2001",
    }),
  ).toMatchObject({
    clientOrderId: "cid-2001",
    remaining: new BigNumber("0.010").toFixed(),
  });

  const request = requests.find(
    (entry) =>
      entry.method === "POST" && entry.url.pathname === "/papi/v1/um/order",
  );
  expect(request).toBeDefined();
  expect(request?.apiKey).toBe("key");
  expect(request?.url.searchParams.get("symbol")).toBe("BTCUSDT");
  expect(request?.url.searchParams.get("side")).toBe("BUY");
  expect(request?.url.searchParams.get("type")).toBe("LIMIT");
  expect(request?.url.searchParams.get("price")).toBe("101000.00");
  expect(request?.url.searchParams.get("quantity")).toBe("0.010");
  expect(request?.url.searchParams.get("timeInForce")).toBe("GTC");
  expect(request?.url.searchParams.get("newClientOrderId")).toBe("cid-2001");
  expect(request?.url.searchParams.get("timestamp")).toBe("1710000000000");
  expect(request?.url.searchParams.get("recvWindow")).toBe("5000");
  expect(request?.url.searchParams.get("signature")).not.toBeNull();
});

test("createOrder generates and sends a Binance-safe clientOrderId when omitted", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();

  const snapshot = await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
  });

  const request = requests.find(
    (entry) =>
      entry.method === "POST" && entry.url.pathname === "/papi/v1/um/order",
  );
  const generatedCid = request?.url.searchParams.get("newClientOrderId");
  if (!generatedCid) {
    throw new Error("generated clientOrderId was not sent");
  }
  expect(generatedCid).toMatch(/^acex-[.A-Z:/a-z0-9_-]{1,27}$/);
  expect(generatedCid.length).toBeLessThanOrEqual(32);
  expect(snapshot.clientOrderId).toBe(generatedCid);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      clientOrderId: generatedCid,
    }),
  ).toMatchObject({
    orderId: "2001",
    clientOrderId: generatedCid,
    status: "open",
  });
});

test("createOrder rejects invalid caller-provided clientOrderId before REST", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
      clientOrderId: "invalid client id with spaces",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).code).toBe("ORDER_INPUT_INVALID");
  expect((failure as AcexError).details?.orderState).toBe("not_placed");
  expect(
    requests.some(
      (entry) =>
        entry.method === "POST" && entry.url.pathname === "/papi/v1/um/order",
    ),
  ).toBe(false);
});

test("createOrder propagates command ack write failures", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient();
  const debugClient = client as unknown as ClientDebugView;

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  debugClient.createOrder = async () => ({
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "LIMIT",
    status: "open",
    amount: "0.010",
    filled: "0",
    remaining: "0.010",
    receivedAt: 1710000000200,
  });

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).code).toBe("ORDER_CREATE_FAILED");
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
  expect(
    debugClient.orderManager.records.get("main-binance")
      ?.pendingClientOrderIdIndex.size,
  ).toBe(0);
});

test("createOrder clears pending claim after explicit adapter failure", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient();
  const debugClient = client as unknown as ClientDebugView;

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  debugClient.createOrder = async () => {
    throw new Error("venue rejected order");
  };

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).code).toBe("ORDER_CREATE_FAILED");
  expect((failure as AcexError).details?.transport).toBeUndefined();
  expect((failure as AcexError).details?.venueError).toBeUndefined();
  expect((failure as AcexError).details?.orderState).toBe("unknown");
  expect(isOrderStateUnknown(failure)).toBe(true);
  expect(
    debugClient.orderManager.records.get("main-binance")
      ?.pendingClientOrderIdIndex.size,
  ).toBe(0);
});

test("createOrder retains pending claim after timeout", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient();
  const debugClient = client as unknown as ClientDebugView;

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  debugClient.createOrder = async () => {
    throw new TransportError("Binance PAPI fetch timeout after 1ms", {
      kind: "timeout",
      attempts: 1,
      retryable: true,
      url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
    });
  };

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).code).toBe("ORDER_CREATE_FAILED");
  expect((failure as AcexError).details?.orderState).toBe("unknown");
  expect(isOrderStateUnknown(failure)).toBe(true);

  const pending = [
    ...(debugClient.orderManager.records
      .get("main-binance")
      ?.pendingClientOrderIdIndex.keys() ?? []),
  ];
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatch(/^acex-/);
});

test("createOrder retains pending claim after network failure", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient();
  const debugClient = client as unknown as ClientDebugView;

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  debugClient.createOrder = async () => {
    throw new TransportError("Network failed", {
      kind: "network",
      attempts: 1,
      retryable: true,
      url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
    });
  };

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).details?.orderState).toBe("unknown");
  expect(isOrderStateUnknown(failure)).toBe(true);

  const pending = [
    ...(debugClient.orderManager.records
      .get("main-binance")
      ?.pendingClientOrderIdIndex.keys() ?? []),
  ];
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatch(/^acex-/);
});

test("createOrder treats catalog preflight failure as not placed and clears pending claim", async () => {
  const debugClientClock = {
    now: () => 1_710_000_000_000,
  };
  let catalogRequests = 0;
  let papiOrderPosts = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(rawUrl);
      if (url.toString() === "https://fapi.binance.com/fapi/v1/exchangeInfo") {
        catalogRequests += 1;
        throw new TypeError("exchangeInfo unavailable");
      }
      if (
        url.origin === "https://papi.binance.com" &&
        url.pathname === "/papi/v1/um/order"
      ) {
        papiOrderPosts += 1;
      }

      throw new Error(`Unexpected fetch URL: ${url.toString()}`);
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  const client = createClient({ clock: debugClientClock });
  const debugClient = client as unknown as ClientDebugView;

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).code).toBe("ORDER_CREATE_FAILED");
  expect((failure as AcexError).details?.orderState).toBe("not_placed");
  expect(isOrderStateUnknown(failure)).toBe(false);
  expect(catalogRequests).toBe(1);
  expect(papiOrderPosts).toBe(0);
  expect(
    debugClient.orderManager.records.get("main-binance")
      ?.pendingClientOrderIdIndex.size,
  ).toBe(0);
});

test("expired createOrder pending claim is cleared when the venue confirms it is missing", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [],
    failQueryOrder: true,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
    order: {
      pendingClaimTtlMs: 1,
    },
  });
  const debugClient = client as unknown as ClientDebugView;
  const errors = client.events.errors()[Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  setDebugCreateOrder(client, async () => {
    throw new TransportError("Binance PAPI fetch timeout after 1ms", {
      kind: "timeout",
      attempts: 1,
      retryable: true,
      url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
    });
  });

  await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
      clientOrderId: "ttl-missing",
    })
    .catch(() => undefined);

  expect(
    debugClient.orderManager.records
      .get("main-binance")
      ?.pendingClientOrderIdIndex.has("ttl-missing"),
  ).toBe(true);

  const runtimeError = await nextMatchingEvent(
    errors,
    (event) =>
      event.source === "order" &&
      event.error.message.includes("not found on the venue"),
    1_000,
    "expired missing pending claim did not publish runtime error",
  );
  expect(runtimeError).toMatchObject({
    source: "order",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(
    debugClient.orderManager.records
      .get("main-binance")
      ?.pendingClientOrderIdIndex.has("ttl-missing"),
  ).toBe(false);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      clientOrderId: "ttl-missing",
    }),
  ).toBeUndefined();
  expect(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.url.pathname === "/papi/v1/um/order" &&
        request.url.searchParams.get("origClientOrderId") === "ttl-missing",
    ),
  ).toBe(true);

  await errors.return?.();
});

test("expired createOrder pending claim is retained on venue lookup transport errors", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [],
    networkErrorQueryOrder: true,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
    order: {
      pendingClaimTtlMs: 1,
    },
  });
  const debugClient = client as unknown as ClientDebugView;
  const errors = client.events.errors()[Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  setDebugCreateOrder(client, async () => {
    throw new TransportError("Binance PAPI fetch timeout after 1ms", {
      kind: "timeout",
      attempts: 1,
      retryable: true,
      url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
    });
  });

  await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
      clientOrderId: "ttl-network",
    })
    .catch(() => undefined);

  await waitForCondition(
    () =>
      client.order.getOrderStatus("main-binance")?.runtimeStatus === "degraded"
        ? true
        : undefined,
    1_000,
    "expired pending claim lookup transport error did not degrade order status",
  );

  expect(
    debugClient.orderManager.records
      .get("main-binance")
      ?.pendingClientOrderIdIndex.has("ttl-network"),
  ).toBe(true);
  expect(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.url.pathname === "/papi/v1/um/order" &&
        request.url.searchParams.get("origClientOrderId") === "ttl-network",
    ),
  ).toBe(true);
  await expectNoMatchingEvent(
    errors,
    (event) =>
      event.source === "order" &&
      event.error.message.includes("not found on the venue"),
    50,
    "transport error pending claim lookup was treated as confirmed missing",
  );

  await errors.return?.();
});

test("expired createOrder pending claim stores the venue order when it later exists", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [],
    queryOrder: {
      symbol: "BTCUSDT",
      orderId: 2301,
      clientOrderId: "ttl-filled",
      side: "BUY",
      type: "LIMIT",
      status: "FILLED",
      price: "101000.00",
      stopPrice: "0",
      origQty: "0.010",
      executedQty: "0.010",
      avgPrice: "100900.00",
      reduceOnly: false,
      positionSide: "BOTH",
      updateTime: 1710000000800,
    },
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
    order: {
      pendingClaimTtlMs: 1,
    },
  });
  const debugClient = client as unknown as ClientDebugView;
  const updates = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  setDebugCreateOrder(client, async () => {
    throw new TransportError("Binance PAPI fetch timeout after 1ms", {
      kind: "timeout",
      attempts: 1,
      retryable: true,
      url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
    });
  });

  await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
      clientOrderId: "ttl-filled",
    })
    .catch(() => undefined);

  const filled = await nextMatchingEvent(
    updates,
    (event) =>
      event.type === "order.filled" && event.snapshot.orderId === "2301",
    300,
    "expired pending claim was not stored after venue lookup",
  );
  expect(filled).toMatchObject({
    type: "order.filled",
    snapshot: {
      orderId: "2301",
      clientOrderId: "ttl-filled",
      status: "filled",
      filled: new BigNumber("0.010").toFixed(),
    },
  });
  expect(
    debugClient.orderManager.records
      .get("main-binance")
      ?.pendingClientOrderIdIndex.has("ttl-filled"),
  ).toBe(false);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "2301",
    }),
  ).toMatchObject({
    status: "filled",
    clientOrderId: "ttl-filled",
  });
  expect(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.url.pathname === "/papi/v1/um/order" &&
        request.url.searchParams.get("origClientOrderId") === "ttl-filled",
    ),
  ).toBe(true);

  await updates.return?.();
});

test("createOrder annotates orderState for transport failure outcomes", async () => {
  const cases: Array<{
    name: string;
    error: TransportError;
    orderState: "not_placed" | "unknown";
    reason?: VenueErrorReason;
  }> = [
    {
      name: "network",
      error: new TransportError("Network failed", {
        kind: "network",
        attempts: 1,
        retryable: true,
        url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
      }),
      orderState: "unknown",
    },
    {
      name: "parse",
      error: new TransportError("Parse failed", {
        kind: "parse",
        attempts: 1,
        retryable: false,
        rawBody: "<html>not json</html>",
        url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
      }),
      orderState: "unknown",
    },
    {
      name: "http 5xx",
      error: new TransportError("Binance unavailable", {
        kind: "http",
        status: 503,
        statusText: "Service Unavailable",
        attempts: 1,
        retryable: true,
        rawBody: "temporarily unavailable",
        url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
      }),
      orderState: "unknown",
    },
    {
      name: "rate limited",
      error: new TransportError("Too many requests", {
        kind: "rate_limited",
        status: 429,
        statusText: "Too Many Requests",
        retryAfterMs: 2000,
        attempts: 1,
        retryable: true,
        rawBody: '{"code":-1003,"msg":"Too many requests"}',
        url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
      }),
      orderState: "not_placed",
      reason: "rate_limited",
    },
    {
      name: "venue reject",
      error: new TransportError("Insufficient margin", {
        kind: "http",
        status: 400,
        statusText: "Bad Request",
        attempts: 1,
        retryable: false,
        rawBody: '{"code":-2019,"msg":"Margin is insufficient."}',
        url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
      }),
      orderState: "not_placed",
      reason: "insufficient_balance",
    },
  ];

  for (const testCase of cases) {
    installBinancePrivateAccountInfra();
    const client = createClient();

    await client.registerAccount({
      accountId: "main-binance",
      venue: "binance",
      credentials: {
        apiKey: "key",
        secret: "secret",
      },
    });
    await client.start();

    setDebugCreateOrder(client, async () => {
      throw testCase.error;
    });

    const failure = await client.order
      .createOrder({
        accountId: "main-binance",
        symbol: "BTC/USDT:USDT",
        side: "buy",
        type: "limit",
        price: "101000.00",
        amount: "0.010",
      })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(AcexError);
    expect((failure as AcexError).details?.orderState).toBe(
      testCase.orderState,
    );
    expect(isOrderStateUnknown(failure)).toBe(
      testCase.orderState === "unknown",
    );
    expect((failure as AcexError).details?.venueError?.reason).toBe(
      testCase.reason,
    );
  }
});

test("createOrder leaves venue error reason undefined without an adapter normalizer", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  unsetDebugVenueErrorNormalizer(client, "binance");
  setDebugCreateOrder(client, async () => {
    throw new TransportError("Insufficient margin", {
      kind: "http",
      status: 400,
      statusText: "Bad Request",
      attempts: 1,
      retryable: false,
      rawBody: '{"code":-2019,"msg":"Margin is insufficient."}',
      url: "https://papi.binance.com/papi/v1/um/order?query=[REDACTED]",
    });
  });

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).details?.venueError).toMatchObject({
    code: "-2019",
    message: "Margin is insufficient.",
  });
  expect((failure as AcexError).details?.venueError?.reason).toBeUndefined();
  expect((failure as AcexError).details?.orderState).toBe("not_placed");
});

test("createOrder pending claim reuses the generated cid for early websocket updates", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [],
    createOrderDelayMs: 30,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  const createPromise = client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
  });

  const request = await waitForCondition(
    () =>
      requests.find(
        (entry) =>
          entry.method === "POST" && entry.url.pathname === "/papi/v1/um/order",
      ),
    100,
    "createOrder request was not sent",
  );
  const generatedCid = request.url.searchParams.get("newClientOrderId");
  if (!generatedCid) {
    throw new Error("generated clientOrderId was not sent");
  }

  emitBinanceOrderUpdate(socket, {
    clientOrderId: generatedCid ?? undefined,
    status: "NEW",
    updateTime: 1710000000300,
  });
  await waitForCondition(
    () =>
      client.order.getOpenOrders("main-binance", "BTC/USDT:USDT").length === 1
        ? true
        : undefined,
    100,
    "early websocket order was not stored",
  );

  const snapshot = await createPromise;
  expect(snapshot.clientOrderId).toBe(generatedCid);
  await waitForCondition(
    () => {
      const open = client.order.getOpenOrders("main-binance", "BTC/USDT:USDT");
      return open.length === 1 && open[0]?.orderId === "2001"
        ? true
        : undefined;
    },
    100,
    "pending claim created a duplicate order",
  );
});

test("createOrder command ack cannot roll back an earlier websocket fill", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [],
    createOrderDelayMs: 30,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  const iterator = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  const createPromise = client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
  });

  const request = await waitForCondition(
    () =>
      requests.find(
        (entry) =>
          entry.method === "POST" && entry.url.pathname === "/papi/v1/um/order",
      ),
    100,
    "createOrder request was not sent",
  );
  const generatedCid = request.url.searchParams.get("newClientOrderId");
  if (!generatedCid) {
    throw new Error("generated clientOrderId was not sent");
  }

  emitBinanceOrderUpdate(socket, {
    orderId: 2001,
    clientOrderId: generatedCid,
    status: "FILLED",
    price: "101000.00",
    amount: "0.010",
    filled: "0.010",
    updateTime: 1710000000500,
  });

  const filled = await nextMatchingEvent(
    iterator,
    (event) =>
      event.type === "order.filled" && event.snapshot.orderId === "2001",
    200,
    "early websocket fill was not published",
  );
  expect(filled).toMatchObject({
    type: "order.filled",
    snapshot: {
      orderId: "2001",
      clientOrderId: generatedCid,
      status: "filled",
      filled: new BigNumber("0.010").toFixed(),
      remaining: new BigNumber("0").toFixed(),
    },
  });

  const snapshot = await createPromise;
  expect(snapshot).toMatchObject({
    orderId: "2001",
    clientOrderId: generatedCid,
    status: "filled",
    filled: new BigNumber("0.010").toFixed(),
    remaining: new BigNumber("0").toFixed(),
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "2001",
    }),
  ).toMatchObject({
    status: "filled",
    filled: new BigNumber("0.010").toFixed(),
    remaining: new BigNumber("0").toFixed(),
  });
  expect(client.order.getOpenOrders("main-binance", "BTC/USDT:USDT")).toEqual(
    [],
  );

  await expectNoMatchingEvent(
    iterator,
    (event) =>
      event.type === "order.updated" &&
      event.snapshot.orderId === "2001" &&
      event.snapshot.status === "open",
    50,
    "stale REST ack published an open rollback event",
  );

  await iterator.return?.();
});

test("createOrder command ack recomputes remaining when filled is clamped", async () => {
  installBinancePrivateAccountInfra({
    openOrders: [],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
  });
  const debugClient = client as unknown as ClientDebugView;

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  emitBinanceOrderUpdate(socket, {
    orderId: 2101,
    clientOrderId: "cid-remaining",
    status: "FILLED",
    price: "101000.00",
    amount: "0.010",
    filled: "0.010",
    updateTime: 1710000000500,
  });
  await waitForCondition(
    () =>
      client.order.getOrder({
        accountId: "main-binance",
        symbol: "BTC/USDT:USDT",
        orderId: "2101",
      })?.status === "filled"
        ? true
        : undefined,
    100,
    "seed filled order was not stored",
  );

  debugClient.createOrder = async () => ({
    orderId: "2101",
    clientOrderId: "cid-remaining",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "LIMIT",
    status: "open",
    price: "101000.00",
    amount: "0.010",
    filled: "0",
    remaining: "0.010",
    avgFillPrice: "0",
    reduceOnly: false,
    positionSide: "net",
    exchangeTs: 1710000000600,
    receivedAt: Date.now(),
  });

  const snapshot = await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
    clientOrderId: "cid-remaining",
  });

  expect(snapshot).toMatchObject({
    orderId: "2101",
    status: "filled",
    filled: new BigNumber("0.010").toFixed(),
    remaining: new BigNumber("0").toFixed(),
  });
});

test("createOrder sends post-only limit orders with Binance GTX timeInForce", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
    options: {
      timestamp: 1710000000000,
    },
  });

  await client.start();

  await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000.00",
    amount: "0.010",
    postOnly: true,
  });

  const request = requests.find(
    (entry) =>
      entry.method === "POST" && entry.url.pathname === "/papi/v1/um/order",
  );
  expect(request).toBeDefined();
  expect(request?.url.searchParams.get("timeInForce")).toBe("GTX");
});

test("cancelOrder accepts clientOrderId and updates the cached snapshot", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
    options: {
      timestamp: 1710000000000,
      recvWindow: 5000,
    },
  });

  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  const canceled = await client.order.cancelOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    clientOrderId: "cid-1001",
  });

  expect(canceled).toMatchObject({
    orderId: "1001",
    clientOrderId: "cid-1001",
    symbol: "BTC/USDT:USDT",
    status: "canceled",
    filled: new BigNumber("0.005").toFixed(),
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      orderId: "1001",
    }),
  ).toMatchObject({
    status: "canceled",
  });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);

  const request = requests.find(
    (entry) =>
      entry.method === "DELETE" && entry.url.pathname === "/papi/v1/um/order",
  );
  expect(request).toBeDefined();
  expect(request?.url.searchParams.get("symbol")).toBe("BTCUSDT");
  expect(request?.url.searchParams.get("origClientOrderId")).toBe("cid-1001");
  expect(request?.url.searchParams.get("orderId")).toBeNull();
});

test("cancelAllOrders parses object response and only updates matching cached orders", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [
      {
        symbol: "BTCUSDT",
        orderId: 1001,
        clientOrderId: "cid-1001",
        side: "BUY",
        type: "LIMIT",
        status: "NEW",
        price: "100500.00",
        stopPrice: "0",
        origQty: "0.020",
        executedQty: "0.005",
        avgPrice: "100400.00",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000300,
      },
      {
        symbol: "ETHUSDT",
        orderId: 1002,
        clientOrderId: "cid-1002",
        side: "SELL",
        type: "LIMIT",
        status: "NEW",
        price: "3500.00",
        stopPrice: "0",
        origQty: "0.100",
        executedQty: "0",
        avgPrice: "0",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000310,
      },
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  const canceled = await client.order.cancelAllOrders({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(canceled).toHaveLength(1);
  expect(canceled.every((snapshot) => snapshot.status === "canceled")).toBe(
    true,
  );
  expect(canceled.map((snapshot) => snapshot.symbol)).toEqual([
    "BTC/USDT:USDT",
  ]);
  expect(canceled[0]).toMatchObject({
    orderId: "1001",
    clientOrderId: "cid-1001",
    status: "canceled",
    filled: new BigNumber("0.005").toFixed(),
  });
  expect(
    client.order.getOpenOrders("main-binance", "BTC/USDT:USDT"),
  ).toHaveLength(0);
  expect(
    client.order.getOpenOrders("main-binance", "ETH/USDT:USDT"),
  ).toHaveLength(1);

  const prefetchRequest = requests.find(
    (entry) =>
      entry.method === "GET" &&
      entry.url.pathname === "/papi/v1/um/openOrders" &&
      entry.url.searchParams.get("symbol") === "BTCUSDT",
  );
  expect(prefetchRequest).toBeDefined();

  const request = requests.find(
    (entry) =>
      entry.method === "DELETE" &&
      entry.url.pathname === "/papi/v1/um/allOpenOrders",
  );
  expect(request).toBeDefined();
  expect(request?.url.searchParams.get("symbol")).toBe("BTCUSDT");
});

test("cancelAllOrders marks both prefetch and cancel requests as cancel priority", async () => {
  installBinancePrivateAccountInfra();
  const contexts: RateLimitRequestContext[] = [];
  const captureLimiter: RateLimiter = {
    beforeRequest(ctx) {
      contexts.push(ctx);
    },
    afterResponse(): void {},
    onTransportError(): void {},
    getSnapshot(): undefined {
      return undefined;
    },
  };
  const client = createClient({
    rateLimiter: captureLimiter,
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  await client.order.cancelAllOrders({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(
    contexts.find(
      (ctx) =>
        ctx.scope.endpointKey === "GET /papi/v1/um/openOrders" &&
        ctx.priority === "cancel",
    ),
  ).toBeDefined();
  expect(
    contexts.find(
      (ctx) =>
        ctx.scope.endpointKey === "DELETE /papi/v1/um/allOpenOrders" &&
        ctx.priority === "cancel",
    ),
  ).toBeDefined();
});

test("cancelAllOrders propagates command ack write failures", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient();
  const debugClient = client as unknown as ClientDebugView;

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  debugClient.cancelAllOrders = async () => [
    {
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "LIMIT",
      status: "canceled",
      amount: "0.010",
      filled: "0",
      remaining: "0.010",
      receivedAt: 1710000000200,
    },
  ];

  const failure = await client.order
    .cancelAllOrders({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect((failure as AcexError).code).toBe("ORDER_CANCEL_ALL_FAILED");
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
});

test("cancelAllOrders synthesized ack cannot roll back a websocket fill during the command", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [
      {
        symbol: "BTCUSDT",
        orderId: 1001,
        clientOrderId: "cid-1001",
        side: "BUY",
        type: "LIMIT",
        status: "NEW",
        price: "100500.00",
        stopPrice: "0",
        origQty: "0.020",
        executedQty: "0.005",
        avgPrice: "100400.00",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000300,
      },
    ],
    openOrdersDelayMs: 30,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();
  const iterator = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await waitForCondition(
    () =>
      client.order.getOpenOrders("main-binance", "BTC/USDT:USDT").length === 1
        ? true
        : undefined,
    100,
    "bootstrap open order was not stored",
  );

  const cancelPromise = client.order.cancelAllOrders({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  await waitForCondition(
    () =>
      requests.some(
        (entry) =>
          entry.method === "GET" &&
          entry.url.pathname === "/papi/v1/um/openOrders" &&
          entry.url.searchParams.get("symbol") === "BTCUSDT",
      )
        ? true
        : undefined,
    100,
    "cancelAllOrders pre-fetch request was not sent",
  );

  emitBinanceOrderUpdate(socket, {
    orderId: 1001,
    clientOrderId: "cid-1001",
    status: "FILLED",
    price: "100500.00",
    amount: "0.020",
    filled: "0.020",
    updateTime: 1710000000500,
  });

  await nextMatchingEvent(
    iterator,
    (event) =>
      event.type === "order.filled" && event.snapshot.orderId === "1001",
    200,
    "websocket fill during cancelAllOrders was not published",
  );

  const result = await cancelPromise;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    orderId: "1001",
    clientOrderId: "cid-1001",
    status: "filled",
    filled: new BigNumber("0.020").toFixed(),
    remaining: new BigNumber("0").toFixed(),
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "1001",
    }),
  ).toMatchObject({
    status: "filled",
    filled: new BigNumber("0.020").toFixed(),
    remaining: new BigNumber("0").toFixed(),
  });
  expect(client.order.getOpenOrders("main-binance", "BTC/USDT:USDT")).toEqual(
    [],
  );

  await expectNoMatchingEvent(
    iterator,
    (event) =>
      event.type === "order.canceled" && event.snapshot.orderId === "1001",
    50,
    "stale synthesized cancelAllOrders ack published a canceled rollback event",
  );

  await iterator.return?.();
});

test("cancelAllOrders returns empty snapshots when pre-fetch finds no open orders", async () => {
  const requests = installBinancePrivateAccountInfra({
    openOrders: [],
  });
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();

  const canceled = await client.order.cancelAllOrders({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(canceled).toEqual([]);

  const prefetchRequest = requests.find(
    (entry) =>
      entry.method === "GET" &&
      entry.url.pathname === "/papi/v1/um/openOrders" &&
      entry.url.searchParams.get("symbol") === "BTCUSDT",
  );
  expect(prefetchRequest).toBeDefined();

  const request = requests.find(
    (entry) =>
      entry.method === "DELETE" &&
      entry.url.pathname === "/papi/v1/um/allOpenOrders",
  );
  expect(request).toBeDefined();
  expect(request?.url.searchParams.get("symbol")).toBe("BTCUSDT");
});

test("order cache scopes exchange order ids by symbol", async () => {
  installBinancePrivateAccountInfra({
    openOrders: [
      {
        symbol: "BTCUSDT",
        orderId: 1001,
        clientOrderId: "btc-1001",
        side: "BUY",
        type: "LIMIT",
        status: "NEW",
        price: "100500.00",
        stopPrice: "0",
        origQty: "0.020",
        executedQty: "0.005",
        avgPrice: "100400.00",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000300,
      },
      {
        symbol: "ETHUSDT",
        orderId: 1001,
        clientOrderId: "eth-1001",
        side: "SELL",
        type: "LIMIT",
        status: "NEW",
        price: "3500.00",
        stopPrice: "0",
        origQty: "0.100",
        executedQty: "0",
        avgPrice: "0",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000310,
      },
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  expect(client.order.getOpenOrders("main-binance")).toHaveLength(2);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "1001",
    }),
  ).toMatchObject({
    clientOrderId: "btc-1001",
    symbol: "BTC/USDT:USDT",
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "ETH/USDT:USDT",
      orderId: "1001",
    }),
  ).toMatchObject({
    clientOrderId: "eth-1001",
    symbol: "ETH/USDT:USDT",
  });
});

test("order cache keeps same-symbol orders with different order ids when clientOrderId collides", async () => {
  installBinancePrivateAccountInfra({
    openOrders: [
      {
        symbol: "BTCUSDT",
        orderId: 1001,
        clientOrderId: "duplicate-client-id",
        side: "BUY",
        type: "LIMIT",
        status: "NEW",
        price: "100500.00",
        stopPrice: "0",
        origQty: "0.020",
        executedQty: "0.005",
        avgPrice: "100400.00",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000300,
      },
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 0,
      },
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  socket.emitJson({
    e: "ORDER_TRADE_UPDATE",
    E: 1710000000500,
    T: 1710000000500,
    o: {
      s: "BTCUSDT",
      i: 1002,
      c: "duplicate-client-id",
      S: "SELL",
      o: "LIMIT",
      X: "NEW",
      p: "100700.00",
      sp: "0",
      q: "0.010",
      z: "0",
      ap: "0",
      R: false,
      ps: "BOTH",
    },
  });

  await waitForCondition(
    () =>
      client.order.getOpenOrders("main-binance", "BTC/USDT:USDT").length === 2
        ? true
        : undefined,
    100,
    "same-symbol clientOrderId collision was not retained as two orders",
  );

  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "1001",
    }),
  ).toMatchObject({
    clientOrderId: "duplicate-client-id",
    side: "buy",
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "1002",
    }),
  ).toMatchObject({
    clientOrderId: "duplicate-client-id",
    side: "sell",
    price: new BigNumber("100700.00").toFixed(),
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "9999",
      clientOrderId: "duplicate-client-id",
    }),
  ).toBeUndefined();
});

test("order cache trims closed orders per symbol and removes stale indexes", async () => {
  const { client, socket } = await createSubscribedOrderClient({
    maxClosedOrdersPerSymbol: 3,
  });

  for (const id of [3001, 3002, 3003, 3004]) {
    emitBinanceOrderUpdate(socket, {
      orderId: id,
      clientOrderId: `cid-${id}`,
      updateTime: 1710000000000 + id,
    });
  }

  await waitForStoredOrderCount(
    client,
    [3001, 3002, 3003, 3004],
    3,
    100,
    "closed order trim did not settle at the configured limit",
  );

  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3001",
    }),
  ).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      clientOrderId: "cid-3001",
    }),
  ).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3002",
    }),
  ).toMatchObject({
    clientOrderId: "cid-3002",
    status: "filled",
  });
});

test("order cache does not trim open orders above the closed order limit", async () => {
  const { client, socket } = await createSubscribedOrderClient({
    maxClosedOrdersPerSymbol: 3,
  });

  for (const id of [3101, 3102, 3103, 3104, 3105]) {
    emitBinanceOrderUpdate(socket, {
      orderId: id,
      clientOrderId: `cid-open-${id}`,
      status: "NEW",
      updateTime: 1710000000000 + id,
    });
  }

  await waitForCondition(
    () =>
      client.order.getOpenOrders("main-binance", "BTC/USDT:USDT").length === 5
        ? true
        : undefined,
    100,
    "open orders were trimmed by the closed order limit",
  );
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3101",
    }),
  ).toMatchObject({
    status: "open",
  });
});

test("order cache trims closed orders independently per symbol", async () => {
  const { client, socket } = await createSubscribedOrderClient({
    maxClosedOrdersPerSymbol: 2,
  });

  for (const id of [3201, 3202, 3203]) {
    emitBinanceOrderUpdate(socket, {
      symbol: "BTCUSDT",
      orderId: id,
      clientOrderId: `btc-${id}`,
      updateTime: 1710000000000 + id,
    });
  }
  for (const id of [3301, 3302, 3303]) {
    emitBinanceOrderUpdate(socket, {
      symbol: "ETHUSDT",
      orderId: id,
      clientOrderId: `eth-${id}`,
      side: "SELL",
      updateTime: 1710000000000 + id,
    });
  }

  await waitForStoredOrderCount(
    client,
    [3201, 3202, 3203],
    2,
    100,
    "BTC closed orders did not trim independently",
    "BTC/USDT:USDT",
  );
  await waitForStoredOrderCount(
    client,
    [3301, 3302, 3303],
    2,
    100,
    "ETH closed orders did not trim independently",
    "ETH/USDT:USDT",
  );

  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3201",
    }),
  ).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "ETH/USDT:USDT",
      orderId: "3301",
    }),
  ).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3202",
    }),
  ).toMatchObject({
    status: "filled",
  });
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "ETH/USDT:USDT",
      orderId: "3302",
    }),
  ).toMatchObject({
    status: "filled",
  });
});

test("order cache drops unkeyed terminal orders and emits a warning", async () => {
  const { client, socket } = await createSubscribedOrderClient({
    maxClosedOrdersPerSymbol: 3,
  });
  const errors = client.events.errors()[Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    status: "FILLED",
    updateTime: 1710000000800,
  });

  const warning = await nextEvent(errors);
  expect(warning).toMatchObject({
    source: "order",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(warning.error.message).toBe(
    "Dropped terminal order update without orderId or clientOrderId",
  );
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "0",
    }),
  ).toBeUndefined();

  await errors.return?.();
});

test("order cache normalizes invalid closed order limits to the default", async () => {
  await expectInvalidClosedOrderLimitUsesDefault(0, 3401);
  await expectInvalidClosedOrderLimitUsesDefault(-1, 4401);
  await expectInvalidClosedOrderLimitUsesDefault(3.5, 5401);
});

test("order cache does not merge a cid-only update into a reused closed clientOrderId", async () => {
  const { client, socket } = await createSubscribedOrderClient({});

  // 旧订单 orderId=7001 + clientOrderId=reuse-cid 成交进 closed
  emitBinanceOrderUpdate(socket, {
    orderId: 7001,
    clientOrderId: "reuse-cid",
    status: "FILLED",
    updateTime: 1710000010000,
  });
  await waitForCondition(
    () =>
      client.order.getOrder({
        accountId: "main-binance",
        symbol: "BTC/USDT:USDT",
        orderId: "7001",
      })?.status === "filled"
        ? true
        : undefined,
    200,
    "old order did not reach filled",
  );

  // 复用同 clientOrderId 的新订单, 更新只带 cid 不带 orderId
  emitBinanceOrderUpdate(socket, {
    clientOrderId: "reuse-cid",
    status: "NEW",
    updateTime: 1710000010100,
  });
  await waitForCondition(
    () =>
      client.order.getOpenOrders("main-binance").length === 1
        ? true
        : undefined,
    200,
    "cid-only NEW update did not create a fresh open order",
  );

  // 旧 closed 未被污染: 仍是 filled, orderId 仍可精确查到
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "7001",
    }),
  ).toMatchObject({ status: "filled", clientOrderId: "reuse-cid" });

  // cid 查询 open 优先: 返回新 open(无 orderId), 而非旧 closed
  const byCid = client.order.getOrder({
    accountId: "main-binance",
    clientOrderId: "reuse-cid",
  });
  expect(byCid).toMatchObject({ status: "open" });
  expect(byCid?.orderId).toBeUndefined();
});

test("order cache stores a cid-only terminal order as provisional and warns", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const errors = client.events.errors()[Symbol.asyncIterator]();

  // 终态单只带 clientOrderId, 不带 orderId
  emitBinanceOrderUpdate(socket, {
    clientOrderId: "provisional-cid",
    status: "FILLED",
    updateTime: 1710000020000,
  });

  const warning = await nextEvent(errors);
  expect(warning).toMatchObject({
    source: "order",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(warning.error.message).toBe(
    "Stored terminal order without orderId using provisional clientOrderId key",
  );

  // provisional 没丢: 仍可用 clientOrderId 查到
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      clientOrderId: "provisional-cid",
    }),
  ).toMatchObject({ status: "filled" });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);

  await errors.return?.();
});

test("order cache does not merge system cid-only orders and warns", async () => {
  const { client, socket } = await createSubscribedOrderClient({});
  const errors = client.events.errors()[Symbol.asyncIterator]();

  emitBinanceOrderUpdate(socket, {
    clientOrderId: "adl_autoclose",
    status: "NEW",
    updateTime: 1710000021000,
  });
  emitBinanceOrderUpdate(socket, {
    clientOrderId: "adl_autoclose",
    status: "NEW",
    updateTime: 1710000021100,
  });

  const warning = await nextEvent(errors);
  expect(warning).toMatchObject({
    source: "order",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(warning.error.message).toBe(
    "Received system clientOrderId without orderId; cid-only claim is unstable",
  );
  await waitForCondition(
    () =>
      client.order.getOpenOrders("main-binance", "BTC/USDT:USDT").length === 2
        ? true
        : undefined,
    100,
    "system cid-only updates were merged unexpectedly",
  );

  await errors.return?.();
});

test("order cache migrates a provisional cid-only order once the orderId arrives", async () => {
  const { client, socket } = await createSubscribedOrderClient({});

  // 先到 cid-only open(provisional, 无 orderId)
  emitBinanceOrderUpdate(socket, {
    clientOrderId: "late-id-cid",
    status: "NEW",
    updateTime: 1710000030000,
  });
  await waitForCondition(
    () =>
      client.order.getOpenOrders("main-binance").length === 1
        ? true
        : undefined,
    200,
    "cid-only open not stored",
  );

  // 随后同一订单带上 orderId
  emitBinanceOrderUpdate(socket, {
    orderId: 8001,
    clientOrderId: "late-id-cid",
    status: "NEW",
    updateTime: 1710000030100,
  });
  await waitForCondition(
    () =>
      client.order.getOrder({
        accountId: "main-binance",
        symbol: "BTC/USDT:USDT",
        orderId: "8001",
      })
        ? true
        : undefined,
    200,
    "order not migrated to orderId key",
  );

  // 迁移后只剩一笔(没留 provisional 旧副本), 且 cid 查询命中带 orderId 的版本
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(1);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      clientOrderId: "late-id-cid",
    }),
  ).toMatchObject({ orderId: "8001", status: "open" });
});

test("order cache migrates a provisional cid-only terminal order once the orderId arrives", async () => {
  const { client, socket } = await createSubscribedOrderClient({});

  // 终态单先到, 只带 clientOrderId(provisional closed, 无 orderId)
  emitBinanceOrderUpdate(socket, {
    clientOrderId: "term-late-cid",
    status: "FILLED",
    updateTime: 1710000040000,
  });
  await waitForCondition(
    () =>
      client.order.getOrder({
        accountId: "main-binance",
        clientOrderId: "term-late-cid",
      })?.status === "filled"
        ? true
        : undefined,
    200,
    "provisional terminal not stored",
  );

  // 同一终态单随后补上 orderId
  emitBinanceOrderUpdate(socket, {
    orderId: 9001,
    clientOrderId: "term-late-cid",
    status: "FILLED",
    updateTime: 1710000040100,
  });
  await waitForCondition(
    () =>
      client.order.getOrder({
        accountId: "main-binance",
        symbol: "BTC/USDT:USDT",
        orderId: "9001",
      })
        ? true
        : undefined,
    200,
    "provisional terminal not migrated to orderId key",
  );

  // 迁移后 cid 查询命中带 orderId 的版本, 无重复 open
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      clientOrderId: "term-late-cid",
    }),
  ).toMatchObject({ orderId: "9001", status: "filled" });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
});

test("order reconcile backfill trims closed orders without restoring open orders", async () => {
  installBinancePrivateAccountInfra({
    openOrderResponses: [
      [
        {
          symbol: "BTCUSDT",
          orderId: 3501,
          clientOrderId: "cid-3501",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "100500.00",
          stopPrice: "0",
          origQty: "0.010",
          executedQty: "0",
          avgPrice: "0",
          reduceOnly: false,
          positionSide: "BOTH",
          updateTime: 1710000000300,
        },
      ],
      [],
    ],
    queryOrder: {
      symbol: "BTCUSDT",
      orderId: 3501,
      clientOrderId: "cid-3501",
      side: "BUY",
      type: "LIMIT",
      status: "FILLED",
      price: "100500.00",
      stopPrice: "0",
      origQty: "0.010",
      executedQty: "0.010",
      avgPrice: "100500.00",
      reduceOnly: false,
      positionSide: "BOTH",
      updateTime: 1710000000600,
    },
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      binance: {
        privateReconcileIntervalMs: 5,
      },
    },
    order: {
      maxClosedOrdersPerSymbol: 1,
    },
  });

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();
  const iterator = client.order.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  emitBinanceOrderUpdate(socket, {
    orderId: 3502,
    clientOrderId: "cid-3502",
    updateTime: 1710000000700,
  });

  await waitForCondition(
    () =>
      client.order.getOrder({
        accountId: "main-binance",
        symbol: "BTC/USDT:USDT",
        orderId: "3502",
      })
        ? true
        : undefined,
    100,
    "seed closed order was not stored",
  );

  const filled = await nextMatchingEvent(
    iterator,
    (event) =>
      event.type === "order.filled" && event.snapshot.orderId === "3501",
    200,
    "reconcile backfill did not store terminal order",
  );
  expect(filled).toMatchObject({
    snapshot: {
      orderId: "3501",
      status: "filled",
    },
  });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(0);
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3502",
    }),
  ).toBeUndefined();
  expect(
    client.order.getOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "3501",
    }),
  ).toMatchObject({
    status: "filled",
  });

  await iterator.return?.();
});

test("cancelOrder validates that at least one order identifier is provided", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();

  await expect(
    client.order.cancelOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).rejects.toMatchObject({
    code: "ORDER_INPUT_INVALID",
    details: {
      orderState: "not_placed",
    },
  });
});

test("createOrder wraps adapter failures with a stable AcexError code", async () => {
  installBinancePrivateAccountInfra({ failCreateOrder: true });
  const client = createClient();
  const errors = client.events.errors()[Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();

  const failure = await client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  if (!(failure instanceof AcexError)) {
    throw new Error("Expected AcexError");
  }
  expect(failure).toMatchObject({
    code: "ORDER_CREATE_FAILED",
    details: {
      accountId: "main-binance",
      venue: "binance",
      symbol: "BTC/USDT:USDT",
      venueError: {
        code: "-2010",
        message: "Order would immediately trigger.",
        reason: "unknown",
      },
      transport: {
        kind: "http",
        status: 400,
        statusText: "Bad Request",
        retryable: false,
        attempts: 1,
      },
      orderState: "not_placed",
    },
  });
  expect(isOrderStateUnknown(failure)).toBe(false);
  expect(failure.cause).toBeInstanceOf(Error);
  expect(failure.message).toContain(
    "Binance rejected: Order would immediately trigger.",
  );
  expect(failure.message).not.toContain("signature");
  expect(failure.details?.transport?.rawBody).toBe(
    '{"code":-2010,"msg":"Order would immediately trigger."}',
  );
  expect(failure.details?.transport?.url).toContain("?query=[REDACTED]");

  const error = await nextEvent(errors);
  expect(error).toMatchObject({
    source: "adapter",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(error.error).toBeInstanceOf(Error);
  expect(error.error).not.toBeInstanceOf(AcexError);

  await errors.return?.();
});

test("cancelOrder exposes structured venue error details on adapter failures", async () => {
  installBinancePrivateAccountInfra({ failCancelOrder: true });
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();

  const failure = await client.order
    .cancelOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      orderId: "1001",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "ORDER_CANCEL_FAILED",
    details: {
      venueError: {
        code: "-2011",
        message: "Unknown order sent.",
        reason: "order_not_found",
      },
      transport: {
        kind: "http",
        status: 400,
      },
      orderState: "not_placed",
    },
  });
});

test("cancelAllOrders exposes structured venue error details on adapter failures", async () => {
  installBinancePrivateAccountInfra({ failCancelAllOrders: true });
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();

  const failure = await client.order
    .cancelAllOrders({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    })
    .catch((error) => error);

  expect(failure).toBeInstanceOf(AcexError);
  expect(failure).toMatchObject({
    code: "ORDER_CANCEL_ALL_FAILED",
    details: {
      venueError: {
        code: "-2011",
        message: "Unknown order sent.",
        reason: "order_not_found",
      },
      transport: {
        kind: "http",
        status: 400,
      },
      orderState: "not_placed",
    },
  });
});

test("createOrder rejects missing Binance credentials before sending adapter commands", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
  });
  await client.start();

  await expect(
    client.order.createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    }),
  ).rejects.toMatchObject({
    code: "CREDENTIALS_MISSING",
  });
  expect(requests).toHaveLength(0);
});

test("order public status stream and unsubscribe expose stopped semantics", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
    },
  });
  const statusIterator = client.order.events
    .status({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  expect(await nextEvent(statusIterator)).toMatchObject({
    type: "order.status_changed",
    accountId: "main-binance",
    status: {
      activity: "active",
      runtimeStatus: "bootstrap_pending",
      ready: false,
    },
  });
  expect(await nextEvent(statusIterator)).toMatchObject({
    status: {
      activity: "active",
      runtimeStatus: "healthy",
      ready: true,
    },
  });
  expect(client.order.getOpenOrders("main-binance")).toHaveLength(1);

  await client.order.unsubscribeOrders({
    accountId: "main-binance",
  });

  expect(await nextEvent(statusIterator)).toMatchObject({
    status: {
      activity: "inactive",
      runtimeStatus: "stopped",
      ready: true,
      reason: undefined,
    },
  });
  expect(client.order.getOrderStatus("main-binance")).toMatchObject({
    activity: "inactive",
    runtimeStatus: "stopped",
    ready: true,
  });
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

  await statusIterator.return?.();
});

test("Juplend order subscriptions are rejected as unsupported", async () => {
  const client = createClient();

  await client.registerAccount({
    accountId: "jup-loop-a",
    venue: "juplend",
    options: {
      walletAddress: "wallet",
    },
  });
  await client.start();

  await expect(
    client.order.subscribeOrders({
      accountId: "jup-loop-a",
    }),
  ).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
  });
});

test("Juplend order commands are rejected before adapter command methods", async () => {
  const client = createClient();

  await client.registerAccount({
    accountId: "jup-loop-a",
    venue: "juplend",
    options: {
      walletAddress: "wallet",
    },
  });
  await client.start();

  await expect(
    client.order.createOrder({
      accountId: "jup-loop-a",
      symbol: "SOL/USDC",
      side: "buy",
      type: "limit",
      price: "100",
      amount: "1",
    }),
  ).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
    message: "Venue does not support private order commands: juplend",
  });

  await expect(
    client.order.cancelOrder({
      accountId: "jup-loop-a",
      symbol: "SOL/USDC",
      orderId: "order-1",
    }),
  ).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
    message: "Venue does not support private order commands: juplend",
  });

  await expect(
    client.order.cancelAllOrders({
      accountId: "jup-loop-a",
      symbol: "SOL/USDC",
    }),
  ).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
    message: "Venue does not support private order commands: juplend",
  });
});
