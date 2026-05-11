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
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { PrivateSubscriptionCoordinator } from "../../src/client/private-subscription-coordinator.ts";
import { AcexError } from "../../src/errors.ts";
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

  onPrivateAccountPending(_accountId: string, _venue: Venue): void {}

  onPrivateAccountBootstrap(
    _accountId: string,
    _venue: Venue,
    _bootstrap: RawAccountBootstrap,
  ): void {}

  onPrivateAccountUpdate(
    _accountId: string,
    _venue: Venue,
    update: RawAccountUpdate,
  ): void {
    this.updates.push(update);
  }

  onPrivateAccountStreamState(): void {}
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

  bootstrapAccount(): Promise<RawAccountBootstrap> {
    return Promise.resolve({
      balances: [],
      positions: [],
      receivedAt: Date.now(),
    });
  }

  refreshAccount(): Promise<RawAccountUpdate> {
    this.refreshCalls += 1;
    return Promise.resolve({
      risk: {
        equity: "1",
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
    return {
      ready: Promise.resolve(),
      close() {},
    };
  }
}

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
