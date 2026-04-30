import { expect, test } from "bun:test";
import { AcexError, BigNumber, createClient } from "../../index.ts";
import {
  installBinancePrivateAccountInfra,
  PAPI_ACCOUNT_WS_URL,
  PAPI_LISTEN_KEY,
} from "../support/exchanges/binance.ts";
import {
  FakeWebSocket,
  nextEvent,
  waitForSocket,
} from "../support/test-utils.ts";

test("account subscribe bootstraps Binance PAPI UM account data and applies updates", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });
  const iterator = client.account.events
    .updates({
      accountId: "main-binance",
      exchange: "binance",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    exchange: "binance",
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
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;

  const snapshotEvent = await nextEvent(iterator);
  expect(snapshotEvent).toMatchObject({
    type: "account.snapshot_replaced",
    accountId: "main-binance",
    exchange: "binance",
  });

  const snapshot = client.account.getAccountSnapshot("main-binance");
  const usdt = client.account.getBalance("main-binance", "USDT");
  const position = client.account.getPosition({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  const risk = client.account.getRiskSnapshot("main-binance");
  const status = client.account.getAccountStatus("main-binance");

  expect(snapshot).toBeDefined();
  expect(usdt).toMatchObject({
    asset: "USDT",
    free: new BigNumber("1000.25"),
    used: new BigNumber("250.25"),
    total: new BigNumber("1250.50"),
  });
  expect(position).toMatchObject({
    symbol: "BTC/USDT:USDT",
    side: "net",
    size: new BigNumber("0.010"),
    entryPrice: new BigNumber("100000.10"),
    markPrice: new BigNumber("101000.20"),
    unrealizedPnl: new BigNumber("10.50"),
  });
  expect(risk).toMatchObject({
    equity: new BigNumber("1400.75"),
    marginRatio: new BigNumber("31.0"),
    initialMargin: new BigNumber("120.10"),
    maintenanceMargin: new BigNumber("45.20"),
  });
  expect(status).toMatchObject({
    activity: "active",
    ready: true,
    runtimeStatus: "healthy",
  });

  const signedRequests = requests.filter((request) =>
    [
      "/papi/v1/balance",
      "/papi/v1/account",
      "/papi/v1/um/positionRisk",
    ].includes(request.url.pathname),
  );
  expect(signedRequests).toHaveLength(3);
  for (const request of signedRequests) {
    expect(request.apiKey).toBe("key");
    expect(request.url.searchParams.get("timestamp")).toBe("1710000000000");
    expect(request.url.searchParams.get("recvWindow")).toBe("5000");
    expect(request.url.searchParams.has("signature")).toBe(true);
  }

  socket.emitJson({
    e: "ACCOUNT_UPDATE",
    E: 1710000000400,
    T: 1710000000300,
    a: {
      B: [
        {
          a: "USDT",
          wb: "1300.50",
          cw: "1050.25",
        },
      ],
      P: [
        {
          s: "BTCUSDT",
          pa: "0.020",
          ep: "100100.10",
          up: "25.50",
          ps: "BOTH",
        },
      ],
    },
  });

  expect(await nextEvent(iterator)).toMatchObject({
    type: "balance.updated",
    asset: "USDT",
    snapshot: {
      free: new BigNumber("1050.25"),
      used: new BigNumber("250.25"),
      total: new BigNumber("1300.50"),
    },
  });
  expect(await nextEvent(iterator)).toMatchObject({
    type: "position.updated",
    symbol: "BTC/USDT:USDT",
    snapshot: {
      size: new BigNumber("0.020"),
      entryPrice: new BigNumber("100100.10"),
      unrealizedPnl: new BigNumber("25.50"),
    },
  });
  expect(client.account.getBalance("main-binance", "USDT")).toMatchObject({
    total: new BigNumber("1300.50"),
  });
  expect(
    client.account.getPosition({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    size: new BigNumber("0.020"),
  });

  socket.disconnect();
  await Bun.sleep(0);
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    ready: true,
    runtimeStatus: "reconnecting",
    reason: "ws_disconnected",
  });

  const reconnectSocket = await waitForSocket(PAPI_ACCOUNT_WS_URL, 1, 100);
  await Bun.sleep(0);
  expect(reconnectSocket.readyState).toBe(FakeWebSocket.OPEN);
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    runtimeStatus: "healthy",
    reason: undefined,
  });

  await iterator.return?.();
});

test("private subscriptions validate credentials at subscribe time", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });

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
  await waitForSocket(PAPI_ACCOUNT_WS_URL);

  const snapshot = client.account.getAccountSnapshot("main-binance");
  const status = client.account.getAccountStatus("main-binance");

  expect(snapshot).toBeDefined();
  expect(status?.ready).toBe(true);
  expect(status?.activity).toBe("active");
});

test("account bootstrap failure does not create a placeholder snapshot", async () => {
  installBinancePrivateAccountInfra({ failBootstrap: true });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
    },
  });
  const errors = client.events.errors()[Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: "main-binance",
    exchange: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  await expect(
    client.account.subscribeAccount({
      accountId: "main-binance",
    }),
  ).rejects.toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });

  expect(client.account.getAccountSnapshot("main-binance")).toBeUndefined();
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    ready: false,
    runtimeStatus: "degraded",
    reason: "auth_failed",
  });

  const error = await nextEvent(errors);
  expect(error).toMatchObject({
    source: "adapter",
    accountId: "main-binance",
    exchange: "binance",
  });

  await errors.return?.();
});

test("removeAccount auto-cleans active private subscriptions and caches", async () => {
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
  await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  await client.removeAccount("main-binance");

  expect(client.account.getAccountSnapshot("main-binance")).toBeUndefined();
  expect(client.order.getOrderStatus("main-binance")).toBeUndefined();
  expect(client.getHealth().accounts).toHaveLength(0);
  expect(client.getHealth().orders).toHaveLength(0);
  expect(
    requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url.pathname === "/papi/v1/listenKey" &&
        request.url.searchParams.get("listenKey") === PAPI_LISTEN_KEY,
    ),
  ).toBe(true);
});

test("account public getters expose collections and unsubscribe publishes stopped status", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
    },
  });
  const statusIterator = client.account.events
    .status({
      accountId: "main-binance",
      exchange: "binance",
    })
    [Symbol.asyncIterator]();

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
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  expect(await nextEvent(statusIterator)).toMatchObject({
    type: "account.status_changed",
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

  expect(client.account.getBalances("main-binance")).toHaveLength(2);
  expect(client.account.getBalances("missing-binance")).toEqual([]);
  expect(client.account.getPositions("main-binance")).toHaveLength(1);
  expect(
    client.account.getPositions("main-binance", "BTC/USDT:USDT"),
  ).toHaveLength(1);
  expect(client.account.getPositions("main-binance", "ETH/USDT:USDT")).toEqual(
    [],
  );

  await client.account.unsubscribeAccount({
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
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    activity: "inactive",
    runtimeStatus: "stopped",
    ready: true,
  });
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

  await statusIterator.return?.();
});
