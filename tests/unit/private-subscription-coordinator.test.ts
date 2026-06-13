import { expect, test } from "bun:test";
import type {
  FetchOrderRequest,
  PrivateStreamCallbacks,
  PrivateStreamOptions,
  PrivateUserDataAdapter,
  RawAccountBootstrap,
  RawAccountUpdate,
  RawOpenOrdersSnapshot,
  RawOrderUpdate,
  StreamHandle,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  ExpiredPendingOrderClaim,
  PrivateAccountDataConsumer,
  PrivateOrderDataConsumer,
  PrivateSubscriptionState,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { PrivateSubscriptionCoordinator } from "../../src/client/private-subscription-coordinator.ts";
import { AcexError, type VenueErrorReason } from "../../src/errors.ts";
import { TransportError } from "../../src/internal/http-client.ts";
import type {
  AccountCredentials,
  AccountRuntimeOptions,
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  HealthEvent,
  OrderSnapshot,
  Venue,
  VenueAccountCapabilities,
  VenueOrderCapabilities,
} from "../../src/types/index.ts";

function binanceRuntimeOptions(
  binance: NonNullable<AccountRuntimeOptions["venues"]>["binance"],
): AccountRuntimeOptions {
  return { venues: { binance } };
}

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

  normalizeVenueErrorCode(
    _venue: Venue,
    _code: string,
  ): VenueErrorReason | undefined {
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
  pendingCalls = 0;
  updates: RawAccountUpdate[] = [];
  reconcilePreserveStatus: Array<boolean | undefined> = [];
  states: PrivateSubscriptionState[] = [];

  constructor(private readonly trace?: string[]) {}

  onPrivateAccountPending(_accountId: string, _venue: Venue): void {
    this.pendingCalls += 1;
  }

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

  onPrivateAccountReconcile(
    _accountId: string,
    _venue: Venue,
    bootstrap: RawAccountBootstrap,
    options: { preserveStatus?: boolean },
  ): void {
    this.trace?.push("account-reconcile");
    this.reconcilePreserveStatus.push(options.preserveStatus);
    this.updates.push({
      balances: bootstrap.balances,
      positions: bootstrap.positions,
      risk: bootstrap.risk,
      exchangeTs: bootstrap.exchangeTs,
      receivedAt: bootstrap.receivedAt,
    });
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
  pendingCalls = 0;
  reconciles = 0;
  reconcilePreserveStatus: Array<boolean | undefined> = [];
  updates: RawOrderUpdate[] = [];
  states: PrivateSubscriptionState[] = [];
  expiredClaimRequests = 0;
  claimNotFound: ExpiredPendingOrderClaim[] = [];

  constructor(
    private readonly disappeared: OrderSnapshot[] = [],
    private readonly expiredClaims: ExpiredPendingOrderClaim[] = [],
  ) {}

  onPrivateOrderPending(): void {
    this.pendingCalls += 1;
  }

  onPrivateOrderBootstrap(): OrderSnapshot[] {
    this.reconciles += 1;
    return this.disappeared;
  }

  onPrivateOrderReconcile(
    _accountId: string,
    _venue: Venue,
    _snapshot: RawOpenOrdersSnapshot,
    options: { preserveStatus?: boolean },
  ): OrderSnapshot[] {
    this.reconciles += 1;
    this.reconcilePreserveStatus.push(options.preserveStatus);
    return this.disappeared;
  }

  onPrivateOrderUpdate(
    _accountId: string,
    _venue: Venue,
    update: RawOrderUpdate,
  ): void {
    this.updates.push(update);
  }

  getPrivateOpenOrders(): OrderSnapshot[] {
    return [];
  }

  onPrivateOrderConfirmedMissing(): void {}

  getExpiredPrivateOrderClaims(): ExpiredPendingOrderClaim[] {
    this.expiredClaimRequests += 1;
    return this.expiredClaims;
  }

  onPrivateOrderClaimNotFound(
    _accountId: string,
    _venue: Venue,
    claim: ExpiredPendingOrderClaim,
  ): void {
    this.claimNotFound.push(claim);
  }

  onPrivateOrderStreamState(
    _accountId: string,
    _venue: Venue,
    state: PrivateSubscriptionState,
  ): void {
    this.states.push(state);
  }
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
  reconcileCalls = 0;
  fetchOpenOrdersCalls = 0;
  fetchOrderCalls = 0;
  bootstrapCalls = 0;
  createStreamCalls = 0;
  closeCalls = 0;
  lastStreamOptions: PrivateStreamOptions | undefined;
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

  reconcileAccount(): Promise<RawAccountBootstrap> {
    this.reconcileCalls += 1;
    this.trace?.push("reconcile-account");
    return Promise.resolve({
      balances: [],
      positions: [],
      receivedAt: Date.now(),
    });
  }

  bootstrapOpenOrders(): Promise<RawOrderUpdate[]> {
    return Promise.resolve([]);
  }

  fetchOpenOrders(): Promise<RawOpenOrdersSnapshot> {
    this.fetchOpenOrdersCalls += 1;
    this.trace?.push("fetch-open-orders");
    return Promise.resolve({
      orders: [],
      snapshotReceivedAt: Date.now(),
    });
  }

  fetchOrder(
    _credentials: AccountCredentials,
    _request: FetchOrderRequest,
  ): Promise<RawOrderUpdate | undefined> {
    this.fetchOrderCalls += 1;
    return Promise.resolve({
      orderId: "1001",
      clientOrderId: "cid-1001",
      symbol: "BTC/USDT:USDT",
      side: "buy",
      type: "LIMIT",
      status: "filled",
      amount: "1",
      filled: "1",
      receivedAt: Date.now(),
    });
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

  createPrivateStream(
    _credentials?: AccountCredentials,
    _callbacks?: PrivateStreamCallbacks,
    options?: PrivateStreamOptions,
  ): StreamHandle {
    this.createStreamCalls += 1;
    this.lastStreamOptions = options;
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

class StubBootstrapReconcileBinanceAdapter extends StubBinanceAdapter {
  constructor(trace?: string[]) {
    super(trace);
    Object.defineProperty(this, "reconcileAccount", {
      value: undefined,
      configurable: true,
    });
  }
}

class StubNoFetchOrderBinanceAdapter extends StubBinanceAdapter {
  constructor(trace?: string[]) {
    super(trace);
    Object.defineProperty(this, "fetchOrder", {
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

class SlowFetchOrderBinanceAdapter extends StubBinanceAdapter {
  startedResolvers: Array<() => void> = [];
  releaseFetches: Array<() => void> = [];

  override fetchOrder(
    _credentials: AccountCredentials,
    request: FetchOrderRequest,
  ): Promise<RawOrderUpdate | undefined> {
    this.fetchOrderCalls += 1;
    this.startedResolvers.shift()?.();
    return new Promise((resolve) => {
      this.releaseFetches.push(() =>
        resolve({
          orderId: request.orderId,
          clientOrderId: request.clientOrderId,
          symbol: request.symbol,
          side: "buy",
          type: "LIMIT",
          status: "filled",
          amount: "1",
          filled: "1",
          receivedAt: Date.now(),
        }),
      );
    });
  }
}

class SlowBootstrapAccountBinanceAdapter extends StubBinanceAdapter {
  bootstrapStartedResolvers: Array<() => void> = [];
  releaseBootstraps: Array<() => void> = [];

  override bootstrapAccount(): Promise<RawAccountBootstrap> {
    this.bootstrapCalls += 1;
    this.bootstrapStartedResolvers.shift()?.();
    return new Promise((resolve) => {
      this.releaseBootstraps.push(() =>
        resolve({
          balances: [],
          positions: [],
          receivedAt: Date.now(),
        }),
      );
    });
  }
}

class SlowOpenOrdersBinanceAdapter extends StubBinanceAdapter {
  fetchOpenOrdersStartedResolvers: Array<() => void> = [];
  releaseOpenOrders: Array<() => void> = [];

  override fetchOpenOrders(): Promise<RawOpenOrdersSnapshot> {
    this.fetchOpenOrdersCalls += 1;
    this.fetchOpenOrdersStartedResolvers.shift()?.();
    return new Promise((resolve) => {
      this.releaseOpenOrders.push(() =>
        resolve({
          orders: [],
          snapshotReceivedAt: Date.now(),
        }),
      );
    });
  }
}

class ManualReconcileBinanceAdapter extends StubBinanceAdapter {
  callbacks: PrivateStreamCallbacks | undefined;
  blockOpenOrders = false;
  fetchOpenOrdersStartedResolvers: Array<() => void> = [];
  releaseOpenOrders: Array<() => void> = [];

  override fetchOpenOrders(): Promise<RawOpenOrdersSnapshot> {
    this.fetchOpenOrdersCalls += 1;
    if (!this.blockOpenOrders) {
      return Promise.resolve({
        orders: [],
        snapshotReceivedAt: Date.now(),
      });
    }

    this.fetchOpenOrdersStartedResolvers.shift()?.();
    return new Promise((resolve) => {
      this.releaseOpenOrders.push(() =>
        resolve({
          orders: [],
          snapshotReceivedAt: Date.now(),
        }),
      );
    });
  }

  override createPrivateStream(
    _credentials?: AccountCredentials,
    callbacks?: PrivateStreamCallbacks,
  ): StreamHandle {
    this.callbacks = callbacks;
    return {
      ready: Promise.resolve(),
      close: () => {
        this.closeCalls += 1;
      },
    };
  }
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
  reconcileCalls = 0;
  fetchOpenOrdersCalls = 0;
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

  reconcileAccount(): Promise<RawAccountBootstrap> {
    this.reconcileCalls += 1;
    return Promise.resolve({
      balances: [],
      positions: [],
      receivedAt: Date.now(),
    });
  }

  fetchOpenOrders(): Promise<RawOpenOrdersSnapshot> {
    this.fetchOpenOrdersCalls += 1;
    return Promise.resolve({
      orders: [],
      snapshotReceivedAt: Date.now(),
    });
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
): Promise<{ result: T; scheduled: number; delays: number[] }> {
  const originalSetTimeout = globalThis.setTimeout;
  let scheduled = 0;
  const delays: number[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduled += 1;
    const delay = args[1];
    delays.push(typeof delay === "number" ? delay : 0);
    return originalSetTimeout(...args);
  }) as typeof setTimeout;

  return fn()
    .then((result) => ({ result, scheduled, delays }))
    .finally(() => {
      globalThis.setTimeout = originalSetTimeout;
    });
}

async function waitFor<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 200,
): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${label}`);
    }),
  ]);
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
    binanceRuntimeOptions({
      riskPollIntervalMs: 5,
      privateReconcileIntervalMs: 0,
    }),
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

test("Binance stream options are read from account venues config", async () => {
  const context = new StubContext();
  const adapter = new StubBinanceAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      listenKeyKeepAliveMs: 5,
      privateStreamStaleAfterMs: 50,
      privateReconcileIntervalMs: 0,
    }),
  );

  await coordinator.subscribeAccountFeed("main-binance");
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(adapter.lastStreamOptions).toMatchObject({
    listenKeyKeepAliveMs: 5,
    staleAfterMs: 50,
  });
});

test("Binance coordinator options are snapshotted during construction", async () => {
  const context = new StubContext();
  const adapter = new StubBinanceAdapter();
  const options = binanceRuntimeOptions({
    riskPollIntervalMs: 25,
    listenKeyKeepAliveMs: 5,
    privateStreamStaleAfterMs: 50,
    privateReconcileIntervalMs: 0,
  });
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    options,
  );

  const binanceOptions = options.venues?.binance;
  if (!binanceOptions) {
    throw new Error("expected Binance options");
  }
  binanceOptions.riskPollIntervalMs = 1;
  binanceOptions.listenKeyKeepAliveMs = 99;
  binanceOptions.privateStreamStaleAfterMs = 99;
  binanceOptions.privateReconcileIntervalMs = 1;

  const { delays } = await withSetTimeoutCounter(() =>
    coordinator.subscribeAccountFeed("main-binance"),
  );
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(delays).toEqual([25]);
  expect(adapter.lastStreamOptions).toMatchObject({
    listenKeyKeepAliveMs: 5,
    staleAfterMs: 50,
  });
});

test("Juplend does not inherit Binance coordinator polling intervals", async () => {
  const context = new StubContext();
  context.account = {
    accountId: "jup-loop-a",
    venue: "juplend",
    options: {
      walletAddress: "wallet",
    },
  };
  const adapter = new StubJuplendAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [new StubBinanceAdapter(), adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    {
      venues: {
        binance: {
          riskPollIntervalMs: 5,
          privateReconcileIntervalMs: 5,
        },
        juplend: {
          pollIntervalMs: 5,
        },
      },
    },
  );

  const { scheduled } = await withSetTimeoutCounter(() =>
    coordinator.subscribeAccountFeed("jup-loop-a"),
  );
  await Bun.sleep(20);
  coordinator.unsubscribeAccountFeed("jup-loop-a");

  expect(scheduled).toBe(0);
  expect(adapter.reconcileCalls).toBe(0);
  expect(adapter.fetchOpenOrdersCalls).toBe(0);
});

test("private reconcile polling runs by default and can be disabled independently", async () => {
  const context = new StubContext();
  const enabledAdapter = new StubBinanceAdapter();
  const enabledCoordinator = new PrivateSubscriptionCoordinator(
    context,
    [enabledAdapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      riskPollIntervalMs: 60_000,
      privateReconcileIntervalMs: 5,
    }),
  );

  await enabledCoordinator.subscribeAccountFeed("main-binance");
  await enabledCoordinator.subscribeOrderFeed("main-binance");
  await Bun.sleep(20);
  enabledCoordinator.unsubscribeOrderFeed("main-binance");
  enabledCoordinator.unsubscribeAccountFeed("main-binance");

  expect(enabledAdapter.reconcileCalls).toBeGreaterThan(0);
  expect(enabledAdapter.fetchOpenOrdersCalls).toBeGreaterThan(0);

  const disabledAdapter = new StubBinanceAdapter();
  const disabledCoordinator = new PrivateSubscriptionCoordinator(
    context,
    [disabledAdapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      riskPollIntervalMs: 5,
      privateReconcileIntervalMs: 0,
    }),
  );

  await disabledCoordinator.subscribeAccountFeed("main-binance");
  await disabledCoordinator.subscribeOrderFeed("main-binance");
  await Bun.sleep(20);
  disabledCoordinator.unsubscribeOrderFeed("main-binance");
  disabledCoordinator.unsubscribeAccountFeed("main-binance");

  expect(disabledAdapter.refreshCalls).toBeGreaterThan(0);
  expect(disabledAdapter.reconcileCalls).toBe(0);
  expect(disabledAdapter.fetchOpenOrdersCalls).toBe(1);
});

test("immediate private reconcile requests are coalesced with one dirty replay", async () => {
  const context = new StubContext();
  const adapter = new ManualReconcileBinanceAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      privateReconcileIntervalMs: 0,
    }),
  );

  await coordinator.subscribeOrderFeed("main-binance");
  expect(adapter.callbacks?.requestReconcile).toBeDefined();
  adapter.fetchOpenOrdersCalls = 0;
  adapter.blockOpenOrders = true;

  const firstStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  adapter.callbacks?.requestReconcile?.("symbol_mapping_miss");
  await waitFor(firstStarted, "first immediate reconcile");
  expect(adapter.fetchOpenOrdersCalls).toBe(1);

  adapter.callbacks?.requestReconcile?.("symbol_mapping_miss");
  adapter.callbacks?.requestReconcile?.("symbol_mapping_miss");
  await Bun.sleep(0);
  expect(adapter.fetchOpenOrdersCalls).toBe(1);

  const secondStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  adapter.releaseOpenOrders.shift()?.();
  await waitFor(secondStarted, "dirty replay reconcile");
  expect(adapter.fetchOpenOrdersCalls).toBe(2);

  adapter.releaseOpenOrders.shift()?.();
  await Bun.sleep(5);
  expect(adapter.fetchOpenOrdersCalls).toBe(2);
});

test("private reconcile re-arms dirty requests queued in the finalizer window", async () => {
  const context = new StubContext();
  const adapter = new ManualReconcileBinanceAdapter();
  const orderConsumer = new StubOrderConsumer();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    orderConsumer,
    binanceRuntimeOptions({
      privateReconcileIntervalMs: 0,
    }),
  );

  await coordinator.subscribeOrderFeed("main-binance");
  expect(adapter.callbacks?.requestReconcile).toBeDefined();
  adapter.fetchOpenOrdersCalls = 0;
  orderConsumer.reconciles = 0;
  adapter.blockOpenOrders = true;

  type CoordinatorDrainHook = {
    drainPrivateReconcileRequests(record: unknown): Promise<void>;
  };
  const coordinatorDrainHook = coordinator as unknown as CoordinatorDrainHook;
  const originalDrain =
    coordinatorDrainHook.drainPrivateReconcileRequests.bind(coordinator);
  let queuedFinalizerWindowRequest = false;
  coordinatorDrainHook.drainPrivateReconcileRequests = async (
    record: unknown,
  ): Promise<void> => {
    await originalDrain(record);
    if (queuedFinalizerWindowRequest) {
      return;
    }

    queuedFinalizerWindowRequest = true;
    queueMicrotask(() => {
      adapter.callbacks?.requestReconcile?.("symbol_mapping_miss");
    });
  };

  const firstStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  adapter.callbacks?.requestReconcile?.("symbol_mapping_miss");
  await waitFor(firstStarted, "first immediate reconcile");
  expect(adapter.fetchOpenOrdersCalls).toBe(1);

  const secondStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  adapter.releaseOpenOrders.shift()?.();
  await waitFor(secondStarted, "finalizer-window re-armed reconcile");
  expect(adapter.fetchOpenOrdersCalls).toBe(2);

  adapter.releaseOpenOrders.shift()?.();
  await Bun.sleep(5);
  expect(orderConsumer.reconciles).toBe(2);
  expect(adapter.fetchOpenOrdersCalls).toBe(2);
});

test("periodic private reconcile shares the immediate coalescer and keeps polling", async () => {
  const context = new StubContext();
  const adapter = new ManualReconcileBinanceAdapter();
  const accountConsumer = new StubAccountConsumer();
  const orderConsumer = new StubOrderConsumer();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    accountConsumer,
    orderConsumer,
    binanceRuntimeOptions({
      riskPollIntervalMs: 60_000,
      privateReconcileIntervalMs: 10,
    }),
  );

  await coordinator.subscribeAccountFeed("main-binance");
  await coordinator.subscribeOrderFeed("main-binance");
  expect(adapter.callbacks?.requestReconcile).toBeDefined();
  expect(adapter.callbacks?.onReconnected).toBeDefined();

  adapter.reconcileCalls = 0;
  adapter.fetchOpenOrdersCalls = 0;
  accountConsumer.pendingCalls = 0;
  accountConsumer.reconcilePreserveStatus = [];
  orderConsumer.pendingCalls = 0;
  orderConsumer.reconciles = 0;
  orderConsumer.reconcilePreserveStatus = [];
  adapter.blockOpenOrders = true;

  const firstStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  await waitFor(firstStarted, "first periodic reconcile");
  expect(adapter.reconcileCalls).toBe(1);
  expect(adapter.fetchOpenOrdersCalls).toBe(1);

  adapter.callbacks?.requestReconcile?.("symbol_mapping_miss");
  adapter.callbacks?.onReconnected?.();
  await Bun.sleep(0);
  expect(adapter.reconcileCalls).toBe(1);
  expect(adapter.fetchOpenOrdersCalls).toBe(1);

  const secondStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  adapter.releaseOpenOrders.shift()?.();
  await waitFor(secondStarted, "dirty replay reconcile");
  expect(adapter.reconcileCalls).toBe(2);
  expect(adapter.fetchOpenOrdersCalls).toBe(2);

  const thirdStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  adapter.releaseOpenOrders.shift()?.();
  await waitFor(thirdStarted, "rescheduled periodic reconcile");
  expect(adapter.reconcileCalls).toBe(3);
  expect(adapter.fetchOpenOrdersCalls).toBe(3);

  adapter.releaseOpenOrders.shift()?.();
  await Bun.sleep(0);
  coordinator.unsubscribeOrderFeed("main-binance");
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(accountConsumer.reconcilePreserveStatus).toEqual([true, false, true]);
  expect(orderConsumer.reconcilePreserveStatus).toEqual([true, false, true]);
  expect(accountConsumer.pendingCalls).toBe(1);
  expect(orderConsumer.pendingCalls).toBe(1);
});

test("in-flight private reconcile ignores stale generation after client stop", async () => {
  const context = new StubContext();
  const adapter = new ManualReconcileBinanceAdapter();
  const orderConsumer = new StubOrderConsumer();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    orderConsumer,
    binanceRuntimeOptions({
      privateReconcileIntervalMs: 0,
    }),
  );

  await coordinator.subscribeOrderFeed("main-binance");
  adapter.fetchOpenOrdersCalls = 0;
  orderConsumer.reconciles = 0;
  adapter.blockOpenOrders = true;

  const reconcileStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  adapter.callbacks?.requestReconcile?.("symbol_mapping_miss");
  await waitFor(reconcileStarted, "manual reconcile");
  coordinator.onClientStopping();

  adapter.releaseOpenOrders.shift()?.();
  await Bun.sleep(0);

  expect(orderConsumer.reconciles).toBe(0);
  expect(context.errors).toHaveLength(0);
});

test("private reconcile polling uses bootstrapAccount fallback when reconcileAccount is absent", async () => {
  const context = new StubContext();
  const adapter = new StubBootstrapReconcileBinanceAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      riskPollIntervalMs: 60_000,
      privateReconcileIntervalMs: 5,
    }),
  );

  await coordinator.subscribeAccountFeed("main-binance");
  await Bun.sleep(20);
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(adapter.bootstrapCalls).toBeGreaterThan(1);
});

test("private reconcile polling stops after unsubscribe cleanup", async () => {
  const context = new StubContext();
  const adapter = new StubBinanceAdapter();
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      riskPollIntervalMs: 60_000,
      privateReconcileIntervalMs: 5,
    }),
  );

  await coordinator.subscribeAccountFeed("main-binance");
  await Bun.sleep(20);
  coordinator.unsubscribeAccountFeed("main-binance");
  const reconcileCallsAfterUnsubscribe = adapter.reconcileCalls;
  await Bun.sleep(20);

  expect(adapter.reconcileCalls).toBe(reconcileCallsAfterUnsubscribe);
});

test("expired pending order claims are retained when fetchOrder is absent", async () => {
  const context = new StubContext();
  const adapter = new StubNoFetchOrderBinanceAdapter();
  const orderConsumer = new StubOrderConsumer(
    [],
    [
      {
        venueClientOrderId: "ttl-no-fetch",
        localOrderId: "local-ttl-no-fetch",
        symbol: "BTC/USDT:USDT",
        claimedAt: Date.now() - 60_000,
      },
    ],
  );
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    orderConsumer,
    binanceRuntimeOptions({
      riskPollIntervalMs: 60_000,
      privateReconcileIntervalMs: 5,
    }),
    {
      pendingClaimTtlMs: 1,
    },
  );

  await coordinator.subscribeOrderFeed("main-binance");
  await Bun.sleep(20);
  coordinator.unsubscribeOrderFeed("main-binance");

  expect(adapter.fetchOpenOrdersCalls).toBeGreaterThan(1);
  expect(adapter.fetchOrderCalls).toBe(0);
  expect(orderConsumer.expiredClaimRequests).toBe(0);
  expect(orderConsumer.claimNotFound).toHaveLength(0);
});

test("terminal backfill checks reconcile generation before each REST request", async () => {
  const disappeared: OrderSnapshot[] = Array.from(
    { length: 5 },
    (_, index) => ({
      accountId: "main-binance",
      venue: "binance",
      orderId: `${1001 + index}`,
      clientOrderId: `cid-${1001 + index}`,
      symbol: index === 1 ? "ETH/USDT:USDT" : "BTC/USDT:USDT",
      side: "buy",
      type: "LIMIT",
      status: "open",
      amount: "1",
      filled: "0",
      receivedAt: Date.now(),
      updatedAt: Date.now(),
      seq: 1,
    }),
  );
  const context = new StubContext();
  const adapter = new SlowFetchOrderBinanceAdapter();
  const firstBatchStarted = Array.from(
    { length: 4 },
    () =>
      new Promise<void>((resolve) => {
        adapter.startedResolvers.push(resolve);
      }),
  );
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    new StubOrderConsumer(disappeared),
    binanceRuntimeOptions({
      privateReconcileIntervalMs: 0,
    }),
  );

  const subscribePromise = coordinator
    .subscribeOrderFeed("main-binance")
    .catch(() => {});
  await Promise.all(firstBatchStarted);
  expect(adapter.fetchOrderCalls).toBe(4);

  coordinator.unsubscribeOrderFeed("main-binance");
  adapter.releaseFetches.shift()?.();
  await Bun.sleep(0);

  expect(adapter.fetchOrderCalls).toBe(4);
  for (const release of adapter.releaseFetches.splice(0)) {
    release();
  }
  await subscribePromise;
});

test("account bootstrap ignores stale generation after client stop", async () => {
  const trace: string[] = [];
  const context = new StubContext();
  const adapter = new SlowBootstrapAccountBinanceAdapter();
  const accountConsumer = new StubAccountConsumer(trace);
  const bootstrapStarted = new Promise<void>((resolve) => {
    adapter.bootstrapStartedResolvers.push(resolve);
  });
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    accountConsumer,
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      riskPollIntervalMs: 5,
      privateReconcileIntervalMs: 0,
    }),
  );

  const { scheduled } = await withSetTimeoutCounter(async () => {
    const subscribePromise = coordinator.subscribeAccountFeed("main-binance");
    await bootstrapStarted;
    coordinator.onClientStopping();
    expect(adapter.releaseBootstraps).toHaveLength(1);
    adapter.releaseBootstraps.shift()?.();
    await subscribePromise;
  });

  expect(trace).not.toContain("account-bootstrap");
  expect(context.errors).toHaveLength(0);
  expect(scheduled).toBe(0);
});

test("order bootstrap ignores stale generation after client stop", async () => {
  const context = new StubContext();
  const adapter = new SlowOpenOrdersBinanceAdapter();
  const orderConsumer = new StubOrderConsumer();
  const fetchStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    orderConsumer,
    binanceRuntimeOptions({
      privateReconcileIntervalMs: 0,
    }),
  );

  const subscribePromise = coordinator.subscribeOrderFeed("main-binance");
  await fetchStarted;
  coordinator.onClientStopping();
  expect(adapter.releaseOpenOrders).toHaveLength(1);
  adapter.releaseOpenOrders.shift()?.();
  await subscribePromise;

  expect(orderConsumer.reconciles).toBe(0);
  expect(context.errors).toHaveLength(0);
});

test("unsubscribing account does not cancel an in-flight order bootstrap", async () => {
  const context = new StubContext();
  const adapter = new SlowOpenOrdersBinanceAdapter();
  const orderConsumer = new StubOrderConsumer();
  const fetchStarted = new Promise<void>((resolve) => {
    adapter.fetchOpenOrdersStartedResolvers.push(resolve);
  });
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    new StubAccountConsumer(),
    orderConsumer,
    binanceRuntimeOptions({
      privateReconcileIntervalMs: 0,
    }),
  );

  await coordinator.subscribeAccountFeed("main-binance");
  const subscribeOrdersPromise = coordinator.subscribeOrderFeed("main-binance");
  await fetchStarted;
  coordinator.unsubscribeAccountFeed("main-binance");
  expect(adapter.releaseOpenOrders).toHaveLength(1);
  adapter.releaseOpenOrders.shift()?.();
  await subscribeOrdersPromise;

  expect(orderConsumer.reconciles).toBe(1);
  expect(context.errors).toHaveLength(0);
});

test("unsubscribing orders does not cancel an in-flight account bootstrap", async () => {
  const trace: string[] = [];
  const context = new StubContext();
  const adapter = new SlowBootstrapAccountBinanceAdapter();
  const accountConsumer = new StubAccountConsumer(trace);
  const bootstrapStarted = new Promise<void>((resolve) => {
    adapter.bootstrapStartedResolvers.push(resolve);
  });
  const coordinator = new PrivateSubscriptionCoordinator(
    context,
    [adapter],
    accountConsumer,
    new StubOrderConsumer(),
    binanceRuntimeOptions({
      riskPollIntervalMs: 60_000,
      privateReconcileIntervalMs: 0,
    }),
  );

  const subscribeAccountPromise =
    coordinator.subscribeAccountFeed("main-binance");
  await coordinator.subscribeOrderFeed("main-binance");
  await bootstrapStarted;
  coordinator.unsubscribeOrderFeed("main-binance");
  expect(adapter.releaseBootstraps).toHaveLength(1);
  adapter.releaseBootstraps.shift()?.();
  await subscribeAccountPromise;

  expect(trace).toContain("account-bootstrap");
  expect(context.errors).toHaveLength(0);
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
    binanceRuntimeOptions({
      riskPollIntervalMs: 5,
      privateReconcileIntervalMs: 0,
    }),
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
    binanceRuntimeOptions({
      riskPollIntervalMs: 5,
      privateReconcileIntervalMs: 0,
    }),
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
    binanceRuntimeOptions({
      riskPollIntervalMs: 5,
    }),
  );

  adapter.bootstrapAccountError = new Error("bootstrap failed");
  const failure = await coordinator
    .subscribeAccountFeed("main-binance")
    .catch((error) => error);

  expect(failure).toMatchObject({
    code: "ACCOUNT_BOOTSTRAP_FAILED",
  });
  expect((failure as AcexError).details?.orderState).toBeUndefined();

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
    binanceRuntimeOptions({
      riskPollIntervalMs: 50,
    }),
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
    binanceRuntimeOptions({
      riskPollIntervalMs: 5,
    }),
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
    binanceRuntimeOptions({
      riskPollIntervalMs: 0,
      privateReconcileIntervalMs: 0,
    }),
  );

  const { delays } = await withSetTimeoutCounter(() =>
    coordinator.subscribeAccountFeed("main-binance"),
  );
  coordinator.unsubscribeAccountFeed("main-binance");

  expect(delays).toEqual([5_000]);
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
