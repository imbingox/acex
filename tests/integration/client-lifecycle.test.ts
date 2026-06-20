import { expect, test } from "bun:test";
import { AcexError, BigNumber, createClient } from "../../index.ts";
import { stopAllClientsForTests } from "../../src/client/runtime.ts";
import {
  BINANCE_USDM_MARKET_WS_BASE_URL,
  BINANCE_USDM_WS_BASE_URL,
  installBinanceMarketInfra,
  installBinancePrivateAccountInfra,
  PAPI_ACCOUNT_WS_URL,
  waitForBinanceControlFrame,
} from "../support/exchanges/binance.ts";
import {
  expectPending,
  nextEvent,
  waitForSocket,
} from "../support/test-utils.ts";

async function registerStartedBinanceClient(): Promise<
  ReturnType<typeof createClient>
> {
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
  return client;
}

test("root entry exposes lifecycle snapshot and structured error stream", async () => {
  const client = createClient();
  const errors = client.events.errors()[Symbol.asyncIterator]();

  expect(client.getStatus()).toBe("idle");
  expect(client.getHealth()).toMatchObject({
    clientStatus: "idle",
    markets: [],
    accounts: [],
    orders: [],
  });
  expect(new BigNumber("1.25").plus("2.5").toFixed()).toBe("3.75");

  await expect(
    client.market.acquireL1BookSubscription({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).rejects.toMatchObject({
    code: "CLIENT_NOT_STARTED",
  });

  const errorEvent = await nextEvent(errors);
  expect(errorEvent.source).toBe("client");
  expect(errorEvent.error).toBeInstanceOf(AcexError);
  expect((errorEvent.error as AcexError).code).toBe("CLIENT_NOT_STARTED");

  await errors.return?.();
});

test("client exposes venue runtime capabilities without starting", () => {
  const client = createClient();

  const binance = client.getVenueCapabilities("binance");
  expect(binance).toMatchObject({
    venue: "binance",
    runtimeStatus: "available",
    readOnly: false,
    market: {
      catalog: "supported",
      serverTime: "supported",
      publicTrades: "supported",
      publicRawTrades: "supported",
      fundingRateHistory: "supported",
      l1Book: "supported",
      fundingRate: "market_dependent",
    },
    account: {
      snapshot: "supported",
      updates: "websocket",
      lending: "supported",
    },
    order: {
      supported: true,
      fees: "supported",
      create: "supported",
      cancelAll: "symbol",
      orderTypes: ["limit", "market"],
      postOnly: true,
      reduceOnly: true,
      positionSide: "required_for_hedge",
      clientOrderId: true,
    },
  });

  expect(client.getVenueCapabilities("juplend")).toMatchObject({
    venue: "juplend",
    runtimeStatus: "available",
    readOnly: true,
    market: {
      serverTime: "unsupported",
      publicTrades: "unsupported",
      publicRawTrades: "unsupported",
      fundingRateHistory: "unsupported",
    },
    account: {
      snapshot: "supported",
      updates: "polling",
      lending: "supported",
    },
    order: {
      supported: false,
      fees: "unsupported",
      reason: "read_only",
    },
  });

  for (const venue of ["okx", "bybit", "gate"] as const) {
    expect(client.getVenueCapabilities(venue)).toMatchObject({
      venue,
      runtimeStatus: "type_only",
      market: {
        catalog: "unsupported",
        serverTime: "unsupported",
        publicTrades: "unsupported",
        publicRawTrades: "unsupported",
        fundingRateHistory: "unsupported",
      },
      order: {
        supported: false,
        reason: "not_implemented",
      },
    });
  }

  expect(client.listVenueCapabilities().map((entry) => entry.venue)).toEqual([
    "binance",
    "okx",
    "bybit",
    "gate",
    "juplend",
  ]);

  binance.notes.push("caller mutation");
  binance.order.orderTypes.push("limit");

  expect(client.getVenueCapabilities("binance").notes).not.toContain(
    "caller mutation",
  );
  expect(client.getVenueCapabilities("binance").order.orderTypes).toEqual([
    "limit",
    "market",
  ]);
});

test("client stop keeps lifecycle and market health semantics observable", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });

  await client.start();

  const l1Lease = await client.market.acquireL1BookSubscription({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const subscribePromise = l1Lease.ready;
  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@bookTicker"]);
  socket.emitJson({
    s: "BTCUSDT",
    b: "100001.10",
    B: "0.2500",
    a: "100001.20",
    A: "0.3500",
    T: 1710000000003,
  });

  await subscribePromise;

  const fundingLease = await client.market.acquireFundingRateSubscription({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const fundingSubscribePromise = fundingLease.ready;
  const fundingSocket = await waitForSocket(BINANCE_USDM_MARKET_WS_BASE_URL);
  await waitForBinanceControlFrame(fundingSocket, "SUBSCRIBE", [
    "btcusdt@markPrice",
  ]);
  fundingSocket.emitJson({
    e: "markPriceUpdate",
    E: 1710000000004,
    s: "BTCUSDT",
    p: "100001.15",
    i: "100000.00",
    r: "0.00010000",
    T: 1710028800000,
  });
  await fundingSubscribePromise;

  await client.stop({ graceful: true, timeoutMs: 5_000 });

  expect(client.getStatus()).toBe("stopped");
  expect(client.getHealth()).toMatchObject({
    clientStatus: "stopped",
    markets: [
      {
        venue: "binance",
        symbol: "BTC/USDT:USDT",
        activity: "inactive",
        ready: true,
        freshness: "stale",
      },
    ],
  });
  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    status: {
      activity: "inactive",
      ready: true,
      freshness: "stale",
    },
  });
  expect(
    client.market.getFundingRate({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    status: {
      activity: "inactive",
      ready: true,
      freshness: "stale",
    },
  });

  await client.start();

  const restoredBookSocket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 1);
  await waitForBinanceControlFrame(restoredBookSocket, "SUBSCRIBE", [
    "btcusdt@bookTicker",
  ]);
  restoredBookSocket.emitJson({
    s: "BTCUSDT",
    b: "100002.10",
    B: "0.2500",
    a: "100002.20",
    A: "0.3500",
    T: 1710000000005,
  });
  const restoredFundingSocket = await waitForSocket(
    BINANCE_USDM_MARKET_WS_BASE_URL,
    1,
  );
  await waitForBinanceControlFrame(restoredFundingSocket, "SUBSCRIBE", [
    "btcusdt@markPrice",
  ]);
  restoredFundingSocket.emitJson({
    e: "markPriceUpdate",
    E: 1710000000006,
    s: "BTCUSDT",
    p: "100002.15",
    i: "100001.00",
    r: "0.00020000",
    T: 1710028800000,
  });
  await Bun.sleep(0);

  expect(
    client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    bidPrice: new BigNumber("100002.10").toFixed(),
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
  });
  expect(
    client.market.getFundingRate({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    fundingRate: new BigNumber("0.00020000").toFixed(),
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
  });
});

test("client graceful stop waits for in-flight order commands", async () => {
  installBinancePrivateAccountInfra({ createOrderDelayMs: 40 });
  const client = await registerStartedBinanceClient();
  let commandSettled = false;

  const command = client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .finally(() => {
      commandSettled = true;
    });
  await Bun.sleep(0);

  await client.stop({ graceful: true, timeoutMs: 500 });

  expect(commandSettled).toBe(true);
  expect(client.getStatus()).toBe("stopped");
  await command;
});

test("client graceful stop timeout forces teardown with commands still pending", async () => {
  installBinancePrivateAccountInfra({ createOrderDelayMs: 80 });
  const client = await registerStartedBinanceClient();
  let commandSettled = false;

  const command = client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .finally(() => {
      commandSettled = true;
    });
  await Bun.sleep(0);

  await client.stop({ graceful: true, timeoutMs: 5 });

  expect(client.getStatus()).toBe("stopped");
  expect(commandSettled).toBe(false);
  await command;
});

test("client stop graceful false tears down without waiting for commands", async () => {
  installBinancePrivateAccountInfra({ createOrderDelayMs: 50 });
  const client = await registerStartedBinanceClient();
  let commandSettled = false;

  const command = client.order
    .createOrder({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "101000.00",
      amount: "0.010",
    })
    .finally(() => {
      commandSettled = true;
    });
  await Bun.sleep(0);

  await client.stop({ graceful: false });

  expect(client.getStatus()).toBe("stopped");
  expect(commandSettled).toBe(false);
  await command;
});

test("stopped clients are removed from test cleanup tracking", async () => {
  const client = createClient();
  await client.stop();

  let cleanupStopCalled = false;
  if (
    !Reflect.set(client, "stop", () => {
      cleanupStopCalled = true;
      return Promise.resolve();
    })
  ) {
    throw new Error("Failed to install stop spy");
  }

  await stopAllClientsForTests();

  expect(cleanupStopCalled).toBe(false);
});

test("health venue filters only emit matching market events", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });
  const health = client.events.health()[Symbol.asyncIterator]();
  const binanceHealth = client.events
    .health({ venue: "binance" })
    [Symbol.asyncIterator]();
  const firstBinanceEvent = binanceHealth.next();

  await client.start();

  expect(await nextEvent(health)).toMatchObject({
    type: "client.status_changed",
    status: "starting",
  });
  expect(await nextEvent(health)).toMatchObject({
    type: "client.status_changed",
    status: "running",
  });
  await expectPending(firstBinanceEvent, 20);

  const l1Lease = await client.market.acquireL1BookSubscription({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const subscribePromise = l1Lease.ready;
  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@bookTicker"]);
  socket.emitJson({
    s: "BTCUSDT",
    b: "102100.10",
    B: "1.000",
    a: "102100.20",
    A: "2.000",
    T: 1710000000002,
  });

  await subscribePromise;

  const marketStatusEvent = await firstBinanceEvent;
  expect(marketStatusEvent.done).toBe(false);
  if (marketStatusEvent.done) {
    throw new Error("Filtered health stream closed unexpectedly");
  }

  expect(marketStatusEvent.value).toMatchObject({
    type: "market.status_changed",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    status: {
      activity: "active",
    },
  });
  let readyBinanceEvent: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const event = await nextEvent(binanceHealth);
    if (event.type === "market.status_changed" && event.status.ready) {
      readyBinanceEvent = event;
      break;
    }
  }

  expect(readyBinanceEvent).toMatchObject({
    type: "market.status_changed",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    status: {
      ready: true,
      freshness: "fresh",
    },
  });
  expect(client.getHealth()).toMatchObject({
    clientStatus: "running",
    markets: [
      expect.objectContaining({
        venue: "binance",
        symbol: "BTC/USDT:USDT",
        activity: "active",
        ready: true,
        freshness: "fresh",
      }),
    ],
  });

  await health.return?.();
  await binanceHealth.return?.();
});

test("health account filters only emit matching private status events", async () => {
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

  const accountHealth = client.events
    .health({ accountId: "main-binance" })
    [Symbol.asyncIterator]();
  const firstAccountHealthEvent = accountHealth.next();

  await client.start();
  await expectPending(firstAccountHealthEvent, 20);

  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });

  const accountEvent = await firstAccountHealthEvent;
  expect(accountEvent.done).toBe(false);
  if (accountEvent.done) {
    throw new Error("Account-filtered health stream closed unexpectedly");
  }

  expect(accountEvent.value).toMatchObject({
    type: "account.status_changed",
    accountId: "main-binance",
    venue: "binance",
    status: {
      activity: "active",
      ready: false,
      runtimeStatus: "bootstrap_pending",
    },
  });

  await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;

  expect(await nextEvent(accountHealth)).toMatchObject({
    type: "account.status_changed",
    accountId: "main-binance",
    venue: "binance",
    status: {
      activity: "active",
      ready: true,
      runtimeStatus: "healthy",
    },
  });

  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  expect(await nextEvent(accountHealth)).toMatchObject({
    type: "order.status_changed",
    accountId: "main-binance",
    venue: "binance",
    status: {
      activity: "active",
      ready: true,
      runtimeStatus: "healthy",
    },
  });
  expect(client.getHealth()).toMatchObject({
    clientStatus: "running",
    accounts: [
      expect.objectContaining({
        accountId: "main-binance",
        venue: "binance",
        activity: "active",
        ready: true,
      }),
    ],
    orders: [
      expect.objectContaining({
        accountId: "main-binance",
        venue: "binance",
        activity: "active",
        ready: true,
      }),
    ],
  });

  await accountHealth.return?.();
});
