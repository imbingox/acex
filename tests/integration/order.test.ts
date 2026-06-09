import { expect, test } from "bun:test";
import { AcexError, BigNumber, createClient } from "../../index.ts";
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
  status?: BinanceOrderStatus;
  price?: string;
  amount?: string;
  filled?: string;
  updateTime?: number;
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
    ps: "BOTH",
  };

  if (input.orderId !== undefined) {
    order.i = input.orderId;
  }
  if (input.clientOrderId !== undefined) {
    order.c = input.clientOrderId;
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

test("private order reconcile degrades and keeps snapshot when terminal backfill is missing", async () => {
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
    failQueryOrder: true,
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
    200,
    "order reconcile did not degrade",
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
    queryOrderResponses: [
      {},
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
    200,
    "order reconcile did not degrade",
  );
  await waitForCondition(
    () =>
      client.order.getOrderStatus("main-binance")?.runtimeStatus === "healthy"
        ? true
        : undefined,
    300,
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

test("cancelAllOrders scopes by symbol and only updates matching cached orders", async () => {
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
    cancelAllOrders: [
      {
        symbol: "BTCUSDT",
        orderId: 1001,
        clientOrderId: "cid-1001",
        side: "BUY",
        type: "LIMIT",
        status: "CANCELED",
        price: "100500.00",
        stopPrice: "0",
        origQty: "0.020",
        executedQty: "0.005",
        avgPrice: "100400.00",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000360,
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
  expect(canceled[0]).toMatchObject({
    orderId: "1001",
    status: "canceled",
  });
  expect(
    client.order.getOpenOrders("main-binance", "BTC/USDT:USDT"),
  ).toHaveLength(0);
  expect(
    client.order.getOpenOrders("main-binance", "ETH/USDT:USDT"),
  ).toHaveLength(1);

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
      },
      transport: {
        kind: "http",
        status: 400,
        statusText: "Bad Request",
        retryable: false,
        attempts: 1,
      },
    },
  });
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
      },
      transport: {
        kind: "http",
        status: 400,
      },
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
      },
      transport: {
        kind: "http",
        status: 400,
      },
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
