import { expect, test } from "bun:test";
import { AcexError, BigNumber, createClient } from "../../index.ts";
import {
  installBinanceMarketInfra,
  installBinancePrivateAccountInfra,
  PAPI_ACCOUNT_WS_URL,
} from "../support/exchanges/binance.ts";
import {
  expectPending,
  nextEvent,
  waitForSocket,
} from "../support/test-utils.ts";

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
    client.market.subscribeL1Book({
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

test("client stop keeps lifecycle and market health semantics observable", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 200,
      l1StaleAfterMs: 50,
    },
  });

  await client.start();

  const subscribePromise = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const socket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
  );
  socket.emitJson({
    b: "100001.10",
    B: "0.2500",
    a: "100001.20",
    A: "0.3500",
    T: 1710000000003,
  });

  await subscribePromise;

  const fundingSubscribePromise = client.market.subscribeFundingRate({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const fundingSocket = await waitForSocket(
    "wss://fstream.binance.com/market/ws/btcusdt@markPrice",
  );
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

  const restoredBookSocket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    1,
  );
  restoredBookSocket.emitJson({
    b: "100002.10",
    B: "0.2500",
    a: "100002.20",
    A: "0.3500",
    T: 1710000000005,
  });
  const restoredFundingSocket = await waitForSocket(
    "wss://fstream.binance.com/market/ws/btcusdt@markPrice",
    1,
  );
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
    bidPrice: new BigNumber("100002.10"),
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
    fundingRate: new BigNumber("0.00020000"),
    status: {
      activity: "active",
      ready: true,
      freshness: "fresh",
    },
  });
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

  const subscribePromise = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const socket = await waitForSocket(
    "wss://fstream.binance.com/ws/btcusdt@bookTicker",
    0,
  );
  socket.emitJson({
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
  expect(await nextEvent(binanceHealth)).toMatchObject({
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
