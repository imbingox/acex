import { expect, test } from "bun:test";
import type {
  RawOrderUpdate,
  RawSymbolFeeRate,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { AcexError, type VenueErrorReason } from "../../src/errors.ts";
import { FeeManagerImpl } from "../../src/managers/fee-manager.ts";
import type {
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  GetSymbolFeeRateInput,
  HealthEvent,
  MarketDefinition,
  MetricType,
  StandardMarketDefinition,
  Venue,
  VenueOrderCapabilities,
} from "../../src/types/index.ts";

const SUPPORTED_ORDER_CAPABILITIES: VenueOrderCapabilities = {
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

function createMarketDefinition(
  symbol: string,
  type: StandardMarketDefinition["type"],
): MarketDefinition {
  return {
    venue: "binance",
    symbol,
    id: symbol.replace(/[/:-]/g, ""),
    type,
    base: "BTC",
    quote: "USDT",
    settle: type === "spot" ? undefined : "USDT",
    active: true,
    contract: type !== "spot",
    linear: type !== "spot" ? true : undefined,
    pricePrecision: 2,
    amountPrecision: 3,
    priceStep: "0.01",
    amountStep: "0.001",
    raw: {},
  };
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

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 250) {
    if (check()) {
      return;
    }
    await Bun.sleep(1);
  }

  throw new Error(message);
}

interface HeldTimer {
  canceled: boolean;
  timeout?: number;
  run: () => void;
}

function installHeldLongTimers(minDelayMs = 1_000): {
  timers: HeldTimer[];
  restore: () => void;
} {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: HeldTimer[] = [];
  const handles = new WeakMap<object, HeldTimer>();

  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const delay = Number(timeout ?? 0);
    if (delay < minDelayMs) {
      return (
        originalSetTimeout as (
          handler: Parameters<typeof setTimeout>[0],
          timeout: Parameters<typeof setTimeout>[1],
          ...args: unknown[]
        ) => ReturnType<typeof setTimeout>
      )(handler, timeout, ...args);
    }

    const handle = {};
    const timer: HeldTimer = {
      canceled: false,
      timeout: delay,
      run: () => {
        if (timer.canceled) {
          return;
        }

        timer.canceled = true;
        if (typeof handler === "function") {
          handler(...args);
        }
      },
    };
    timers.push(timer);
    handles.set(handle, timer);
    return handle as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((
    handle?: Parameters<typeof clearTimeout>[0],
  ): void => {
    if (handle && typeof handle === "object") {
      const timer = handles.get(handle);
      if (timer) {
        timer.canceled = true;
        return;
      }
    }

    originalClearTimeout(handle);
  }) as typeof clearTimeout;

  return {
    timers,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

class StubFeeContext implements ClientContext {
  readonly errors: AcexInternalError[] = [];
  readonly metricsEnabled = false;
  nowMs = 1710000000000;
  started = true;
  account: RegisteredAccountRecord = {
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  };
  readonly accounts = new Map<string, RegisteredAccountRecord>();
  readonly markets = new Map<string, MarketDefinition>();
  fetchSymbolFeeRateImpl: (
    input: GetSymbolFeeRateInput,
  ) => Promise<RawSymbolFeeRate> = async (input) => ({
    symbol: input.symbol,
    maker: "0.00020000",
    taker: "0.00050000",
    receivedAt: this.nowMs,
  });

  constructor() {
    this.accounts.set(this.account.accountId, this.account);
  }

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
    venue: Venue,
    symbol: string,
  ): MarketDefinition | undefined {
    return this.markets.get(`${venue}:${symbol}`);
  }

  getPrivateOrderCapabilities(
    _venue: Venue,
  ): VenueOrderCapabilities | undefined {
    return SUPPORTED_ORDER_CAPABILITIES;
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

  fetchSymbolFeeRate(input: GetSymbolFeeRateInput): Promise<RawSymbolFeeRate> {
    return this.fetchSymbolFeeRateImpl(input);
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

test("fee manager lazy get returns market-type default and subscribe is incremental", async () => {
  const context = new StubFeeContext();
  context.started = true;
  const manager = new FeeManagerImpl(context);

  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
    marketType: "swap",
    maker: "0.0002",
    taker: "0.0005",
    source: "default",
  });

  await manager.subscribe({
    accountId: "main-binance",
    symbols: ["ETH/USDT:USDT", "BTC/USDT:USDT", "ETH/USDT:USDT"],
  });

  expect(
    manager.getSymbolFeeRates("main-binance").map((rate) => rate.symbol),
  ).toEqual(["BTC/USDT:USDT", "ETH/USDT:USDT"]);
});

test("fee manager isolates records when account and symbol contain separators", async () => {
  const context = new StubFeeContext();
  context.accounts.clear();
  context.accounts.set("a", {
    accountId: "a",
    venue: "binance",
    credentials: {
      apiKey: "key-a",
      secret: "secret-a",
    },
  });
  context.accounts.set("a:b", {
    accountId: "a:b",
    venue: "binance",
    credentials: {
      apiKey: "key-ab",
      secret: "secret-ab",
    },
  });
  const manager = new FeeManagerImpl(context);

  expect(
    manager.getSymbolFeeRate({
      accountId: "a",
      symbol: "b:BTC",
    }),
  ).toMatchObject({
    accountId: "a",
    symbol: "b:BTC",
  });
  expect(
    manager.getSymbolFeeRate({
      accountId: "a:b",
      symbol: "BTC",
    }),
  ).toMatchObject({
    accountId: "a:b",
    symbol: "BTC",
  });

  await manager.unsubscribe({
    accountId: "a",
  });

  expect(manager.getSymbolFeeRates().map((rate) => rate.accountId)).toEqual([
    "a:b",
  ]);

  manager.getSymbolFeeRate({
    accountId: "a",
    symbol: "b:BTC",
  });
  manager.onAccountRemoved("a", context.now());

  expect(manager.getSymbolFeeRates().map((rate) => rate.accountId)).toEqual([
    "a:b",
  ]);
});

test("fee manager applies configured default rates as canonical decimals", () => {
  const context = new StubFeeContext();
  const manager = new FeeManagerImpl(context, {
    defaultRates: {
      binance: {
        swap: { maker: "0.00030000", taker: "0.00070000" },
      },
    },
  });

  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    maker: "0.0003",
    taker: "0.0007",
    source: "default",
  });
});

test("fee manager fetch writes venue rate into cache and credentials update downgrades it", async () => {
  const context = new StubFeeContext();
  const manager = new FeeManagerImpl(context);
  manager.onClientStarted();

  const fetched = await manager.fetchSymbolFeeRate({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });

  expect(fetched).toMatchObject({
    maker: "0.0002",
    taker: "0.0005",
    source: "venue",
  });
  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    maker: "0.0002",
    taker: "0.0005",
    source: "venue",
  });

  context.nowMs += 1;
  manager.onCredentialsUpdated("main-binance", "binance");

  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    maker: "0.0002",
    taker: "0.0005",
    source: "default",
    receivedAt: context.nowMs,
  });

  manager.onClientStopping(context.now());
});

test("fee manager invalidates venue rate when market type changes", async () => {
  const context = new StubFeeContext();
  const manager = new FeeManagerImpl(context);
  manager.onClientStarted();

  await manager.fetchSymbolFeeRate({
    accountId: "main-binance",
    symbol: "ETH/BTC",
  });

  context.markets.set(
    "binance:ETH/BTC",
    createMarketDefinition("ETH/BTC", "spot"),
  );
  context.nowMs += 1;

  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "ETH/BTC",
    }),
  ).toMatchObject({
    marketType: "spot",
    maker: "0.001",
    taker: "0.001",
    source: "default",
    receivedAt: context.nowMs,
  });

  manager.onClientStopping(context.now());
});

test("fee manager keeps spot on defaults and rejects explicit remote fetch", async () => {
  const context = new StubFeeContext();
  context.markets.set(
    "binance:ETH/BTC",
    createMarketDefinition("ETH/BTC", "spot"),
  );
  const manager = new FeeManagerImpl(context);

  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "ETH/BTC",
    }),
  ).toMatchObject({
    marketType: "spot",
    maker: "0.001",
    taker: "0.001",
    source: "default",
  });

  await expect(
    manager.fetchSymbolFeeRate({
      accountId: "main-binance",
      symbol: "ETH/BTC",
    }),
  ).rejects.toMatchObject({
    code: "VENUE_NOT_SUPPORTED",
  });
});

test("fee manager fetch returns in-flight result but does not write cache after unsubscribe", async () => {
  const context = new StubFeeContext();
  const pending = deferred<RawSymbolFeeRate>();
  context.fetchSymbolFeeRateImpl = () => pending.promise;
  const manager = new FeeManagerImpl(context);
  manager.onClientStarted();

  const fetchPromise = manager.fetchSymbolFeeRate({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  await manager.unsubscribe({
    accountId: "main-binance",
    symbols: ["BTC/USDT:USDT"],
  });
  pending.resolve({
    symbol: "BTC/USDT:USDT",
    maker: "0.00020000",
    taker: "0.00050000",
    receivedAt: context.now(),
  });

  await expect(fetchPromise).resolves.toMatchObject({
    source: "venue",
  });
  expect(manager.getSymbolFeeRates("main-binance")).toEqual([]);
  manager.onClientStopping(context.now());
});

test("fee manager background failure keeps default and emits fee runtime error", async () => {
  const context = new StubFeeContext();
  context.fetchSymbolFeeRateImpl = async () => {
    throw new Error("commission rate failed");
  };
  const manager = new FeeManagerImpl(context, {
    refreshIntervalMs: 60_000,
  });

  await manager.subscribe({
    accountId: "main-binance",
    symbols: ["BTC/USDT:USDT"],
  });
  manager.onClientStarted();

  await waitFor(
    () =>
      context.errors.some(
        (event) =>
          event.source === "fee" &&
          event.error instanceof AcexError &&
          event.error.code === "FEE_RATE_FETCH_FAILED",
      ),
    "fee runtime error was not emitted",
  );
  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    source: "default",
  });
  manager.onClientStopping(context.now());
});

test("fee manager ignores stale in-flight background failure after credentials update", async () => {
  const context = new StubFeeContext();
  const firstRequest = deferred<RawSymbolFeeRate>();
  const calls: string[] = [];
  context.fetchSymbolFeeRateImpl = (input) => {
    calls.push(input.symbol);
    if (calls.length === 1) {
      return firstRequest.promise;
    }

    return Promise.resolve({
      symbol: input.symbol,
      maker: "0.00020000",
      taker: "0.00050000",
      receivedAt: context.now(),
    });
  };
  const manager = new FeeManagerImpl(context, {
    refreshIntervalMs: 60_000,
  });

  await manager.subscribe({
    accountId: "main-binance",
    symbols: ["BTC/USDT:USDT"],
  });
  manager.onClientStarted();

  await waitFor(
    () => calls.length === 1,
    "first background fee refresh did not start",
  );
  manager.onCredentialsUpdated("main-binance", "binance");
  context.nowMs += 3_000;
  firstRequest.reject(new Error("stale credentials request failed"));

  await waitFor(
    () => calls.length === 2,
    "replacement background fee refresh did not start",
  );
  expect(context.errors).toEqual([]);
  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    }),
  ).toMatchObject({
    source: "venue",
  });
  manager.onClientStopping(context.now());
});

test("fee manager refreshes fallback market type before background request", async () => {
  const context = new StubFeeContext();
  let fetchCalls = 0;
  context.fetchSymbolFeeRateImpl = async (input) => {
    fetchCalls += 1;
    return {
      symbol: input.symbol,
      maker: "0.00020000",
      taker: "0.00050000",
      receivedAt: context.now(),
    };
  };
  const manager = new FeeManagerImpl(context, {
    refreshIntervalMs: 60_000,
  });

  await manager.subscribe({
    accountId: "main-binance",
    symbols: ["ETH/BTC"],
  });
  context.markets.set(
    "binance:ETH/BTC",
    createMarketDefinition("ETH/BTC", "spot"),
  );
  manager.onClientStarted();

  await Bun.sleep(5);

  expect(fetchCalls).toBe(0);
  expect(context.errors).toEqual([]);
  expect(
    manager.getSymbolFeeRate({
      accountId: "main-binance",
      symbol: "ETH/BTC",
    }),
  ).toMatchObject({
    marketType: "spot",
    source: "default",
  });
  manager.onClientStopping(context.now());
});

test("fee manager background worker refreshes serially through one venue gate", async () => {
  const context = new StubFeeContext();
  const calls: Array<{
    symbol: string;
    startedAt: number;
    deferred: ReturnType<typeof deferred<RawSymbolFeeRate>>;
  }> = [];
  context.fetchSymbolFeeRateImpl = (input) => {
    const pending = deferred<RawSymbolFeeRate>();
    calls.push({
      symbol: input.symbol,
      startedAt: context.now(),
      deferred: pending,
    });
    return pending.promise;
  };
  const manager = new FeeManagerImpl(context, {
    refreshIntervalMs: 60_000,
  });

  await manager.subscribe({
    accountId: "main-binance",
    symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  });
  manager.onClientStarted();

  await waitFor(() => calls.length === 1, "first fee refresh did not start");
  await Bun.sleep(20);
  expect(calls).toHaveLength(1);

  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error("first fee refresh call missing");
  }
  context.nowMs = firstCall.startedAt + 3_000;
  firstCall.deferred.resolve({
    symbol: firstCall.symbol,
    maker: "0.00020000",
    taker: "0.00050000",
    receivedAt: context.now(),
  });

  await waitFor(() => calls.length === 2, "second fee refresh did not start");
  const secondCall = calls[1];
  if (!secondCall) {
    throw new Error("second fee refresh call missing");
  }
  expect(secondCall.startedAt - firstCall.startedAt).toBeGreaterThanOrEqual(
    3_000,
  );

  secondCall.deferred.resolve({
    symbol: secondCall.symbol,
    maker: "0.00020000",
    taker: "0.00050000",
    receivedAt: context.now(),
  });
  manager.onClientStopping(context.now());
});

test("fee manager prioritizes explicit fetch over scheduled background refresh", async () => {
  const heldTimers = installHeldLongTimers();
  try {
    const context = new StubFeeContext();
    const calls: string[] = [];
    context.fetchSymbolFeeRateImpl = async (input) => {
      calls.push(input.symbol);
      return {
        symbol: input.symbol,
        maker: "0.00020000",
        taker: "0.00050000",
        receivedAt: context.now(),
      };
    };
    const manager = new FeeManagerImpl(context, {
      refreshIntervalMs: 60_000,
    });

    await manager.subscribe({
      accountId: "main-binance",
      symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
    });
    manager.onClientStarted();

    await waitFor(
      () => calls.length === 1,
      "first background fee refresh did not start",
    );
    await waitFor(
      () => heldTimers.timers.some((timer) => !timer.canceled),
      "second background fee refresh was not scheduled",
    );
    const scheduledBackground = heldTimers.timers.find(
      (timer) => !timer.canceled,
    );
    if (!scheduledBackground) {
      throw new Error("scheduled background fee refresh missing");
    }

    context.nowMs += 3_000;
    const fetchPromise = manager.fetchSymbolFeeRate({
      accountId: "main-binance",
      symbol: "LTC/USDT:USDT",
    });

    await waitFor(() => calls.length === 2, "explicit fee fetch did not start");
    expect(calls).toEqual(["BTC/USDT:USDT", "LTC/USDT:USDT"]);
    expect(scheduledBackground.canceled).toBe(true);
    await expect(fetchPromise).resolves.toMatchObject({
      symbol: "LTC/USDT:USDT",
      source: "venue",
    });

    manager.onClientStopping(context.now());
  } finally {
    heldTimers.restore();
  }
});

test("fee manager skips same-symbol background refresh after explicit fetch updates cache", async () => {
  const heldTimers = installHeldLongTimers();
  try {
    const context = new StubFeeContext();
    const calls: string[] = [];
    context.fetchSymbolFeeRateImpl = async (input) => {
      calls.push(input.symbol);
      return {
        symbol: input.symbol,
        maker: "0.00020000",
        taker: "0.00050000",
        receivedAt: context.now(),
      };
    };
    const manager = new FeeManagerImpl(context, {
      refreshIntervalMs: 60_000,
    });

    await manager.subscribe({
      accountId: "main-binance",
      symbols: ["ETH/USDT:USDT", "BTC/USDT:USDT"],
    });
    manager.onClientStarted();

    await waitFor(
      () => calls.length === 1,
      "first background fee refresh did not start",
    );
    await waitFor(
      () => heldTimers.timers.some((timer) => !timer.canceled),
      "second background fee refresh was not scheduled",
    );

    context.nowMs += 3_000;
    const fetchPromise = manager.fetchSymbolFeeRate({
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
    });

    await waitFor(
      () => calls.length === 2,
      "explicit same-symbol fee fetch did not start",
    );
    await expect(fetchPromise).resolves.toMatchObject({
      symbol: "BTC/USDT:USDT",
      source: "venue",
    });

    context.nowMs += 3_000;
    for (const timer of [...heldTimers.timers]) {
      timer.run();
    }
    await Bun.sleep(0);

    expect(calls).toEqual(["ETH/USDT:USDT", "BTC/USDT:USDT"]);
    expect(context.errors).toEqual([]);
    manager.onClientStopping(context.now());
  } finally {
    heldTimers.restore();
  }
});

test("fee manager skips stale scheduled background refresh after unsubscribe", async () => {
  const heldTimers = installHeldLongTimers();
  try {
    const context = new StubFeeContext();
    const calls: string[] = [];
    context.fetchSymbolFeeRateImpl = async (input) => {
      calls.push(input.symbol);
      return {
        symbol: input.symbol,
        maker: "0.00020000",
        taker: "0.00050000",
        receivedAt: context.now(),
      };
    };
    const manager = new FeeManagerImpl(context, {
      refreshIntervalMs: 60_000,
    });

    await manager.subscribe({
      accountId: "main-binance",
      symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
    });
    manager.onClientStarted();

    await waitFor(
      () => calls.length === 1,
      "first background fee refresh did not start",
    );
    await waitFor(
      () => heldTimers.timers.some((timer) => !timer.canceled),
      "second background fee refresh was not scheduled",
    );
    const scheduledBackground = heldTimers.timers.find(
      (timer) => !timer.canceled,
    );
    if (!scheduledBackground) {
      throw new Error("scheduled background fee refresh missing");
    }

    await manager.unsubscribe({
      accountId: "main-binance",
      symbols: ["ETH/USDT:USDT"],
    });
    context.nowMs += 3_000;
    scheduledBackground.run();
    await Bun.sleep(0);

    expect(calls).toEqual(["BTC/USDT:USDT"]);
    expect(context.errors).toEqual([]);
    manager.onClientStopping(context.now());
  } finally {
    heldTimers.restore();
  }
});

test("fee manager reports background missing credentials only as fee error", async () => {
  const context = new StubFeeContext();
  delete context.account.credentials;
  let fetchCalls = 0;
  context.fetchSymbolFeeRateImpl = async (input) => {
    fetchCalls += 1;
    return {
      symbol: input.symbol,
      maker: "0.00020000",
      taker: "0.00050000",
      receivedAt: context.now(),
    };
  };
  const manager = new FeeManagerImpl(context, {
    refreshIntervalMs: 60_000,
  });

  await manager.subscribe({
    accountId: "main-binance",
    symbols: ["BTC/USDT:USDT"],
  });
  manager.onClientStarted();

  await waitFor(
    () => context.errors.length === 1,
    "background credentials error was not emitted",
  );

  expect(fetchCalls).toBe(0);
  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "fee",
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
  });
  expect(context.errors[0]?.error).toMatchObject({
    code: "CREDENTIALS_MISSING",
  });
  manager.onClientStopping(context.now());
});

test("fee manager cancels scheduled background refresh on stop", async () => {
  const heldTimers = installHeldLongTimers();
  try {
    const context = new StubFeeContext();
    const calls: string[] = [];
    context.fetchSymbolFeeRateImpl = async (input) => {
      calls.push(input.symbol);
      return {
        symbol: input.symbol,
        maker: "0.00020000",
        taker: "0.00050000",
        receivedAt: context.now(),
      };
    };
    const manager = new FeeManagerImpl(context, {
      refreshIntervalMs: 60_000,
    });

    await manager.subscribe({
      accountId: "main-binance",
      symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
    });
    manager.onClientStarted();

    await waitFor(
      () => calls.length === 1,
      "first background fee refresh did not start",
    );
    await waitFor(
      () => heldTimers.timers.some((timer) => !timer.canceled),
      "second background fee refresh was not scheduled",
    );
    const scheduledBackground = heldTimers.timers.find(
      (timer) => !timer.canceled,
    );
    if (!scheduledBackground) {
      throw new Error("scheduled background fee refresh missing");
    }

    manager.onClientStopping(context.now());
    context.nowMs += 3_000;
    scheduledBackground.run();
    await Bun.sleep(0);

    expect(scheduledBackground.canceled).toBe(true);
    expect(calls).toEqual(["BTC/USDT:USDT"]);
    expect(context.errors).toEqual([]);
  } finally {
    heldTimers.restore();
  }
});
