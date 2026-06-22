import { expect, test } from "bun:test";
import {
  type AccountEvent,
  AcexError,
  BigNumber,
  createClient,
  type RateLimiter,
  type RateLimitScope,
  type RegisterAccountInput,
  type TimeProvider,
} from "../../index.ts";
import {
  installBinancePrivateAccountInfra,
  PAPI_ACCOUNT_WS_URL,
  PAPI_LISTEN_KEY,
  papiAccountWsUrl,
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

async function nextAccountEventOfType<T extends AccountEvent["type"]>(
  iterator: AsyncIterator<AccountEvent>,
  type: T,
  timeoutMs = 1000,
): Promise<Extract<AccountEvent, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const event = await nextEvent(iterator, remainingMs);
    if (event.type === type) {
      return event as Extract<AccountEvent, { type: T }>;
    }
  }

  throw new Error(`Timed out waiting for ${type}`);
}

function signedBootstrapRequests(
  requests: ReturnType<typeof installBinancePrivateAccountInfra>,
): ReturnType<typeof installBinancePrivateAccountInfra> {
  return requests.filter((request) =>
    [
      "/papi/v1/balance",
      "/papi/v1/account",
      "/papi/v1/um/positionRisk",
    ].includes(request.url.pathname),
  );
}

async function withFixedDateNow<T>(
  now: number,
  run: () => Promise<T>,
): Promise<T> {
  const originalDateNow = Date.now;
  Date.now = () => now;
  try {
    return await run();
  } finally {
    Date.now = originalDateNow;
  }
}

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
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;

  const snapshotEvent = await nextEvent(iterator);
  expect(snapshotEvent).toMatchObject({
    type: "account.snapshot_replaced",
    accountId: "main-binance",
    venue: "binance",
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
    free: new BigNumber("1000.25").toFixed(),
    used: new BigNumber("250.25").toFixed(),
    total: new BigNumber("1250.50").toFixed(),
  });
  expect(position).toMatchObject({
    symbol: "BTC/USDT:USDT",
    side: "net",
    size: new BigNumber("0.010").toFixed(),
    entryPrice: new BigNumber("100000.10").toFixed(),
    markPrice: new BigNumber("101000.20").toFixed(),
    unrealizedPnl: new BigNumber("10.50").toFixed(),
  });
  expect(risk).toMatchObject({
    riskLevel: "normal",
    netEquity: new BigNumber("1300.50").toFixed(),
    riskEquity: new BigNumber("1400.75").toFixed(),
    riskRatio: new BigNumber(1).dividedBy("31.0").toFixed(),
    riskLeverage: new BigNumber("1010.002").dividedBy("1400.75").toFixed(),
    initialMargin: new BigNumber("120.10").toFixed(),
    maintenanceMargin: new BigNumber("45.20").toFixed(),
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

  const accountUpdateTs = Date.now();
  socket.emitJson({
    e: "ACCOUNT_UPDATE",
    E: accountUpdateTs,
    T: accountUpdateTs,
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
      free: new BigNumber("1050.25").toFixed(),
      used: new BigNumber("250.25").toFixed(),
      total: new BigNumber("1300.50").toFixed(),
    },
  });
  expect(await nextEvent(iterator)).toMatchObject({
    type: "position.updated",
    symbol: "BTC/USDT:USDT",
    snapshot: {
      size: new BigNumber("0.020").toFixed(),
      entryPrice: new BigNumber("100100.10").toFixed(),
      unrealizedPnl: new BigNumber("25.50").toFixed(),
    },
  });
  expect(await nextEvent(iterator)).toMatchObject({
    type: "risk.updated",
    snapshot: {
      riskLeverage: new BigNumber("0.020")
        .multipliedBy("101000.20")
        .dividedBy("1400.75")
        .toFixed(),
      exchangeTs: accountUpdateTs,
    },
  });
  expect(client.account.getBalance("main-binance", "USDT")).toMatchObject({
    total: new BigNumber("1300.50").toFixed(),
  });
  expect(
    client.account.getPosition({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    size: new BigNumber("0.020").toFixed(),
  });
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    riskLeverage: new BigNumber("0.020")
      .multipliedBy("101000.20")
      .dividedBy("1400.75")
      .toFixed(),
  });

  const closePositionTs = accountUpdateTs + 1;
  socket.emitJson({
    e: "ACCOUNT_UPDATE",
    E: closePositionTs,
    T: closePositionTs,
    a: {
      P: [
        {
          s: "BTCUSDT",
          pa: "0",
          ep: "100100.10",
          up: "0",
          ps: "BOTH",
        },
      ],
    },
  });

  expect(await nextEvent(iterator)).toMatchObject({
    type: "position.updated",
    symbol: "BTC/USDT:USDT",
    snapshot: {
      size: "0",
    },
  });
  expect(await nextEvent(iterator)).toMatchObject({
    type: "risk.updated",
    snapshot: {
      riskLeverage: "0",
      exchangeTs: closePositionTs,
    },
  });
  expect(
    client.account.getPosition({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toBeUndefined();
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    riskLeverage: "0",
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

test("account fetchFundingFeeHistory returns Binance PAPI UM funding fee income", async () => {
  const requests = installBinancePrivateAccountInfra({
    fundingFeeIncome: [
      {
        symbol: "BTCUSDT",
        incomeType: "FUNDING_FEE",
        income: "0.00001000",
        asset: "USDT",
        time: 1710000000000,
        tranId: 90001,
      },
    ],
  });
  const client = createClient();

  try {
    await client.registerAccount({
      accountId: "main-binance",
      venue: "binance",
      credentials: {
        apiKey: "key",
        secret: "secret",
      },
      options: {
        timestamp: 1710000000999,
        recvWindow: 5000,
      },
    });
    await client.start();

    const result = await client.account.fetchFundingFeeHistory({
      accountId: "main-binance",
      symbols: ["BTC/USDT:USDT"],
      startTs: 1700000000000,
      endTs: 1700003600000,
      page: 2,
      limit: 1000,
    });

    expect(result).toMatchObject({
      page: 2,
      limit: 1000,
      truncated: false,
      fees: [
        {
          accountId: "main-binance",
          venue: "binance",
          symbol: "BTC/USDT:USDT",
          asset: "USDT",
          amount: "0.00001",
          fundingTime: 1710000000000,
          venueTransactionId: "90001",
        },
      ],
    });

    const incomeRequest = requests.find(
      (request) => request.url.pathname === "/papi/v1/um/income",
    );
    expect(incomeRequest?.url.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(incomeRequest?.url.searchParams.get("incomeType")).toBe(
      "FUNDING_FEE",
    );
    expect(incomeRequest?.url.searchParams.get("startTime")).toBe(
      "1700000000000",
    );
    expect(incomeRequest?.url.searchParams.get("endTime")).toBe(
      "1700003600000",
    );
    expect(incomeRequest?.url.searchParams.get("page")).toBe("2");
    expect(incomeRequest?.url.searchParams.get("limit")).toBe("1000");
    expect(incomeRequest?.url.searchParams.get("timestamp")).toBe(
      "1710000000999",
    );
  } finally {
    await client.stop();
  }
});

test("account fetchFundingFeeHistory rejects missing Binance credentials before REST", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient();

  try {
    await client.registerAccount({
      accountId: "main-binance",
      venue: "binance",
    });
    await client.start();

    await expect(
      client.account.fetchFundingFeeHistory({
        accountId: "main-binance",
      }),
    ).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
    });
    expect(
      requests.some((request) => request.url.pathname === "/papi/v1/um/income"),
    ).toBe(false);
  } finally {
    await client.stop();
  }
});

test("Binance margin liability updates merge partial lending fields without accumulating", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          privateReconcileIntervalMs: 0,
          riskPollIntervalMs: 60_000,
        },
      },
    },
  });
  const iterator = client.account.events
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
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;
  await nextAccountEventOfType(iterator, "account.snapshot_replaced");

  const firstLiabilityTs = Date.now();
  socket.emitJson({
    e: "liabilityChange",
    E: firstLiabilityTs,
    a: "USDT",
    i: "0.25",
    l: "5.25",
    T: firstLiabilityTs,
  });
  const firstUpdate = await nextAccountEventOfType(iterator, "balance.updated");
  expect(firstUpdate.snapshot).toMatchObject({
    asset: "USDT",
    free: new BigNumber("1000.25").toFixed(),
    used: new BigNumber("250.25").toFixed(),
    total: new BigNumber("1250.50").toFixed(),
    lending: {
      supplied: "0",
      borrowed: "5.25",
      interest: "0.25",
      netAsset: "0",
    },
  });

  const secondLiabilityTs = firstLiabilityTs + 1;
  socket.emitJson({
    e: "liabilityChange",
    E: secondLiabilityTs,
    a: "USDT",
    l: "6.5",
    T: secondLiabilityTs,
  });
  const secondUpdate = await nextAccountEventOfType(
    iterator,
    "balance.updated",
  );
  expect(secondUpdate.snapshot).toMatchObject({
    asset: "USDT",
    lending: {
      supplied: "0",
      borrowed: "6.5",
      interest: "0.25",
      netAsset: "0",
    },
  });
  expect(client.account.getBalance("main-binance", "USDT")?.lending).toEqual({
    supplied: "0",
    borrowed: "6.5",
    interest: "0.25",
    netAsset: "0",
  });

  await iterator.return?.();
});

test("Binance ACCOUNT_UPDATE does not derive risk leverage without mark price", async () => {
  installBinancePrivateAccountInfra({
    umPositions: [
      {
        symbol: "BTCUSDT",
        positionAmt: "0.010",
        entryPrice: "100000.10",
        unRealizedProfit: "10.50",
        liquidationPrice: "80000.00",
        leverage: "5",
        notional: "1010.002",
        positionSide: "BOTH",
        updateTime: 1710000000200,
      },
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          riskPollIntervalMs: 10_000,
          privateReconcileIntervalMs: 0,
        },
      },
    },
  });
  const iterator = client.account.events
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
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;
  expect(await nextEvent(iterator)).toMatchObject({
    type: "account.snapshot_replaced",
  });
  const initialRiskLeverage =
    client.account.getRiskSnapshot("main-binance")?.riskLeverage;

  socket.emitJson({
    e: "ACCOUNT_UPDATE",
    E: 1710000000500,
    T: 1710000000500,
    a: {
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
    type: "position.updated",
    symbol: "BTC/USDT:USDT",
    snapshot: {
      size: new BigNumber("0.020").toFixed(),
    },
  });
  await expect(nextEvent(iterator, 30)).rejects.toThrow(
    "Timed out waiting for event",
  );
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    riskLeverage: initialRiskLeverage,
  });

  await iterator.return?.();
});

test("Binance ACCOUNT_CONFIG_UPDATE updates existing position leverage", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          riskPollIntervalMs: 10_000,
          privateReconcileIntervalMs: 0,
        },
      },
    },
  });
  const iterator = client.account.events
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
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;
  expect(await nextEvent(iterator)).toMatchObject({
    type: "account.snapshot_replaced",
  });

  expect(
    client.account.getPosition({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    size: new BigNumber("0.010").toFixed(),
    leverage: "5",
  });

  socket.emitJson({
    e: "ACCOUNT_CONFIG_UPDATE",
    E: 1710000000500,
    T: 1710000000499,
    fs: "UM",
    ac: {
      s: "BTCUSDT",
      l: 25,
    },
  });

  const leverageEvent = await nextAccountEventOfType(
    iterator,
    "position.updated",
  );
  expect(leverageEvent).toMatchObject({
    symbol: "BTC/USDT:USDT",
    snapshot: {
      size: new BigNumber("0.010").toFixed(),
      entryPrice: new BigNumber("100000.10").toFixed(),
      leverage: "25",
      exchangeTs: 1710000000499,
    },
  });
  expect(
    client.account.getPosition({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    size: new BigNumber("0.010").toFixed(),
    leverage: "25",
  });
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    riskLeverage: new BigNumber("1010.002").dividedBy("1400.75").toFixed(),
  });

  await iterator.return?.();
});

test("Binance PAPI riskLevelChange publishes account event and backfills risk snapshot", async () => {
  installBinancePrivateAccountInfra();
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 500,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          riskPollIntervalMs: 10_000,
          privateReconcileIntervalMs: 0,
          privateStreamStaleAfterMs: 250,
        },
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
    options: {
      timestamp: 1710000000000,
    },
  });

  await client.start();
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;

  const initialRisk = client.account.getRiskSnapshot("main-binance");
  if (!initialRisk) {
    throw new Error("Expected bootstrap risk snapshot");
  }
  expect(initialRisk).toMatchObject({
    riskLevel: "normal",
    netEquity: new BigNumber("1300.50").toFixed(),
    riskEquity: new BigNumber("1400.75").toFixed(),
    maintenanceMargin: new BigNumber("45.20").toFixed(),
  });
  const iterator = client.account.events
    .updates({
      accountId: "main-binance",
      venue: "binance",
    })
    [Symbol.asyncIterator]();

  const staleRiskLevelChange = {
    e: "riskLevelChange",
    E: 1710000000000,
    u: "9.0000",
    s: "REDUCE_ONLY",
    eq: "9.0000",
    ae: "9.0000",
    m: "9.0000",
  };
  expect(staleRiskLevelChange.e).toBe("riskLevelChange");
  expect(staleRiskLevelChange.e).not.toBe("MARGIN_CALL");

  await Bun.sleep(150);
  const beforeRiskFrame = Date.now();
  expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  socket.emitJson(staleRiskLevelChange);

  expect(
    await nextAccountEventOfType(iterator, "account.risk_level_change", 200),
  ).toMatchObject({
    type: "account.risk_level_change",
    riskLevel: "reduce_only",
    riskRatio: new BigNumber("9.0000").toFixed(),
    netEquity: new BigNumber("9.0000").toFixed(),
    riskEquity: new BigNumber("9.0000").toFixed(),
    maintenanceMargin: new BigNumber("9.0000").toFixed(),
    exchangeTs: 1710000000000,
  });
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    riskLevel: "normal",
    netEquity: initialRisk.netEquity,
    riskEquity: initialRisk.riskEquity,
    maintenanceMargin: initialRisk.maintenanceMargin,
    exchangeTs: initialRisk.exchangeTs,
  });

  const riskLevelChange = {
    e: "riskLevelChange",
    E: 1710000000500,
    u: "1.9999999900",
    s: "MARGIN_CALL",
    eq: "30.2341672800",
    ae: "28.1000",
    m: "15.1170837100",
  };
  expect(riskLevelChange.e).toBe("riskLevelChange");
  expect(riskLevelChange.e).not.toBe("MARGIN_CALL");

  socket.emitJson(riskLevelChange);
  const riskLevelEvent = await nextAccountEventOfType(
    iterator,
    "account.risk_level_change",
    200,
  );
  expect(riskLevelEvent).toMatchObject({
    type: "account.risk_level_change",
    riskLevel: "margin_call",
    riskRatio: new BigNumber("1.9999999900").toFixed(),
    netEquity: new BigNumber("30.2341672800").toFixed(),
    riskEquity: new BigNumber("28.1000").toFixed(),
    riskLeverage: new BigNumber("0.010")
      .multipliedBy("101000.20")
      .dividedBy("28.1000")
      .toFixed(),
    maintenanceMargin: new BigNumber("15.1170837100").toFixed(),
    exchangeTs: 1710000000500,
  });
  const riskUpdatedEvent = await nextAccountEventOfType(
    iterator,
    "risk.updated",
    200,
  );
  expect(riskUpdatedEvent).toMatchObject({
    type: "risk.updated",
    snapshot: {
      riskLevel: "margin_call",
      riskRatio: new BigNumber("1.9999999900").toFixed(),
      netEquity: new BigNumber("30.2341672800").toFixed(),
      riskEquity: new BigNumber("28.1000").toFixed(),
      riskLeverage: new BigNumber("0.010")
        .multipliedBy("101000.20")
        .dividedBy("28.1000")
        .toFixed(),
      maintenanceMargin: new BigNumber("15.1170837100").toFixed(),
      exchangeTs: 1710000000500,
    },
  });
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    riskLevel: "margin_call",
    riskRatio: new BigNumber("1.9999999900").toFixed(),
    netEquity: new BigNumber("30.2341672800").toFixed(),
    riskEquity: new BigNumber("28.1000").toFixed(),
    riskLeverage: new BigNumber("0.010")
      .multipliedBy("101000.20")
      .dividedBy("28.1000")
      .toFixed(),
    maintenanceMargin: new BigNumber("15.1170837100").toFixed(),
    receivedAt: riskLevelEvent.receivedAt,
  });

  await Bun.sleep(120);
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    activity: "active",
    runtimeStatus: "healthy",
    lastReceivedAt: riskLevelEvent.receivedAt,
  });
  expect(
    client.account.getAccountStatus("main-binance")?.lastReceivedAt,
  ).toBeGreaterThanOrEqual(beforeRiskFrame);

  await client.account.unsubscribeAccount({
    accountId: "main-binance",
  });
  await iterator.return?.();
});

test("Binance private stream rebuilds listenKey after listenKeyExpired", async () => {
  const rotatedListenKey = "rotated-listen-key";
  const requests = installBinancePrivateAccountInfra({
    listenKeys: [PAPI_LISTEN_KEY, rotatedListenKey],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 200,
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
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);

  socket.emitJson({
    e: "listenKeyExpired",
    E: 1710000001000,
  });

  const rotatedSocket = await waitForSocket(
    papiAccountWsUrl(rotatedListenKey),
    0,
    300,
  );
  await waitForCondition(
    () =>
      client.account.getAccountStatus("main-binance")?.runtimeStatus ===
      "healthy"
        ? true
        : undefined,
    300,
    "Binance private stream did not recover after listenKeyExpired",
  );

  expect(rotatedSocket.readyState).toBe(FakeWebSocket.OPEN);
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  expect(
    requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.pathname === "/papi/v1/listenKey",
    ),
  ).toHaveLength(2);
  expect(
    requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url.pathname === "/papi/v1/listenKey" &&
        request.url.searchParams.get("listenKey") === PAPI_LISTEN_KEY,
    ),
  ).toBe(true);
});

test("Binance private stream rebuilds listenKey after keepalive failure", async () => {
  const rotatedListenKey = "keepalive-rotated-listen-key";
  const requests = installBinancePrivateAccountInfra({
    listenKeys: [PAPI_LISTEN_KEY, rotatedListenKey],
    failListenKeyKeepAliveCount: 1_000,
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 500,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          listenKeyKeepAliveMs: 5,
        },
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
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });
  await waitForSocket(PAPI_ACCOUNT_WS_URL);

  const rotatedSocket = await waitForSocket(
    papiAccountWsUrl(rotatedListenKey),
    0,
    1_000,
  );

  expect(rotatedSocket.readyState).toBe(FakeWebSocket.OPEN);
  expect(
    requests.filter(
      (request) =>
        request.method === "PUT" &&
        request.url.pathname === "/papi/v1/listenKey",
    ).length,
  ).toBe(1);
  expect(
    requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.pathname === "/papi/v1/listenKey",
    ),
  ).toHaveLength(2);
});

test("Binance private stream watchdog marks heartbeat timeout and rebuilds listenKey", async () => {
  const rotatedListenKey = "watchdog-rotated-listen-key";
  installBinancePrivateAccountInfra({
    listenKeys: [PAPI_LISTEN_KEY, rotatedListenKey],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 500,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          privateStreamStaleAfterMs: 50,
        },
      },
    },
  });
  const statusIterator = client.account.events
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
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });
  await waitForSocket(PAPI_ACCOUNT_WS_URL);

  expect(await nextEvent(statusIterator)).toMatchObject({
    status: {
      runtimeStatus: "bootstrap_pending",
      ready: false,
    },
  });
  expect(await nextEvent(statusIterator)).toMatchObject({
    status: {
      runtimeStatus: "healthy",
      ready: true,
    },
  });
  expect(await nextEvent(statusIterator, 500)).toMatchObject({
    status: {
      runtimeStatus: "reconnecting",
      ready: true,
      reason: "heartbeat_timeout",
    },
  });

  const rotatedSocket = await waitForSocket(
    papiAccountWsUrl(rotatedListenKey),
    0,
    500,
  );
  expect(rotatedSocket.readyState).toBe(FakeWebSocket.OPEN);

  await statusIterator.return?.();
});

test("client clock drives Binance signed request timestamps", async () => {
  const requests = installBinancePrivateAccountInfra();
  const clock: TimeProvider = {
    now: () => 1710000001234,
  };
  const client = createClient({
    clock,
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });

  await client.registerAccount({
    accountId: "clock-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });

  await client.start();
  await client.account.subscribeAccount({
    accountId: "clock-binance",
  });

  const signedRequests = signedBootstrapRequests(requests);
  expect(signedRequests).toHaveLength(3);
  for (const request of signedRequests) {
    expect(request.url.searchParams.get("timestamp")).toBe("1710000001234");
    expect(request.url.searchParams.get("recvWindow")).toBe("5000");
  }
});

test("account timestamp option takes precedence over client clock", async () => {
  const requests = installBinancePrivateAccountInfra();
  const client = createClient({
    clock: {
      now: () => 1710000002222,
    },
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
    },
  });

  await client.registerAccount({
    accountId: "timestamp-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
    options: {
      timestamp: 1710000003333,
      recvWindow: 6000,
    },
  });

  await client.start();
  await client.account.subscribeAccount({
    accountId: "timestamp-binance",
  });

  const signedRequests = signedBootstrapRequests(requests);
  expect(signedRequests).toHaveLength(3);
  for (const request of signedRequests) {
    expect(request.url.searchParams.get("timestamp")).toBe("1710000003333");
    expect(request.url.searchParams.get("recvWindow")).toBe("6000");
  }
});

test("default Binance signing clock uses local Date.now", async () => {
  await withFixedDateNow(1710000004444, async () => {
    const requests = installBinancePrivateAccountInfra();
    const client = createClient({
      account: {
        streamOpenTimeoutMs: 50,
        streamReconnectDelayMs: 5,
        streamReconnectMaxDelayMs: 5,
      },
    });

    await client.registerAccount({
      accountId: "default-clock-binance",
      venue: "binance",
      credentials: {
        apiKey: "key",
        secret: "secret",
      },
    });

    await client.start();
    await client.account.subscribeAccount({
      accountId: "default-clock-binance",
    });

    const signedRequests = signedBootstrapRequests(requests);
    expect(signedRequests).toHaveLength(3);
    for (const request of signedRequests) {
      expect(request.url.searchParams.get("timestamp")).toBe("1710000004444");
    }
  });
});

test("Binance signing clock does not affect local receivedAt freshness time", async () => {
  await withFixedDateNow(1710000005555, async () => {
    const requests = installBinancePrivateAccountInfra();
    const client = createClient({
      clock: {
        now: () => 42,
      },
      account: {
        streamOpenTimeoutMs: 50,
        streamReconnectDelayMs: 5,
        streamReconnectMaxDelayMs: 5,
      },
    });

    await client.registerAccount({
      accountId: "freshness-binance",
      venue: "binance",
      credentials: {
        apiKey: "key",
        secret: "secret",
      },
    });

    await client.start();
    await client.account.subscribeAccount({
      accountId: "freshness-binance",
    });

    for (const request of signedBootstrapRequests(requests)) {
      expect(request.url.searchParams.get("timestamp")).toBe("42");
    }
    expect(
      client.account.getAccountSnapshot("freshness-binance")?.receivedAt,
    ).toBe(1710000005555);
    expect(
      client.account.getBalance("freshness-binance", "USDT")?.receivedAt,
    ).toBe(1710000005555);
  });
});

test("Binance account polling refreshes risk and mark-to-market positions", async () => {
  installBinancePrivateAccountInfra({
    accountResponses: [
      {
        accountEquity: "1400.75",
        actualEquity: "1300.50",
        accountInitialMargin: "120.10",
        accountMaintMargin: "45.20",
        uniMMR: "31.0",
        updateTime: 1710000000100,
      },
      {
        accountEquity: "1600.00",
        actualEquity: "1500.00",
        accountInitialMargin: "150.00",
        accountMaintMargin: "60.00",
        uniMMR: "20.0",
        updateTime: 1710000001100,
      },
    ],
    umPositionResponses: [
      [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.010",
          entryPrice: "100000.10",
          markPrice: "101000.20",
          unRealizedProfit: "10.50",
          liquidationPrice: "80000.00",
          leverage: "5",
          notional: "1010.002",
          positionSide: "BOTH",
          updateTime: 1710000000200,
        },
      ],
      [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.010",
          entryPrice: "100000.10",
          markPrice: "120000.00",
          unRealizedProfit: "200.00",
          liquidationPrice: "85000.00",
          leverage: "5",
          notional: "1200.00",
          positionSide: "BOTH",
          updateTime: 1710000001200,
        },
      ],
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          riskPollIntervalMs: 5,
        },
      },
    },
  });
  const iterator = client.account.events
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
    },
  });

  await client.start();
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;
  expect(await nextEvent(iterator)).toMatchObject({
    type: "account.snapshot_replaced",
  });

  const firstPollEvent = await nextEvent(iterator, 200);
  expect(firstPollEvent).toMatchObject({
    type: "position.updated",
    symbol: "BTC/USDT:USDT",
    snapshot: {
      markPrice: new BigNumber("120000.00").toFixed(),
      unrealizedPnl: new BigNumber("200.00").toFixed(),
      liquidationPrice: new BigNumber("85000.00").toFixed(),
    },
  });
  const secondPollEvent = await nextEvent(iterator, 200);
  expect(secondPollEvent).toMatchObject({
    type: "risk.updated",
    snapshot: {
      netEquity: new BigNumber("1500.00").toFixed(),
      riskEquity: new BigNumber("1600.00").toFixed(),
      riskRatio: new BigNumber(1).dividedBy("20.0").toFixed(),
      riskLeverage: new BigNumber("1200.00").dividedBy("1600.00").toFixed(),
      initialMargin: new BigNumber("150.00").toFixed(),
      maintenanceMargin: new BigNumber("60.00").toFixed(),
    },
  });

  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    netEquity: new BigNumber("1500.00").toFixed(),
    riskEquity: new BigNumber("1600.00").toFixed(),
    riskLeverage: new BigNumber("0.75").toFixed(),
  });
  expect(
    client.account.getPosition({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    markPrice: new BigNumber("120000.00").toFixed(),
    liquidationPrice: new BigNumber("85000.00").toFixed(),
  });

  await client.account.unsubscribeAccount({
    accountId: "main-binance",
  });
  await iterator.return?.();
});

test("Binance account polling does not mask websocket disconnect status", async () => {
  installBinancePrivateAccountInfra({
    accountResponses: [
      {
        accountEquity: "1400.75",
        actualEquity: "1300.50",
        accountInitialMargin: "120.10",
        accountMaintMargin: "45.20",
        uniMMR: "31.0",
        updateTime: 1710000000100,
      },
      {
        accountEquity: "1600.00",
        actualEquity: "1500.00",
        accountInitialMargin: "150.00",
        accountMaintMargin: "60.00",
        uniMMR: "20.0",
        updateTime: 1710000001100,
      },
    ],
    umPositionResponses: [
      [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.010",
          entryPrice: "100000.10",
          markPrice: "101000.20",
          unRealizedProfit: "10.50",
          liquidationPrice: "80000.00",
          leverage: "5",
          notional: "1010.002",
          positionSide: "BOTH",
          updateTime: 1710000000200,
        },
      ],
      [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.010",
          entryPrice: "100000.10",
          markPrice: "120000.00",
          unRealizedProfit: "200.00",
          liquidationPrice: "85000.00",
          leverage: "5",
          notional: "1200.00",
          positionSide: "BOTH",
          updateTime: 1710000001200,
        },
      ],
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 50,
      streamReconnectMaxDelayMs: 50,
      venues: {
        binance: {
          riskPollIntervalMs: 5,
        },
      },
    },
  });
  const iterator = client.account.events
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
    },
  });

  await client.start();
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;
  expect(await nextEvent(iterator)).toMatchObject({
    type: "account.snapshot_replaced",
  });

  socket.disconnect();
  await Bun.sleep(0);
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    ready: true,
    runtimeStatus: "reconnecting",
    reason: "ws_disconnected",
  });

  expect(await nextEvent(iterator, 200)).toMatchObject({
    type: "position.updated",
  });
  expect(await nextEvent(iterator, 200)).toMatchObject({
    type: "risk.updated",
    snapshot: {
      netEquity: new BigNumber("1500.00").toFixed(),
      riskEquity: new BigNumber("1600.00").toFixed(),
    },
  });
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    netEquity: new BigNumber("1500.00").toFixed(),
    riskEquity: new BigNumber("1600.00").toFixed(),
  });
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    ready: true,
    runtimeStatus: "reconnecting",
    reason: "ws_disconnected",
  });

  await client.account.unsubscribeAccount({
    accountId: "main-binance",
  });
  await iterator.return?.();
});

test("Binance full private reconcile removes stale balances and positions", async () => {
  installBinancePrivateAccountInfra({
    balanceResponses: [
      [
        {
          asset: "USDT",
          totalWalletBalance: "1250.50",
          crossMarginFree: "1000.25",
          crossMarginLocked: "250.25",
        },
        {
          asset: "BTC",
          totalWalletBalance: "0.0500",
          crossMarginFree: "0.0400",
        },
      ],
      [
        {
          asset: "USDT",
          totalWalletBalance: "1250.50",
          crossMarginFree: "1250.50",
          crossMarginLocked: "0",
        },
        {
          asset: "BTC",
          totalWalletBalance: "0",
          crossMarginFree: "0",
          crossMarginLocked: "0",
        },
      ],
    ],
    accountResponses: [
      {
        accountEquity: "1400.75",
        actualEquity: "1300.50",
        accountInitialMargin: "120.10",
        accountMaintMargin: "45.20",
        uniMMR: "31.0",
        updateTime: 1710000000100,
      },
      {
        accountEquity: "1400.75",
        actualEquity: "1300.50",
        accountInitialMargin: "120.10",
        accountMaintMargin: "45.20",
        uniMMR: "31.0",
        updateTime: 1710000002100,
      },
    ],
    umPositionResponses: [
      [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.010",
          entryPrice: "100000.10",
          markPrice: "101000.20",
          unRealizedProfit: "10.50",
          liquidationPrice: "80000.00",
          leverage: "5",
          notional: "1010.002",
          positionSide: "BOTH",
          updateTime: 1710000000200,
        },
        {
          symbol: "ETHUSDT",
          positionAmt: "1.000",
          entryPrice: "3000.00",
          markPrice: "3100.00",
          unRealizedProfit: "100.00",
          liquidationPrice: "2000.00",
          leverage: "3",
          notional: "3100.00",
          positionSide: "BOTH",
          updateTime: 1710000000200,
        },
      ],
      [
        {
          symbol: "BTCUSDT",
          positionAmt: "0",
          entryPrice: "100000.10",
          markPrice: "101000.20",
          unRealizedProfit: "0",
          liquidationPrice: "0",
          leverage: "5",
          notional: "0",
          positionSide: "BOTH",
          updateTime: 1710000002200,
        },
      ],
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      venues: {
        binance: {
          riskPollIntervalMs: 60_000,
          privateReconcileIntervalMs: 5,
        },
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
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });

  expect(client.account.getBalance("main-binance", "BTC")).toBeDefined();
  expect(client.account.getPositions("main-binance")).toHaveLength(2);

  await waitForCondition(
    () =>
      client.account.getBalance("main-binance", "BTC") === undefined &&
      client.account.getPositions("main-binance").length === 0
        ? true
        : undefined,
    200,
    "full private reconcile did not remove stale account records",
  );
  expect(client.account.getRiskSnapshot("main-binance")).toMatchObject({
    riskLeverage: "0",
  });

  expect(client.account.getBalances("main-binance")).toEqual([
    expect.objectContaining({
      asset: "USDT",
      free: new BigNumber("1250.50").toFixed(),
    }),
  ]);
});

test("successful account reconcile clears previous HTTP degraded status", async () => {
  installBinancePrivateAccountInfra({
    balanceResponses: [
      [
        {
          asset: "USDT",
          totalWalletBalance: "1250.50",
          crossMarginFree: "1000.25",
          crossMarginLocked: "250.25",
        },
      ],
      [
        {
          asset: "USDT",
          totalWalletBalance: "1250.50",
          crossMarginFree: "1250.50",
          crossMarginLocked: "0",
        },
      ],
    ],
    accountResponses: [
      {
        accountEquity: "1400.75",
        actualEquity: "1300.50",
        accountInitialMargin: "120.10",
        accountMaintMargin: "45.20",
        uniMMR: "31.0",
        updateTime: 1710000000100,
      },
      {
        accountEquity: "1500.00",
        actualEquity: "1400.00",
        accountInitialMargin: "120.10",
        accountMaintMargin: "45.20",
        uniMMR: "31.0",
        updateTime: 1710000002100,
      },
    ],
    umPositionResponses: [
      [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.010",
          entryPrice: "100000.10",
          markPrice: "101000.20",
          unRealizedProfit: "10.50",
          liquidationPrice: "80000.00",
          leverage: "5",
          notional: "1010.002",
          positionSide: "BOTH",
          updateTime: 1710000000200,
        },
      ],
      [],
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      venues: {
        binance: {
          privateReconcileIntervalMs: 5,
        },
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
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });
  client.account.getAccountStatus("main-binance");
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  socket.dispatchEvent(new ErrorEvent("error", { error: new Error("boom") }));
  await Bun.sleep(0);

  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    runtimeStatus: "degraded",
    reason: "http_failed",
  });

  await waitForCondition(
    () =>
      client.account.getAccountStatus("main-binance")?.runtimeStatus ===
      "healthy"
        ? true
        : undefined,
    300,
    "successful account reconcile did not clear degraded status",
  );
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    runtimeStatus: "healthy",
    reason: undefined,
  });
});

test("account reconnect reconcile does not overwrite newer websocket updates", async () => {
  installBinancePrivateAccountInfra({
    balanceDelayMs: 30,
    accountDelayMs: 30,
    umPositionDelayMs: 30,
    balanceResponses: [
      [
        {
          asset: "USDT",
          totalWalletBalance: "1250.50",
          crossMarginFree: "1000.25",
          crossMarginLocked: "250.25",
        },
      ],
      [
        {
          asset: "USDT",
          totalWalletBalance: "1250.50",
          crossMarginFree: "1000.25",
          crossMarginLocked: "250.25",
        },
      ],
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      streamReconnectDelayMs: 5,
      streamReconnectMaxDelayMs: 5,
      venues: {
        binance: {
          privateReconcileIntervalMs: 0,
          riskPollIntervalMs: 60_000,
        },
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
  const subscribePromise = client.account.subscribeAccount({
    accountId: "main-binance",
  });
  const socket = await waitForSocket(PAPI_ACCOUNT_WS_URL);
  await subscribePromise;
  expect(client.account.getBalance("main-binance", "USDT")).toMatchObject({
    total: new BigNumber("1250.50").toFixed(),
  });

  socket.disconnect();
  const reconnectSocket = await waitForSocket(PAPI_ACCOUNT_WS_URL, 1, 100);
  const updateTs = Date.now();
  reconnectSocket.emitJson({
    e: "ACCOUNT_UPDATE",
    E: updateTs,
    T: updateTs,
    a: {
      B: [
        {
          a: "USDT",
          wb: "1300.50",
          cw: "1050.25",
        },
      ],
      P: [],
    },
  });

  await waitForCondition(
    () =>
      client.account.getBalance("main-binance", "USDT")?.total === "1300.5"
        ? true
        : undefined,
    200,
    "websocket account update was not applied during reconnect",
  );
  await Bun.sleep(80);
  expect(client.account.getBalance("main-binance", "USDT")).toMatchObject({
    total: new BigNumber("1300.50").toFixed(),
    free: new BigNumber("1050.25").toFixed(),
  });
});

test("Binance private reconcile can be disabled without disabling risk polling", async () => {
  const requests = installBinancePrivateAccountInfra({
    accountResponses: [
      {
        accountEquity: "1400.75",
        actualEquity: "1300.50",
        accountInitialMargin: "120.10",
        accountMaintMargin: "45.20",
        uniMMR: "31.0",
        updateTime: 1710000000100,
      },
      {
        accountEquity: "1600.00",
        actualEquity: "1500.00",
        accountInitialMargin: "150.00",
        accountMaintMargin: "60.00",
        uniMMR: "20.0",
        updateTime: 1710000001100,
      },
    ],
  });
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 50,
      venues: {
        binance: {
          riskPollIntervalMs: 5,
          privateReconcileIntervalMs: 0,
        },
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
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });

  await waitForCondition(
    () =>
      client.account.getRiskSnapshot("main-binance")?.netEquity === "1500"
        ? true
        : undefined,
    200,
    "risk polling did not continue after disabling private reconcile",
  );

  expect(
    requests.filter((request) => request.url.pathname === "/papi/v1/balance"),
  ).toHaveLength(1);
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
    venue: "binance",
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
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  });
  await client.start();

  const failure = await client.account
    .subscribeAccount({
      accountId: "main-binance",
    })
    .catch((error) => error);
  expect(failure).toBeInstanceOf(AcexError);
  if (!(failure instanceof AcexError)) {
    throw new Error("Expected AcexError");
  }
  expect(failure).toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
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
  expect(failure.cause).toBeInstanceOf(Error);
  expect(failure.message).toContain("Binance rejected: Invalid API-key");
  expect(failure.message).not.toContain("signature");
  expect(failure.message).not.toContain("timestamp=");
  expect(failure.message).not.toContain("recvWindow=");
  expect(failure.message).not.toContain("apiKey=key");
  expect(failure.message).not.toContain("X-MBX-APIKEY");
  expect(failure.message).not.toContain("secret");

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
    venue: "binance",
  });
  expect(error.error.message).not.toContain("signature");
  expect(error.error.message).not.toContain("timestamp=");
  expect(error.error.message).not.toContain("recvWindow=");
  expect(error.error.message).not.toContain("apiKey=key");
  expect(error.error.message).not.toContain("X-MBX-APIKEY");
  expect(error.error.message).not.toContain("secret");

  await errors.return?.();
});

test("Binance account bootstrap rate limit maps to rate_limited status without changing public code", async () => {
  installBinancePrivateAccountInfra({ rateLimitBootstrap: true });
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

  const failure = await client.account
    .subscribeAccount({
      accountId: "main-binance",
    })
    .catch((error) => error);

  expect(failure).toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    ready: false,
    runtimeStatus: "degraded",
    reason: "rate_limited",
  });
});

test("Binance account bootstrap ban maps to rate_limited status without changing public code", async () => {
  installBinancePrivateAccountInfra({ banBootstrap: true });
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

  const failure = await client.account
    .subscribeAccount({
      accountId: "main-binance",
    })
    .catch((error) => error);

  expect(failure).toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });
  expect(client.account.getAccountStatus("main-binance")).toMatchObject({
    ready: false,
    runtimeStatus: "degraded",
    reason: "rate_limited",
  });
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
    venue: "binance",
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

  const snapshot = client.account.getAccountSnapshot("main-binance");
  const usdt = client.account.getBalance("main-binance", "USDT");
  const position = client.account.getPosition({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  const risk = client.account.getRiskSnapshot("main-binance");

  expect(snapshot).toBeDefined();
  expect(usdt).toBeDefined();
  expect(position).toBeDefined();
  expect(risk).toBeDefined();
  if (!snapshot || !usdt || !position || !risk) {
    throw new Error("Expected account getter snapshots");
  }

  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.balances)).toBe(true);
  expect(Object.isFrozen(snapshot.positions)).toBe(true);
  expect(Object.isFrozen(usdt)).toBe(true);
  expect(Object.isFrozen(client.account.getBalances("main-binance")[0])).toBe(
    true,
  );
  expect(Object.isFrozen(position)).toBe(true);
  expect(Object.isFrozen(client.account.getPositions("main-binance")[0])).toBe(
    true,
  );
  expect(Object.isFrozen(risk)).toBe(true);

  const originalFree = usdt.free;
  try {
    usdt.free = "999999";
  } catch {}
  expect(client.account.getBalance("main-binance", "USDT")?.free).toBe(
    originalFree,
  );

  try {
    snapshot.balances.MUTATED = usdt;
  } catch {}
  expect(client.account.getBalance("main-binance", "MUTATED")).toBeUndefined();

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

test("account subscribe bootstraps Juplend lending balances and account risk", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  const requests = installJuplendInfra();
  const client = createClient({
    account: {
      venues: {
        juplend: {
          pollIntervalMs: 60_000,
          jupApiKey: "test-key",
        },
      },
    },
  });
  const iterator = client.account.events
    .updates({
      accountId: JUPLEND_ACCOUNT_ID,
      venue: "juplend",
    })
    [Symbol.asyncIterator]();

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
    options: {
      walletAddress: JUPLEND_WALLET,
    },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID });

  expect(await nextEvent(iterator)).toMatchObject({
    type: "account.snapshot_replaced",
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
  });

  expect(client.account.getBalance(JUPLEND_ACCOUNT_ID, "SOL")).toMatchObject({
    venue: "juplend",
    asset: "SOL",
    total: new BigNumber("15").toFixed(),
    lending: {
      supplied: new BigNumber("15").toFixed(),
      borrowed: new BigNumber("0").toFixed(),
      netAsset: new BigNumber("15").toFixed(),
      supplyAPY: new BigNumber("0.0554").toFixed(),
    },
  });
  expect(client.account.getBalance(JUPLEND_ACCOUNT_ID, "USDC")).toMatchObject({
    asset: "USDC",
    total: new BigNumber("-300").toFixed(),
    lending: {
      supplied: new BigNumber("0").toFixed(),
      borrowed: new BigNumber("300").toFixed(),
      netAsset: new BigNumber("-300").toFixed(),
      borrowAPY: new BigNumber("0.0513").toFixed(),
    },
  });
  const juplendRisk = client.account.getRiskSnapshot(JUPLEND_ACCOUNT_ID);
  expect(juplendRisk).toMatchObject({
    riskRatio: new BigNumber("300").dividedBy("1275").toFixed(),
    netEquity: new BigNumber("1200").toFixed(),
    riskEquity: new BigNumber("975").toFixed(),
    lending: {
      ltv: new BigNumber("0.2").toFixed(),
      liquidationThreshold: new BigNumber("0.85").toFixed(),
      totalCollateralUSD: new BigNumber("1500").toFixed(),
      totalDebtUSD: new BigNumber("300").toFixed(),
    },
  });
  expect(juplendRisk?.lending?.healthFactor).toBe(
    new BigNumber(1).dividedBy(juplendRisk?.riskRatio ?? 0).toFixed(),
  );
  expect(client.account.getAccountStatus(JUPLEND_ACCOUNT_ID)).toMatchObject({
    activity: "active",
    ready: true,
    runtimeStatus: "healthy",
  });
  expect(
    requests.filter((request) => request.url.hostname === "api.jup.ag"),
  ).toHaveLength(2);
  expect(
    requests.filter(
      (request) =>
        request.url.hostname === "lite-api.jup.ag" &&
        request.url.pathname === "/lend/v1/borrow/vaults",
    ),
  ).toHaveLength(1);
  expect(requests.state.rpcUrls).toHaveLength(1);

  await iterator.return?.();
});

test("Juplend account subscribe does not require credentials", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  installJuplendInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
    options: {
      walletAddress: JUPLEND_WALLET,
    },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID });

  expect(client.account.getAccountStatus(JUPLEND_ACCOUNT_ID)).toMatchObject({
    ready: true,
    runtimeStatus: "healthy",
  });
});

test("Juplend account subscribe can filter one lending position", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  installJuplendInfra();
  const client = createClient();
  const accountId = `${JUPLEND_ACCOUNT_ID}-position-101`;

  await client.registerAccount({
    accountId,
    venue: "juplend",
    options: {
      walletAddress: JUPLEND_WALLET,
      positionId: "101",
    },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId });

  expect(client.account.getBalance(accountId, "SOL")).toMatchObject({
    total: new BigNumber("10").toFixed(),
    lending: {
      supplied: new BigNumber("10").toFixed(),
      borrowed: new BigNumber("0").toFixed(),
    },
  });
  expect(client.account.getBalance(accountId, "USDC")).toMatchObject({
    total: new BigNumber("-250").toFixed(),
    lending: {
      supplied: new BigNumber("0").toFixed(),
      borrowed: new BigNumber("250").toFixed(),
    },
  });
  expect(client.account.getRiskSnapshot(accountId)).toMatchObject({
    riskRatio: new BigNumber("250").dividedBy("850").toFixed(),
    netEquity: new BigNumber("750").toFixed(),
    riskEquity: new BigNumber("600").toFixed(),
    lending: {
      ltv: new BigNumber("0.25").toFixed(),
      liquidationThreshold: new BigNumber("0.85").toFixed(),
      totalCollateralUSD: new BigNumber("1000").toFixed(),
      totalDebtUSD: new BigNumber("250").toFixed(),
    },
  });
});

test("Juplend account subscribe can direct-read one position by vaultId and positionId", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID } = await import(
    "../support/exchanges/juplend.ts"
  );
  const requests = installJuplendInfra();
  const client = createClient();
  const accountId = `${JUPLEND_ACCOUNT_ID}-direct-101`;

  await client.registerAccount({
    accountId,
    venue: "juplend",
    options: {
      vaultId: "1",
      positionId: "101",
    },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId });

  expect(client.account.getBalance(accountId, "SOL")).toMatchObject({
    total: new BigNumber("10").toFixed(),
  });
  expect(client.account.getBalance(accountId, "USDC")).toMatchObject({
    total: new BigNumber("-250").toFixed(),
  });
  expect(requests.state.maxActivePositionRequests).toBe(0);
  expect(requests.state.directPositionRequests).toEqual([
    {
      vaultId: 1,
      nftId: 101,
    },
  ]);
});

test("Juplend account subscribe maps lend-read amounts on fixed 1e9 scale", async () => {
  const { installJuplendInfra } = await import(
    "../support/exchanges/juplend.ts"
  );
  const client = createClient();
  const accountId = "juplend-jlp-jupusd";

  installJuplendInfra({
    positions: [
      {
        nftId: 201,
        supply: "5660693627000000",
        borrow: "16271447562893326",
        dustBorrow: "844674",
        vault: {
          constantViews: {
            vaultId: 58,
            supplyToken: "JLP1111111111111111111111111111111111111111",
            borrowToken: "JupUSD1111111111111111111111111111111111111",
          },
          configs: {
            liquidationThreshold: "850",
          },
          exchangePricesAndRates: {
            supplyRateVault: "0",
            borrowRateVault: "447",
          },
        },
      },
    ],
    vaults: [
      {
        id: "58",
        supplyToken: {
          address: "JLP1111111111111111111111111111111111111111",
          symbol: "JLP",
          uiSymbol: "JLP",
          decimals: 6,
          price: "1",
        },
        borrowToken: {
          address: "JupUSD1111111111111111111111111111111111111",
          symbol: "JupUSD",
          uiSymbol: "JupUSD",
          decimals: 6,
          price: "1",
        },
        liquidationThreshold: "850",
        supplyRate: "0",
        borrowRate: "447",
      },
    ],
  });

  await client.registerAccount({
    accountId,
    venue: "juplend",
    options: {
      vaultId: "58",
      positionId: "201",
    },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId });

  expect(client.account.getBalance(accountId, "JLP")).toMatchObject({
    total: new BigNumber("5660693.627").toFixed(),
    lending: {
      supplied: new BigNumber("5660693.627").toFixed(),
      borrowed: new BigNumber("0").toFixed(),
      netAsset: new BigNumber("5660693.627").toFixed(),
      supplyAPY: new BigNumber("0").toFixed(),
    },
  });
  expect(client.account.getBalance(accountId, "JupUSD")).toMatchObject({
    total: new BigNumber("-16271447.562893326").toFixed(),
    lending: {
      supplied: new BigNumber("0").toFixed(),
      borrowed: new BigNumber("16271447.562893326").toFixed(),
      netAsset: new BigNumber("-16271447.562893326").toFixed(),
      borrowAPY: new BigNumber("0.0447").toFixed(),
    },
  });
});

test("Juplend account subscribe maps HTTP failures to degraded status", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  installJuplendInfra({ failPositions: true });
  const client = createClient();

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
    options: {
      walletAddress: JUPLEND_WALLET,
    },
  });
  await client.start();

  await expect(
    client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID }),
  ).rejects.toBeInstanceOf(AcexError);
  expect(client.account.getAccountStatus(JUPLEND_ACCOUNT_ID)).toMatchObject({
    runtimeStatus: "degraded",
    ready: false,
    reason: "http_failed",
  });
});

test("Juplend account subscribe requires walletAddress or vaultId+positionId", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID } = await import(
    "../support/exchanges/juplend.ts"
  );
  installJuplendInfra();
  const client = createClient();

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
  } as RegisterAccountInput);
  await client.start();

  await expect(
    client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID }),
  ).rejects.toBeInstanceOf(AcexError);
  expect(client.account.getAccountStatus(JUPLEND_ACCOUNT_ID)).toMatchObject({
    runtimeStatus: "degraded",
    ready: false,
    reason: "http_failed",
  });
});

test("Juplend polling replaces snapshots when positions disappear", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  const requests = installJuplendInfra();
  const client = createClient({
    account: {
      venues: {
        juplend: {
          pollIntervalMs: 5,
        },
      },
    },
  });

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
    options: { walletAddress: JUPLEND_WALLET },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID });

  expect(client.account.getBalances(JUPLEND_ACCOUNT_ID)).toHaveLength(2);
  expect(client.account.getRiskSnapshot(JUPLEND_ACCOUNT_ID)).toBeDefined();

  requests.state.positions = [];

  await waitForCondition(
    () =>
      client.account.getBalances(JUPLEND_ACCOUNT_ID).length === 0 &&
      client.account.getRiskSnapshot(JUPLEND_ACCOUNT_ID) === undefined
        ? true
        : undefined,
    500,
    "Juplend polling did not clear stale snapshot",
  );
});

test("Juplend polling does not overlap slow position reads", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  const requests = installJuplendInfra({ positionsDelayMs: 30 });
  const client = createClient({
    account: {
      venues: {
        juplend: {
          pollIntervalMs: 5,
        },
      },
    },
  });

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
    options: { walletAddress: JUPLEND_WALLET },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID });
  await Bun.sleep(90);

  expect(requests.state.maxActivePositionRequests).toBe(1);
});

test("Juplend account subscribe forwards explicit rpcUrl to lend-read", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  const requests = installJuplendInfra();
  const client = createClient({
    account: {
      venues: {
        juplend: {
          rpcUrl: "https://rpc.example",
        },
      },
    },
  });

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
    options: { walletAddress: JUPLEND_WALLET },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID });

  expect(requests.state.rpcUrls).toEqual(["https://rpc.example"]);
});

test("Juplend account subscribe defaults rpcUrl from SOL_HELIUS_RPC", async () => {
  const previousRpcUrl = process.env.SOL_HELIUS_RPC;
  process.env.SOL_HELIUS_RPC = "https://env-rpc.example";

  try {
    const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
      await import("../support/exchanges/juplend.ts");
    const requests = installJuplendInfra();
    const client = createClient();

    await client.registerAccount({
      accountId: JUPLEND_ACCOUNT_ID,
      venue: "juplend",
      options: { walletAddress: JUPLEND_WALLET },
    });
    await client.start();
    await client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID });

    expect(requests.state.rpcUrls).toEqual(["https://env-rpc.example"]);
  } finally {
    if (previousRpcUrl === undefined) {
      delete process.env.SOL_HELIUS_RPC;
    } else {
      process.env.SOL_HELIUS_RPC = previousRpcUrl;
    }
  }
});

test("Juplend account subscribe falls back to lite vault metadata when Jup API fails", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  const requests = installJuplendInfra({
    failTokenSearch: true,
    failPrices: true,
    vaults: [
      {
        id: "1",
        supplyToken: {
          address: "So11111111111111111111111111111111111111112",
          symbol: "WSOL",
          uiSymbol: "SOL",
          decimals: 9,
          oraclePrice: "100",
        },
        borrowToken: {
          address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          symbol: "USDC",
          uiSymbol: "USDC",
          decimals: 6,
          oraclePrice: "1",
        },
        liquidationThreshold: "850",
        supplyRate: "554",
        borrowRate: "513",
      },
    ],
  });
  const client = createClient({
    account: {
      venues: {
        juplend: {
          jupApiKey: "test-key",
        },
      },
    },
  });

  await client.registerAccount({
    accountId: JUPLEND_ACCOUNT_ID,
    venue: "juplend",
    options: { walletAddress: JUPLEND_WALLET },
  });
  await client.start();
  await client.account.subscribeAccount({ accountId: JUPLEND_ACCOUNT_ID });

  expect(client.account.getBalance(JUPLEND_ACCOUNT_ID, "SOL")).toMatchObject({
    total: new BigNumber("15").toFixed(),
  });
  expect(client.account.getBalance(JUPLEND_ACCOUNT_ID, "USDC")).toMatchObject({
    total: new BigNumber("-300").toFixed(),
  });
  expect(client.account.getRiskSnapshot(JUPLEND_ACCOUNT_ID)).toMatchObject({
    riskRatio: new BigNumber("300").dividedBy("1275").toFixed(),
    netEquity: new BigNumber("1200").toFixed(),
    riskEquity: new BigNumber("975").toFixed(),
    lending: {
      ltv: new BigNumber("0.2").toFixed(),
      liquidationThreshold: new BigNumber("0.85").toFixed(),
      totalCollateralUSD: new BigNumber("1500").toFixed(),
      totalDebtUSD: new BigNumber("300").toFixed(),
    },
  });
  expect(
    requests.filter((request) => request.url.hostname === "api.jup.ag"),
  ).toHaveLength(5);
  expect(
    requests.filter(
      (request) =>
        request.url.hostname === "lite-api.jup.ag" &&
        request.url.pathname === "/lend/v1/borrow/vaults",
    ),
  ).toHaveLength(1);
});

test("Juplend retries Jup enrichment after an earlier degraded fallback", async () => {
  const { installJuplendInfra, JUPLEND_ACCOUNT_ID, JUPLEND_WALLET } =
    await import("../support/exchanges/juplend.ts");
  const degradedRequests = installJuplendInfra({
    failTokenSearch: true,
    failPrices: true,
    vaults: [
      {
        id: "1",
        supplyToken: {
          address: "So11111111111111111111111111111111111111112",
          symbol: "WSOL",
          decimals: 9,
          oraclePrice: "100",
        },
        borrowToken: {
          address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          symbol: "USDC",
          decimals: 6,
          oraclePrice: "1",
        },
        liquidationThreshold: "850",
        supplyRate: "554",
        borrowRate: "513",
      },
    ],
  });
  const firstClient = createClient({
    account: {
      venues: {
        juplend: {
          jupApiKey: "key-a",
        },
      },
    },
  });

  await firstClient.registerAccount({
    accountId: `${JUPLEND_ACCOUNT_ID}-degraded`,
    venue: "juplend",
    options: { walletAddress: JUPLEND_WALLET },
  });
  await firstClient.start();
  await firstClient.account.subscribeAccount({
    accountId: `${JUPLEND_ACCOUNT_ID}-degraded`,
  });

  expect(
    degradedRequests.filter((request) => request.url.hostname === "api.jup.ag"),
  ).toHaveLength(5);

  degradedRequests.state.failTokenSearch = false;
  degradedRequests.state.failPrices = false;

  const secondClient = createClient({
    account: {
      venues: {
        juplend: {
          jupApiKey: "key-a",
        },
      },
    },
  });

  await secondClient.registerAccount({
    accountId: `${JUPLEND_ACCOUNT_ID}-recovered`,
    venue: "juplend",
    options: { walletAddress: JUPLEND_WALLET },
  });
  await secondClient.start();
  await secondClient.account.subscribeAccount({
    accountId: `${JUPLEND_ACCOUNT_ID}-recovered`,
  });

  expect(
    degradedRequests.filter((request) => request.url.hostname === "api.jup.ag"),
  ).toHaveLength(7);
  expect(
    secondClient.account.getBalance(`${JUPLEND_ACCOUNT_ID}-recovered`, "SOL"),
  ).toMatchObject({
    asset: "SOL",
  });
});

test("listenKey rate-limit scope carries the per-account accountId", async () => {
  installBinancePrivateAccountInfra();
  const scopes: RateLimitScope[] = [];
  const captureLimiter: RateLimiter = {
    beforeRequest: ({ scope }) => {
      scopes.push(scope);
    },
    afterResponse: () => {},
    onTransportError: () => {},
    getSnapshot: () => undefined,
  };
  const client = createClient({
    rateLimiter: captureLimiter,
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
  await client.account.subscribeAccount({
    accountId: "main-binance",
  });

  const listenKeyScopes = scopes.filter((scope) =>
    scope.endpointKey.includes("/papi/v1/listenKey"),
  );
  expect(listenKeyScopes.length).toBeGreaterThan(0);
  for (const scope of listenKeyScopes) {
    expect(scope.accountId).toBe("main-binance");
  }
});
