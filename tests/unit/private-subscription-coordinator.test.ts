import { expect, test } from "bun:test";
import type {
  PrivateUserDataAdapter,
  RawAccountBootstrap,
  RawAccountUpdate,
  RawOrderUpdate,
  StreamHandle,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  PrivateAccountDataConsumer,
  PrivateOrderDataConsumer,
  PrivateSubscriptionState,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { PrivateSubscriptionCoordinator } from "../../src/client/private-subscription-coordinator.ts";
import { AcexError } from "../../src/errors.ts";
import { TransportError } from "../../src/internal/http-client.ts";
import type {
  AccountCredentials,
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  HealthEvent,
  Venue,
  VenueAccountCapabilities,
  VenueOrderCapabilities,
} from "../../src/types/index.ts";

class StubContext implements ClientContext {
  account: RegisteredAccountRecord | undefined = {
    accountId: "main-binance",
    venue: "binance",
    credentials: {
      apiKey: "key",
      secret: "secret",
    },
  };
  errors: AcexInternalError[] = [];

  now(): number {
    return Date.now();
  }

  assertStarted(): void {}

  getRegisteredAccount(accountId: string): RegisteredAccountRecord {
    if (!this.account || this.account.accountId !== accountId) {
      throw new AcexError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
      );
    }

    return this.account;
  }

  getPrivateOrderCapabilities(
    _venue: Venue,
  ): VenueOrderCapabilities | undefined {
    return undefined;
  }

  ensurePrivateCredentials(): void {}

  subscribePrivateAccountFeed(): Promise<void> {
    return Promise.resolve();
  }

  unsubscribePrivateAccountFeed(): void {}

  subscribePrivateOrderFeed(): Promise<void> {
    return Promise.resolve();
  }

  unsubscribePrivateOrderFeed(): void {}

  createOrder(_input: CreateOrderInput): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelOrder(_input: CancelOrderInput): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelAllOrders(_input: CancelAllOrdersInput): Promise<RawOrderUpdate[]> {
    throw new Error("not implemented");
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
}

class StubAccountConsumer implements PrivateAccountDataConsumer {
  updates: RawAccountUpdate[] = [];
  states: PrivateSubscriptionState[] = [];

  constructor(private readonly trace?: string[]) {}

  onPrivateAccountPending(_accountId: string, _venue: Venue): void {}

  onPrivateAccountBootstrap(
    _accountId: string,
    _venue: Venue,
    _bootstrap: RawAccountBootstrap,
  ): void {
    this.trace?.push("account-bootstrap");
  }

  onPrivateAccountUpdate(
    _accountId: string,
    _venue: Venue,
    update: RawAccountUpdate,
  ): void {
    this.trace?.push("account-update");
    this.updates.push(update);
  }

  onPrivateAccountStreamState(
    _accountId: string,
    _venue: Venue,
    state: PrivateSubscriptionState,
  ): void {
    this.states.push(state);
  }
}

class StubOrderConsumer implements PrivateOrderDataConsumer {
  onPrivateOrderPending(): void {}
  onPrivateOrderBootstrap(): void {}
  onPrivateOrderUpdate(): void {}
  onPrivateOrderStreamState(): void {}
}

class StubBinanceAdapter implements PrivateUserDataAdapter {
  readonly venue = "binance" as const;
  readonly readOnly = false;
  readonly notes: string[] = [];
  readonly accountCapabilities: VenueAccountCapabilities = {
    register: "supported",
    snapshot: "supported",
    updates: "websocket",
    balances: "supported",
    positions: "supported",
    risk: "supported",
    lending: "unsupported",
    credentialsRequired: true,
  };
  readonly orderCapabilities: VenueOrderCapabilities = {
    supported: true,
    openOrders: "supported",
    updates: "websocket",
    create: "supported",
    cancel: "supported",
    cancelAll: "symbol",
    orderTypes: ["limit", "market"],
    timeInForce: ["gtc"],
    postOnly: false,
    reduceOnly: false,
    positionSide: "optional",
    clientOrderId: true,
  };
  refreshCalls = 0;
  bootstrapCalls = 0;
  createStreamCalls = 0;
  closeCalls = 0;
  bootstrapAccountError: unknown;

  constructor(private readonly trace?: string[]) {}

  bootstrapAccount(): Promise<RawAccountBootstrap> {
    this.bootstrapCalls += 1;
    this.trace?.push("bootstrap");
    if (this.bootstrapAccountError) {
      return Promise.reject(this.bootstrapAccountError);
    }

    return Promise.resolve({
      balances: [],
      positions: [],
      receivedAt: Date.now(),
    });
  }

  refreshAccount(): Promise<RawAccountUpdate> {
    this.refreshCalls += 1;
    this.trace?.push("refresh");
    return Promise.resolve({
      risk: {
        riskEquity: "1",
        receivedAt: Date.now(),
      },
      receivedAt: Date.now(),
    });
  }

  bootstrapOpenOrders(): Promise<RawOrderUpdate[]> {
    return Promise.resolve([]);
  }

  createOrder(
    _credentials: AccountCredentials,
    _request: never,
  ): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelOrder(
    _credentials: AccountCredentials,
    _request: never,
  ): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelAllOrders(
    _credentials: AccountCredentials,
    _request: never,
  ): Promise<RawOrderUpdate[]> {
    throw new Error("not implemented");
  }

  createPrivateStream(): StreamHandle {
    this.createStreamCalls += 1;
    this.trace?.push("stream-create");
    return {
      ready: Promise.resolve().then(() => {
        this.trace?.push("stream-ready");
      }),
      close: () => {
        this.closeCalls += 1;
        this.trace?.push("stream-close");
      },
    };
  }
}

class StubNoRefreshBinanceAdapter extends StubBinanceAdapter {
  constructor(trace?: string[]) {
    super(trace);
    Object.defineProperty(this, "refreshAccount", {
      value: undefined,
      configurable: true,
    });
  }
}

class StubPollingBinanceAdapter extends StubNoRefreshBinanceAdapter {
  override readonly accountCapabilities: VenueAccountCapabilities = {
    register: "supported",
    snapshot: "supported",
    updates: "polling",
    balances: "supported",
    positions: "supported",
    risk: "supported",
    lending: "unsupported",
    credentialsRequired: true,
  };
}

class StubJuplendAdapter implements PrivateUserDataAdapter {
  readonly venue = "juplend" as const;
  readonly readOnly = true;
  readonly notes: string[] = [];
  readonly accountCapabilities: VenueAccountCapabilities = {
    register: "supported",
    snapshot: "supported",
    updates: "polling",
    balances: "supported",
    positions: "unsupported",
    risk: "supported",
    lending: "supported",
    credentialsRequired: false,
  };
  readonly orderCapabilities: VenueOrderCapabilities = {
    supported: false,
    openOrders: "unsupported",
    updates: "unsupported",
    create: "unsupported",
    cancel: "unsupported",
    cancelAll: "unsupported",
    orderTypes: [],
    timeInForce: [],
    postOnly: false,
    reduceOnly: false,
    positionSide: "unsupported",
    clientOrderId: false,
    reason: "read_only",
  };

  bootstrapCalls = 0;
  createStreamCalls = 0;
  closeCalls = 0;

  constructor(
    private readonly bootstrapAccountError?: unknown,
    private readonly trace?: string[],
  ) {}

  bootstrapAccount(): Promise<RawAccountBootstrap> {
    this.bootstrapCalls += 1;
    this.trace?.push("bootstrap");
    if (this.bootstrapAccountError) {
      return Promise.reject(this.bootstrapAccountError);
    }

    return Promise.resolve({
      balances: [],
      positions: [],
      receivedAt: Date.now(),
    });
  }

  bootstrapOpenOrders(): Promise<RawOrderUpdate[]> {
    return Promise.resolve([]);
  }

  createOrder(
    _credentials: AccountCredentials,
    _request: never,
  ): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelOrder(
    _credentials: AccountCredentials,
    _request: never,
  ): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelAllOrders(
    _credentials: AccountCredentials,
    _request: never,
  ): Promise<RawOrderUpdate[]> {
    throw new Error("not implemented");
  }

  createPrivateStream(): StreamHandle {
    this.createStreamCalls += 1;
    this.trace?.push("stream-create");
    return {
      ready: Promise.resolve().then(() => {
        this.trace?.push("stream-ready");
      }),
      close: () => {
        this.closeCalls += 1;
        this.trace?.push("stream-close");
      },
    };
  }
}

function withSetTimeoutCounter<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; scheduled: number }> {
  const originalSetTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduled += 1;
    return originalSetTimeout(...args);
  }) as typeof setTimeout;

  return fn()
    .then((result) => ({ result, scheduled }))
    .finally(() => {
      globalThis.setTimeout = originalSetTimeout;
    });
}

test("websocket-like account subscriptions start the stream before bootstrapping and schedule refresh polling", async () => {
  const trace: string[] = [];
  const context = new StubContext();
  const adapter = new StubBinanceAdapter(trace);
  const accountConsumer = new StubAccountConsumer(trace);
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    accountConsumer,
    new StubOrderConsumer(),
    {
      binance: {
        riskPollIntervalMs: 5,
      },
    },
  );

  const { scheduled } = await withSetTimeoutCounter(() =>
    coordinator.subscribeAccountFeed("main-binance"),
  );

  expect(trace).toContain("stream-ready");
  expect(trace).toContain("account-bootstrap");
  expect(trace.indexOf("stream-ready")).toBeLessThan(
    trace.indexOf("account-bootstrap"),
  );
  expect(scheduled).toBeGreaterThan(0);

  await Bun.sleep(20);
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(adapter.refreshCalls).toBeGreaterThan(0);
});

test("polling-like account subscriptions bootstrap before stream startup and do not schedule refresh polling", async () => {
  const trace: string[] = [];
  const context = new StubContext();
  const adapter = new StubPollingBinanceAdapter(trace);
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(trace),
    new StubOrderConsumer(),
    {
      binance: {
        riskPollIntervalMs: 5,
      },
    },
  );

  const { scheduled } = await withSetTimeoutCounter(() =>
    coordinator.subscribeAccountFeed("main-binance"),
  );

  expect(trace).toContain("bootstrap");
  expect(trace).toContain("stream-create");
  expect(trace.indexOf("bootstrap")).toBeLessThan(
    trace.indexOf("stream-create"),
  );
  expect(scheduled).toBe(0);
  expect(adapter.createStreamCalls).toBe(1);
});

test("websocket-like adapters without refreshAccount do not schedule refresh polling", async () => {
  const context = new StubContext();
  const adapter = new StubNoRefreshBinanceAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    {
      binance: {
        riskPollIntervalMs: 5,
      },
    },
  );

  const { scheduled } = await withSetTimeoutCounter(() =>
    coordinator.subscribeAccountFeed("main-binance"),
  );

  await Bun.sleep(20);
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(scheduled).toBe(0);
  expect(adapter.refreshCalls).toBe(0);
});

test("account subscribe failures close unused streams, leave no refresh polling, and allow resubscribe", async () => {
  const context = new StubContext();
  const adapter = new StubBinanceAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    {
      binance: {
        riskPollIntervalMs: 5,
      },
    },
  );

  adapter.bootstrapAccountError = new Error("bootstrap failed");
  await expect(
    coordinator.subscribeAccountFeed("main-binance"),
  ).rejects.toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });

  await Bun.sleep(20);

  expect(adapter.closeCalls).toBe(1);
  expect(adapter.refreshCalls).toBe(0);

  adapter.bootstrapAccountError = undefined;
  await coordinator.subscribeAccountFeed("main-binance");
  await Bun.sleep(20);
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(adapter.createStreamCalls).toBe(2);
  expect(adapter.bootstrapCalls).toBe(2);
  expect(adapter.refreshCalls).toBeGreaterThan(0);
});

test("resumeRecord preserves websocket-like stream-first account ordering", async () => {
  const trace: string[] = [];
  const context = new StubContext();
  const adapter = new StubBinanceAdapter(trace);
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(trace),
    new StubOrderConsumer(),
    {
      binance: {
        riskPollIntervalMs: 50,
      },
    },
  );

  await coordinator.subscribeAccountFeed("main-binance");
  trace.length = 0;

  coordinator.onCredentialsUpdated("main-binance");
  await Bun.sleep(5);
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(trace).toContain("stream-ready");
  expect(trace).toContain("account-bootstrap");
  expect(trace.indexOf("stream-ready")).toBeLessThan(
    trace.indexOf("account-bootstrap"),
  );
});

test("resumeRecord preserves polling-like bootstrap-first account ordering", async () => {
  const trace: string[] = [];
  const context = new StubContext();
  const adapter = new StubPollingBinanceAdapter(trace);
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(trace),
    new StubOrderConsumer(),
  );

  await coordinator.subscribeAccountFeed("main-binance");
  trace.length = 0;

  coordinator.onCredentialsUpdated("main-binance");
  await Bun.sleep(5);

  expect(trace).toContain("bootstrap");
  expect(trace).toContain("stream-create");
  expect(trace.indexOf("bootstrap")).toBeLessThan(
    trace.indexOf("stream-create"),
  );
});

test("Binance risk polling ignores missing accounts when a pending timer fires", async () => {
  const context = new StubContext();
  const adapter = new StubBinanceAdapter();
  const accountConsumer = new StubAccountConsumer();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    accountConsumer,
    new StubOrderConsumer(),
    {
      binance: {
        riskPollIntervalMs: 5,
      },
    },
  );

  await coordinator.subscribeAccountFeed("main-binance");
  context.account = undefined;

  await Bun.sleep(20);

  expect(adapter.refreshCalls).toBe(0);
  expect(accountConsumer.updates).toHaveLength(0);
  expect(context.errors).toHaveLength(0);
});

test("invalid Binance risk poll interval falls back to the default interval", async () => {
  const context = new StubContext();
  const adapter = new StubBinanceAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    {
      binance: {
        riskPollIntervalMs: 0,
      },
    },
  );

  await coordinator.subscribeAccountFeed("main-binance");
  await Bun.sleep(20);
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(adapter.refreshCalls).toBe(0);
});

test("account bootstrap failure reasons preserve auth, http, and rate-limit mapping", async () => {
  const binanceContext = new StubContext();
  const binanceAdapter = new StubBinanceAdapter();
  const binanceConsumer = new StubAccountConsumer();
  binanceAdapter.bootstrapAccountError = new Error("invalid credentials");
  const binanceCoordinator = new PrivateSubscriptionCoordinator(
    binanceContext,
    [binanceAdapter],
    binanceConsumer,
    new StubOrderConsumer(),
  );

  await expect(
    binanceCoordinator.subscribeAccountFeed("main-binance"),
  ).rejects.toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });
  expect(binanceConsumer.states.at(-1)).toMatchObject({
    runtimeStatus: "degraded",
    ready: false,
    reason: "auth_failed",
  });

  const juplendContext = new StubContext();
  juplendContext.account = {
    accountId: "jup-loop-a",
    venue: "juplend",
    options: {
      walletAddress: "wallet",
    },
  };
  const juplendConsumer = new StubAccountConsumer();
  const juplendCoordinator = new PrivateSubscriptionCoordinator(
    juplendContext,
    [new StubJuplendAdapter(new Error("positions unavailable"))],
    juplendConsumer,
    new StubOrderConsumer(),
  );

  await expect(
    juplendCoordinator.subscribeAccountFeed("jup-loop-a"),
  ).rejects.toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });
  expect(juplendConsumer.states.at(-1)).toMatchObject({
    runtimeStatus: "degraded",
    ready: false,
    reason: "http_failed",
  });

  const rateLimitedContext = new StubContext();
  const rateLimitedAdapter = new StubBinanceAdapter();
  const rateLimitedConsumer = new StubAccountConsumer();
  rateLimitedAdapter.bootstrapAccountError = new TransportError(
    "too many requests",
    {
      kind: "rate_limited",
      status: 429,
      statusText: "Too Many Requests",
      retryAfterMs: 2_000,
      attempts: 1,
      retryable: false,
      url: "https://papi.binance.com/papi/v1/account",
    },
  );
  const rateLimitedCoordinator = new PrivateSubscriptionCoordinator(
    rateLimitedContext,
    [rateLimitedAdapter],
    rateLimitedConsumer,
    new StubOrderConsumer(),
  );

  await expect(
    rateLimitedCoordinator.subscribeAccountFeed("main-binance"),
  ).rejects.toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });
  expect(rateLimitedConsumer.states.at(-1)).toMatchObject({
    runtimeStatus: "degraded",
    ready: false,
    reason: "rate_limited",
  });
});
