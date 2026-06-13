import { expect, test } from "bun:test";
import type {
  RawOrderUpdate,
  RawSymbolFeeRate,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import type { VenueErrorReason } from "../../src/errors.ts";
import { VENUE_CLIENT_ORDER_ID_PATTERN } from "../../src/managers/order/identity.ts";
import { OrderManagerImpl } from "../../src/managers/order-manager.ts";
import type {
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  GetSymbolFeeRateInput,
  HealthEvent,
  Venue,
  VenueOrderCapabilities,
} from "../../src/types/index.ts";

class StubOrderContext implements ClientContext {
  readonly createdClientOrderIds: string[] = [];
  readonly metricsEnabled = false;

  now(): number {
    return 1710000000000;
  }

  assertStarted(): void {}

  getRegisteredAccount(accountId: string): RegisteredAccountRecord {
    return {
      accountId,
      venue: "binance",
      credentials: {
        apiKey: "key",
        secret: "secret",
      },
    };
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

  ensurePrivateCredentials(_accountId: string): void {}

  subscribePrivateAccountFeed(_accountId: string): Promise<void> {
    return Promise.resolve();
  }

  unsubscribePrivateAccountFeed(_accountId: string): void {}

  subscribePrivateOrderFeed(_accountId: string): Promise<void> {
    return Promise.resolve();
  }

  unsubscribePrivateOrderFeed(_accountId: string): void {}

  createOrder(input: CreateOrderInput): Promise<RawOrderUpdate> {
    if (!input.clientOrderId) {
      throw new Error("Expected generated clientOrderId");
    }

    this.createdClientOrderIds.push(input.clientOrderId);
    return Promise.resolve({
      orderId: `${this.createdClientOrderIds.length}`,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      status: "open",
      price: input.type === "limit" ? input.price : undefined,
      amount: input.amount,
      filled: "0",
      receivedAt: this.now(),
    });
  }

  cancelOrder(_input: CancelOrderInput): Promise<RawOrderUpdate> {
    throw new Error("not implemented");
  }

  cancelAllOrders(_input: CancelAllOrdersInput): Promise<RawOrderUpdate[]> {
    throw new Error("not implemented");
  }

  fetchSymbolFeeRate(_input: GetSymbolFeeRateInput): Promise<RawSymbolFeeRate> {
    throw new Error("not implemented");
  }

  publishRuntimeError(
    _source: AcexInternalError["source"],
    _error: Error,
    _metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void {}

  publishHealthEvent(_event: HealthEvent): void {}

  emitMetric(): void {}
}

test("OrderManager generated client order ids include per-manager entropy", async () => {
  const firstContext = new StubOrderContext();
  const secondContext = new StubOrderContext();
  const firstManager = new OrderManagerImpl(firstContext);
  const secondManager = new OrderManagerImpl(secondContext);

  const firstSnapshot = await firstManager.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000",
    amount: "0.01",
  });
  const secondSnapshot = await secondManager.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000",
    amount: "0.01",
  });

  const firstCid = firstContext.createdClientOrderIds[0];
  const secondCid = secondContext.createdClientOrderIds[0];
  expect(firstCid).toBeDefined();
  expect(secondCid).toBeDefined();
  if (!firstCid || !secondCid) {
    throw new Error("Expected generated client order ids");
  }

  expect(firstCid).not.toBe(secondCid);
  expect(firstCid).toMatch(/^acex-[a-z0-9]{4}-[a-z0-9]+-[a-z0-9]+$/);
  expect(secondCid).toMatch(/^acex-[a-z0-9]{4}-[a-z0-9]+-[a-z0-9]+$/);
  expect(firstCid.length).toBeLessThanOrEqual(32);
  expect(secondCid.length).toBeLessThanOrEqual(32);
  expect(VENUE_CLIENT_ORDER_ID_PATTERN.test(firstCid)).toBe(true);
  expect(VENUE_CLIENT_ORDER_ID_PATTERN.test(secondCid)).toBe(true);
  expect(firstSnapshot.clientOrderId).toBe(firstCid);
  expect(secondSnapshot.clientOrderId).toBe(secondCid);
});
