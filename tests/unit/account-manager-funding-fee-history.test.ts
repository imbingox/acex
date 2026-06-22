import { expect, test } from "bun:test";
import type {
  RawFundingFeeHistoryEntry,
  RawFundingFeeHistoryResult,
  RawOrderUpdate,
  RawSymbolFeeRate,
} from "../../src/adapters/types.ts";
import type {
  ClientContext,
  FetchFundingFeeHistoryContextInput,
  RegisteredAccountRecord,
} from "../../src/client/context.ts";
import { AcexError, type VenueErrorReason } from "../../src/errors.ts";
import { AccountManagerImpl } from "../../src/managers/account-manager.ts";
import type {
  AcexInternalError,
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  GetSymbolFeeRateInput,
  HealthEvent,
  MarketDefinition,
  MetricType,
  Venue,
  VenueOrderCapabilities,
} from "../../src/types/index.ts";

class StubFundingFeeContext implements ClientContext {
  readonly errors: AcexInternalError[] = [];
  readonly metricsEnabled = false;
  readonly calls: FetchFundingFeeHistoryContextInput[] = [];
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
  fetchFundingFeeHistoryImpl: (
    input: FetchFundingFeeHistoryContextInput,
  ) => Promise<RawFundingFeeHistoryResult> = async () => ({
    fees: [],
    truncated: false,
  });

  now(): number {
    return this.nowMs;
  }

  assertStarted(): void {
    if (!this.started) {
      throw new AcexError("CLIENT_NOT_STARTED", "Client not started");
    }
  }

  getRegisteredAccount(accountId: string): RegisteredAccountRecord {
    if (accountId !== this.account.accountId) {
      throw new AcexError(
        "ACCOUNT_NOT_FOUND",
        `Account not found: ${accountId}`,
      );
    }
    return this.account;
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
    return undefined;
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

  fetchSymbolFeeRate(_input: GetSymbolFeeRateInput): Promise<RawSymbolFeeRate> {
    throw new Error("not implemented");
  }

  fetchFundingFeeHistory(
    input: FetchFundingFeeHistoryContextInput,
  ): Promise<RawFundingFeeHistoryResult> {
    this.calls.push({ ...input });
    return this.fetchFundingFeeHistoryImpl(input);
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

function rawFundingFee(
  input: Partial<RawFundingFeeHistoryEntry> & {
    symbol: string;
    amount: string;
    fundingTime: number;
  },
): RawFundingFeeHistoryEntry {
  return {
    symbol: input.symbol,
    asset: input.asset ?? "USDT",
    amount: input.amount,
    fundingTime: input.fundingTime,
    receivedAt: input.receivedAt ?? 1710000000100,
    venueTransactionId: input.venueTransactionId,
    tradeId: input.tradeId,
    positionSide: input.positionSide,
    raw: input.raw ?? { tranId: input.venueTransactionId },
  };
}

test("AccountManager funding fee history rejects invalid limit locally", async () => {
  const context = new StubFundingFeeContext();
  const manager = new AccountManagerImpl(context);

  await expect(
    manager.fetchFundingFeeHistory({
      accountId: "main-binance",
      limit: 1001,
    }),
  ).rejects.toMatchObject({
    code: "ACCOUNT_INPUT_INVALID",
    details: {
      accountId: "main-binance",
      venue: "binance",
    },
  });
  expect(context.calls).toHaveLength(0);
});

test("AccountManager funding fee history returns empty result for empty symbols", async () => {
  const context = new StubFundingFeeContext();
  const manager = new AccountManagerImpl(context);

  const result = await manager.fetchFundingFeeHistory({
    accountId: "main-binance",
    symbols: [],
    startTs: 1700000000000,
    endTs: 1700003600000,
  });

  expect(context.calls).toHaveLength(0);
  expect(result).toEqual({
    fees: [],
    startTs: 1700000000000,
    endTs: 1700003600000,
    page: 1,
    limit: 1000,
    truncated: false,
    nextPage: undefined,
  });
});

test("AccountManager funding fee history loops small symbol sets per query page", async () => {
  const context = new StubFundingFeeContext();
  context.fetchFundingFeeHistoryImpl = async (input) => {
    if (input.page === 2) {
      return input.symbol === "ETH/USDT:USDT"
        ? {
            fees: [
              rawFundingFee({
                symbol: "ETH/USDT:USDT",
                amount: "0.3000",
                fundingTime: 1700007200000,
                venueTransactionId: "eth-page-2",
              }),
            ],
            truncated: false,
          }
        : { fees: [], truncated: false };
    }

    if (input.symbol === "ETH/USDT:USDT") {
      return {
        fees: [
          rawFundingFee({
            symbol: "ETH/USDT:USDT",
            amount: "0.2000",
            fundingTime: 1700003600000,
            venueTransactionId: "eth-page-1",
          }),
        ],
        truncated: true,
      };
    }

    return {
      fees: [
        rawFundingFee({
          symbol: input.symbol ?? "BTC/USDT:USDT",
          amount: "0.1000",
          fundingTime: 1700000000000,
          venueTransactionId: `${input.symbol}-page-1`,
        }),
      ],
      truncated: false,
    };
  };
  const manager = new AccountManagerImpl(context);

  const firstPage = await manager.fetchFundingFeeHistory({
    accountId: "main-binance",
    symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"],
    page: 1,
  });
  const secondPage = await manager.fetchFundingFeeHistory({
    accountId: "main-binance",
    symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"],
    page: 2,
  });

  expect(context.calls.map((call) => [call.symbol, call.page])).toEqual([
    ["BTC/USDT:USDT", 1],
    ["ETH/USDT:USDT", 1],
    ["SOL/USDT:USDT", 1],
    ["BTC/USDT:USDT", 2],
    ["ETH/USDT:USDT", 2],
    ["SOL/USDT:USDT", 2],
  ]);
  expect(firstPage.truncated).toBe(true);
  expect(firstPage.nextPage).toBe(2);
  expect(firstPage.fees.map((fee) => fee.venueTransactionId)).toEqual([
    "BTC/USDT:USDT-page-1",
    "SOL/USDT:USDT-page-1",
    "eth-page-1",
  ]);
  expect(secondPage.truncated).toBe(false);
  expect(secondPage.nextPage).toBeUndefined();
  expect(secondPage.fees.map((fee) => fee.venueTransactionId)).toEqual([
    "eth-page-2",
  ]);
});

test("AccountManager funding fee history account-scan filters locally without per-symbol truncated metadata", async () => {
  const context = new StubFundingFeeContext();
  context.fetchFundingFeeHistoryImpl = async () => ({
    fees: [
      rawFundingFee({
        symbol: "BTC/USDT:USDT",
        amount: "1.0000",
        fundingTime: 1700000000000,
        venueTransactionId: "btc",
      }),
      rawFundingFee({
        symbol: "ETH/USDT:USDT",
        amount: "-0.010000",
        fundingTime: 1700000000001,
        venueTransactionId: "eth",
      }),
      rawFundingFee({
        symbol: "XRP/USDT:USDT",
        amount: "2.0000",
        fundingTime: 1700000000002,
        venueTransactionId: "xrp",
      }),
    ],
    truncated: true,
  });
  const manager = new AccountManagerImpl(context);

  const result = await manager.fetchFundingFeeHistory({
    accountId: "main-binance",
    symbols: [
      "ADA/USDT:USDT",
      "BNB/USDT:USDT",
      "DOGE/USDT:USDT",
      "ETH/USDT:USDT",
      "SOL/USDT:USDT",
      "TRX/USDT:USDT",
    ],
    page: 3,
    limit: 500,
  });

  expect(context.calls).toEqual([
    {
      accountId: "main-binance",
      startTs: undefined,
      endTs: undefined,
      page: 3,
      limit: 500,
    },
  ]);
  expect(result.fees.map((fee) => fee.symbol)).toEqual(["ETH/USDT:USDT"]);
  expect(result.fees[0]?.amount).toBe("-0.01");
  expect(result.truncated).toBe(true);
  expect(result.nextPage).toBe(4);
});

test("AccountManager funding fee history canonicalizes, sorts, and preserves venue transaction ids", async () => {
  const context = new StubFundingFeeContext();
  context.fetchFundingFeeHistoryImpl = async () => ({
    fees: [
      rawFundingFee({
        symbol: "SOL/USDT:USDT",
        amount: "1.2300",
        fundingTime: 1700000000001,
        venueTransactionId: "2",
      }),
      rawFundingFee({
        symbol: "BTC/USDT:USDT",
        amount: "0.00001000",
        fundingTime: 1700000000000,
        venueTransactionId: "9",
      }),
      rawFundingFee({
        symbol: "BTC/USDT:USDT",
        amount: "-0.5000",
        fundingTime: 1700000000000,
        venueTransactionId: "1",
      }),
    ],
    truncated: false,
  });
  const manager = new AccountManagerImpl(context);

  const result = await manager.fetchFundingFeeHistory({
    accountId: "main-binance",
  });

  expect(
    result.fees.map((fee) => ({
      symbol: fee.symbol,
      amount: fee.amount,
      venueTransactionId: fee.venueTransactionId,
      accountId: fee.accountId,
      venue: fee.venue,
    })),
  ).toEqual([
    {
      symbol: "BTC/USDT:USDT",
      amount: "-0.5",
      venueTransactionId: "1",
      accountId: "main-binance",
      venue: "binance",
    },
    {
      symbol: "BTC/USDT:USDT",
      amount: "0.00001",
      venueTransactionId: "9",
      accountId: "main-binance",
      venue: "binance",
    },
    {
      symbol: "SOL/USDT:USDT",
      amount: "1.23",
      venueTransactionId: "2",
      accountId: "main-binance",
      venue: "binance",
    },
  ]);
});

test("AccountManager funding fee history wraps adapter failures with symbol metadata", async () => {
  const context = new StubFundingFeeContext();
  const cause = new Error("remote failed");
  context.fetchFundingFeeHistoryImpl = async () => {
    throw cause;
  };
  const manager = new AccountManagerImpl(context);

  await expect(
    manager.fetchFundingFeeHistory({
      accountId: "main-binance",
      symbols: ["BTC/USDT:USDT"],
    }),
  ).rejects.toMatchObject({
    code: "ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED",
    cause,
    details: {
      accountId: "main-binance",
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    },
  });
  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "adapter",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
});

test("AccountManager funding fee history wraps per-symbol normalization failures with symbol metadata", async () => {
  const context = new StubFundingFeeContext();
  context.fetchFundingFeeHistoryImpl = async (input) => ({
    fees: [
      rawFundingFee({
        symbol: input.symbol ?? "BTC/USDT:USDT",
        amount: "not-a-decimal",
        fundingTime: 1700000000000,
        venueTransactionId: "bad-decimal",
      }),
    ],
    truncated: false,
  });
  const manager = new AccountManagerImpl(context);

  await expect(
    manager.fetchFundingFeeHistory({
      accountId: "main-binance",
      symbols: ["BTC/USDT:USDT"],
    }),
  ).rejects.toMatchObject({
    code: "ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED",
    details: {
      accountId: "main-binance",
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    },
  });
  expect(context.errors).toHaveLength(1);
  expect(context.errors[0]).toMatchObject({
    source: "adapter",
    accountId: "main-binance",
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
});
