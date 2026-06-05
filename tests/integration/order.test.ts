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
