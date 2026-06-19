import { expect, test } from "bun:test";
import type {
  RawOrderUpdate,
  RawSymbolLeverageUpdate,
  RawSymbolRiskLimit,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { AcexError, type VenueErrorReason } from "../../src/errors.ts";
import { RiskLimitManagerImpl } from "../../src/managers/risk-limit-manager.ts";
import type {
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  FetchRiskLimitsInput,
  GetSymbolFeeRateInput,
  GetSymbolRiskLimitInput,
  HealthEvent,
  MarketDefinition,
  MetricType,
  SetSymbolLeverageInput,
  Venue,
  VenueOrderCapabilities,
} from "../../src/types/index.ts";

const ORDER_CAPABILITIES: VenueOrderCapabilities = {
  supported: true,
  openOrders: "supported",
  updates: "websocket",
  fees: "supported",
  create: "supported",
  cancel: "supported",
  cancelAll: "symbol",
  orderTypes: ["limit", "market"],
  timeInForce: ["gtc", "post_only"],
  postOnly: true,
  reduceOnly: true,
  positionSide: "required_for_hedge",
  clientOrderId: true,
};

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (check()) {
      return;
    }
    await Bun.sleep(1);
  }

  throw new Error(message);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

class StubRiskLimitContext implements ClientContext {
  readonly errors: AcexInternalError[] = [];
  readonly metricsEnabled = false;
  nowMs = 1710000000000;
  started = true;
  readonly accounts = new Map<string, RegisteredAccountRecord>([
    [
      "main-binance",
      {
        accountId: "main-binance",
        venue: "binance",
        credentials: {
          apiKey: "key",
          secret: "secret",
        },
      },
    ],
  ]);
  fetchSymbolRiskLimitCalls = 0;
  fetchRiskLimitsCalls = 0;
  setSymbolLeverageCalls = 0;
  fetchSymbolRiskLimitImpl: (
    input: GetSymbolRiskLimitInput,
  ) => Promise<RawSymbolRiskLimit> = async (input) => {
    this.fetchSymbolRiskLimitCalls += 1;
    return {
      symbol: input.symbol,
      notionalCoefficient: "1.5000",
      receivedAt: this.nowMs + 10,
      tiers: [
        {
          tier: 1,
          initialLeverage: "125.000",
          notionalFloor: "0.000",
          notionalCap: "50000.000",
          maintenanceMarginRatio: "0.004000",
          cumulativeMaintenanceAmount: "0.000",
        },
        {
          tier: 2,
          initialLeverage: "50.000",
          notionalFloor: "50000.000",
          notionalCap: "250000.000",
          maintenanceMarginRatio: "0.005000",
          cumulativeMaintenanceAmount: "50.000",
        },
      ],
    };
  };
  fetchRiskLimitsImpl: (
    input: FetchRiskLimitsInput,
  ) => Promise<RawSymbolRiskLimit[]> = async (input) => {
    this.fetchRiskLimitsCalls += 1;
    return [
      await this.fetchSymbolRiskLimitImpl({
        accountId: input.accountId,
        symbol: "BTC/USDT:USDT",
      }),
      {
        symbol: "ETH/USDT:USDT",
        receivedAt: this.nowMs + 20,
        tiers: [
          {
            tier: 1,
            initialLeverage: "100",
            notionalCap: "25000",
          },
        ],
      },
    ];
  };
  setSymbolLeverageImpl: (
    input: SetSymbolLeverageInput,
  ) => Promise<RawSymbolLeverageUpdate> = async (input) => {
    this.setSymbolLeverageCalls += 1;
    return {
      symbol: input.symbol,
      leverage: input.leverage,
      maxNotionalValue: "500000.0000",
      receivedAt: this.nowMs + 30,
    };
  };

  now(): number {
    return this.nowMs;
  }

  assertStarted(): void {
    if (!this.started) {
      throw new AcexError("CLIENT_NOT_STARTED", "Client not started");
    }
  }

  getRegisteredAccount(accountId: string): RegisteredAccountRecord {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new AcexError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
      );
    }

    return account;
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
    return ORDER_CAPABILITIES;
  }

  normalizeVenueErrorCode(
    _venue: Venue,
    code: string,
  ): VenueErrorReason | undefined {
    return code === "-2015" ? "unknown" : undefined;
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

  fetchSymbolFeeRate(_input: GetSymbolFeeRateInput): never {
    throw new Error("not implemented");
  }

  fetchSymbolRiskLimit(
    input: GetSymbolRiskLimitInput,
  ): Promise<RawSymbolRiskLimit> {
    return this.fetchSymbolRiskLimitImpl(input);
  }

  fetchRiskLimits(input: FetchRiskLimitsInput): Promise<RawSymbolRiskLimit[]> {
    return this.fetchRiskLimitsImpl(input);
  }

  setSymbolLeverage(
    input: SetSymbolLeverageInput,
  ): Promise<RawSymbolLeverageUpdate> {
    return this.setSymbolLeverageImpl(input);
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

  publishHealthEvent(_event: HealthEvent): void {}

  emitMetric(
    _name: string,
    _value: number,
    _type: MetricType,
    _tags?: Record<string, string>,
  ): void {}
}

test("risk limit cache get returns missing facet and explicit fetch writes canonical tier cache", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context);

  const missing = manager.getSymbolRiskLimit({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(missing).toMatchObject({
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    tiers: {
      source: "missing",
      stale: true,
      items: [],
    },
    leverage: {},
  });
  expect(context.fetchSymbolRiskLimitCalls).toBe(0);
  expect(context.fetchRiskLimitsCalls).toBe(0);

  manager.onClientStarted();
  const fetched = await manager.fetchSymbolRiskLimit({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(fetched).toMatchObject({
    tiers: {
      source: "venue",
      stale: false,
      receivedAt: 1710000000010,
      maxInitialLeverage: "125",
      notionalCoefficient: "1.5",
      items: [
        {
          tier: 1,
          initialLeverage: "125",
          notionalFloor: "0",
          notionalCap: "50000",
          maintenanceMarginRatio: "0.004",
          cumulativeMaintenanceAmount: "0",
        },
        {
          tier: 2,
          initialLeverage: "50",
          notionalFloor: "50000",
          notionalCap: "250000",
          maintenanceMarginRatio: "0.005",
          cumulativeMaintenanceAmount: "50",
        },
      ],
    },
  });
});

test("risk limit starts account-level full refresh and get reads the cache", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context);

  manager.onAccountRegistered("main-binance", "binance");
  manager.onClientStarted();
  await waitFor(
    () =>
      context.fetchRiskLimitsCalls === 1 &&
      context.fetchSymbolRiskLimitCalls === 1,
    "account-level risk limit refresh did not run",
  );

  expect(context.fetchRiskLimitsCalls).toBe(1);
  expect(context.fetchSymbolRiskLimitCalls).toBe(1);
  expect(
    manager.getSymbolRiskLimit({
      accountId: "main-binance",
      symbol: "ETH/USDT:USDT",
    }),
  ).toMatchObject({
    tiers: {
      source: "venue",
      stale: false,
      items: [
        {
          tier: 1,
          initialLeverage: "100",
          notionalCap: "25000",
        },
      ],
    },
  });

  manager.getSymbolRiskLimit({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(context.fetchRiskLimitsCalls).toBe(1);
  manager.onClientStopping(context.now());
});

test("risk limit uses manager-level refresh interval option", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context, {
    refreshIntervalMs: 5,
  });

  manager.onAccountRegistered("main-binance", "binance");
  manager.onClientStarted();
  await waitFor(
    () => context.fetchRiskLimitsCalls === 1,
    "initial account-level risk limit refresh did not run",
  );

  context.nowMs += 5;
  await waitFor(
    () => context.fetchRiskLimitsCalls === 2,
    "configured account-level risk limit refresh interval was not used",
  );

  manager.onClientStopping(context.now());
});

test("risk limit set leverage updates only leverage facet and preserves stale tier state", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context);
  manager.onClientStarted();

  await manager.fetchSymbolRiskLimit({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  context.nowMs += 10 * 60 * 1000;
  manager.onClientStopping(context.now());
  expect(
    manager.getSymbolRiskLimit({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }).tiers.stale,
  ).toBe(true);
  manager.onClientStarted();

  const update = await manager.setSymbolLeverage({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    leverage: "4",
  });
  expect(update).toMatchObject({
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    leverage: "4",
    maxNotionalValue: "500000",
  });

  const snapshot = manager.getSymbolRiskLimit({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(snapshot.tiers.stale).toBe(true);
  expect(snapshot.leverage.lastSet).toMatchObject({
    leverage: "4",
    maxNotionalValue: "500000",
  });
});

test("risk limit fetch all writes account-isolated symbol cache", async () => {
  const context = new StubRiskLimitContext();
  context.accounts.set("second-binance", {
    accountId: "second-binance",
    venue: "binance",
    credentials: {
      apiKey: "key-2",
      secret: "secret-2",
    },
  });
  const manager = new RiskLimitManagerImpl(context);
  manager.onClientStarted();

  await manager.fetchRiskLimits({ accountId: "main-binance" });
  manager.getSymbolRiskLimit({
    accountId: "second-binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(manager.getSymbolRiskLimits().map((entry) => entry.accountId)).toEqual(
    ["main-binance", "main-binance", "second-binance"],
  );

  manager.onAccountRemoved("main-binance", context.now());
  expect(manager.getSymbolRiskLimits().map((entry) => entry.accountId)).toEqual(
    ["second-binance"],
  );
});

test("risk limit full refresh marks omitted venue symbols missing", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context);
  manager.onClientStarted();

  await manager.fetchRiskLimits({ accountId: "main-binance" });
  context.fetchRiskLimitsImpl = async () => [
    {
      symbol: "BTC/USDT:USDT",
      receivedAt: context.nowMs + 40,
      tiers: [
        {
          tier: 1,
          initialLeverage: "75",
          notionalCap: "100000",
        },
      ],
    },
  ];

  const fetched = await manager.fetchRiskLimits({ accountId: "main-binance" });
  expect(fetched.map((snapshot) => snapshot.symbol)).toEqual(["BTC/USDT:USDT"]);
  expect(
    manager.getSymbolRiskLimit({
      accountId: "main-binance",
      symbol: "ETH/USDT:USDT",
    }).tiers,
  ).toMatchObject({
    source: "missing",
    stale: true,
    items: [],
  });
});

test("risk limit rejects invalid leverage locally without context call", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context);
  manager.onClientStarted();

  await expect(
    manager.setSymbolLeverage({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      leverage: "4.5",
    }),
  ).rejects.toMatchObject({
    code: "RISK_LIMIT_INPUT_INVALID",
  });
  expect(context.setSymbolLeverageCalls).toBe(0);
});

test("risk limit credentials update marks venue tiers missing and blocks stale in-flight full refresh writeback", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context);
  manager.onClientStarted();

  await manager.fetchRiskLimits({ accountId: "main-binance" });
  await manager.setSymbolLeverage({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    leverage: "4",
  });
  expect(
    manager.getSymbolRiskLimit({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }).leverage.lastSet,
  ).toMatchObject({
    leverage: "4",
  });
  context.fetchRiskLimitsImpl = async (input) => {
    manager.onCredentialsUpdated(input.accountId, "binance");
    return [
      {
        symbol: "BTC/USDT:USDT",
        receivedAt: context.nowMs + 100,
        tiers: [
          {
            tier: 1,
            initialLeverage: "99",
          },
        ],
      },
    ];
  };

  const fetched = await manager.fetchRiskLimits({ accountId: "main-binance" });
  expect(fetched).toEqual([]);
  expect(
    manager.getSymbolRiskLimit({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }).tiers,
  ).toMatchObject({
    source: "missing",
    stale: true,
    items: [],
  });
  expect(
    manager.getSymbolRiskLimit({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }).leverage,
  ).toEqual({});
});

test("risk limit credentials update starts a fresh explicit full refresh instead of reusing stale in-flight", async () => {
  const context = new StubRiskLimitContext();
  const manager = new RiskLimitManagerImpl(context);
  manager.onClientStarted();

  const staleRefresh = deferred<RawSymbolRiskLimit[]>();
  const requests: FetchRiskLimitsInput[] = [];
  context.fetchRiskLimitsImpl = (input) => {
    requests.push(input);
    if (requests.length === 1) {
      return staleRefresh.promise;
    }

    return Promise.resolve([
      {
        symbol: "BTC/USDT:USDT",
        receivedAt: context.nowMs + 200,
        tiers: [
          {
            tier: 1,
            initialLeverage: "75",
          },
        ],
      },
    ]);
  };

  const firstFetch = manager.fetchRiskLimits({ accountId: "main-binance" });
  await waitFor(
    () => requests.length === 1,
    "first full refresh did not start",
  );

  manager.onCredentialsUpdated("main-binance", "binance");
  const secondFetch = manager.fetchRiskLimits({ accountId: "main-binance" });
  await waitFor(
    () => requests.length === 2,
    "second full refresh reused stale in-flight request",
  );

  await expect(secondFetch).resolves.toMatchObject([
    {
      tiers: {
        source: "venue",
        stale: false,
        items: [
          {
            tier: 1,
            initialLeverage: "75",
          },
        ],
      },
    },
  ]);

  staleRefresh.resolve([
    {
      symbol: "BTC/USDT:USDT",
      receivedAt: context.nowMs + 100,
      tiers: [
        {
          tier: 1,
          initialLeverage: "99",
        },
      ],
    },
  ]);
  await expect(firstFetch).resolves.toMatchObject([
    {
      tiers: {
        source: "venue",
        stale: false,
        items: [
          {
            tier: 1,
            initialLeverage: "75",
          },
        ],
      },
    },
  ]);
  expect(
    manager.getSymbolRiskLimit({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }).tiers.items[0]?.initialLeverage,
  ).toBe("75");
});
