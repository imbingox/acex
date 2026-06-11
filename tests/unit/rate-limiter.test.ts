import { expect, test } from "bun:test";
import { parseBinanceRateLimitUsage } from "../../src/adapters/binance/rate-limit.ts";
import {
  BINANCE_RATE_LIMIT_BUCKETS,
  BINANCE_RATE_LIMIT_PLANS,
  BINANCE_RATE_LIMIT_TOPOLOGY,
  getBinanceCatalogRateLimitPlanId,
  getBinancePapiRateLimitPlanId,
  getBinanceServerTimeRateLimitPlanId,
  registerBinanceRateLimitTopology,
} from "../../src/adapters/binance/rate-limit-topology.ts";
import {
  BudgetRateLimiter,
  ReactiveRateLimiter,
} from "../../src/internal/rate-limiter.ts";
import type {
  RateLimitRequestContext,
  RateLimitScope,
  RateLimitTopology,
} from "../../src/types/index.ts";

const accountScope: RateLimitScope = {
  venue: "binance",
  accountId: "main-binance",
  endpointKey: "GET /papi/v1/account",
};

test("ReactiveRateLimiter tracks Binance header usage parsed at the venue layer", () => {
  const limiter = new ReactiveRateLimiter({ now: () => 1_000 });
  const headers = new Headers({
    "X-MBX-USED-WEIGHT-1m": "42",
    "x-mbx-used-weight-1d": "420",
    "X-MBX-ORDER-COUNT-10S": "7",
    "X-MBX-ORDER-COUNT-1m": "11",
  });

  const usage = parseBinanceRateLimitUsage(headers);
  limiter.afterResponse(
    { scope: accountScope },
    {
      status: 200,
      headers,
      usage,
    },
  );

  expect(limiter.getSnapshot(accountScope)).toEqual({
    scope: accountScope,
    usage: {
      weight: {
        "1m": 42,
        "1d": 420,
      },
      orderCount: {
        "10s": 7,
        "1m": 11,
      },
    },
    state: "ok",
    updatedAt: 1_000,
  });
});

test("ReactiveRateLimiter blocks only after 429 Retry-After metadata", async () => {
  let now = 10_000;
  const sleeps: number[] = [];
  const limiter = new ReactiveRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  await limiter.beforeRequest({ scope: accountScope });
  expect(sleeps).toEqual([]);

  limiter.onTransportError(
    { scope: accountScope },
    {
      status: 429,
      retryAfterMs: 2_000,
    },
  );

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 12_000,
    retryAfterMs: 2_000,
    state: "rate_limited",
  });

  await limiter.beforeRequest({ scope: accountScope });
  expect(sleeps).toEqual([2_000]);
  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    state: "ok",
  });
});

test("ReactiveRateLimiter treats 418 as a longer ban block and keeps scopes separate", () => {
  const limiter = new ReactiveRateLimiter({ now: () => 5_000 });
  const orderScope: RateLimitScope = {
    venue: "binance",
    accountId: "main-binance",
    endpointKey: "GET /papi/v1/um/openOrders",
  };

  limiter.onTransportError(
    { scope: accountScope },
    {
      status: 429,
      retryAfterMs: 1_000,
    },
  );
  limiter.onTransportError(
    { scope: orderScope },
    {
      status: 418,
      retryAfterMs: 60_000,
    },
  );

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 6_000,
    state: "rate_limited",
  });
  expect(limiter.getSnapshot(orderScope)).toMatchObject({
    blockedUntil: 65_000,
    retryAfterMs: 60_000,
    state: "banned",
  });
});

test("ReactiveRateLimiter keeps an active block when an in-flight success updates usage", () => {
  const limiter = new ReactiveRateLimiter({ now: () => 1_000 });

  limiter.onTransportError(
    { scope: accountScope },
    {
      status: 429,
      retryAfterMs: 5_000,
    },
  );
  limiter.afterResponse(
    { scope: accountScope },
    {
      status: 200,
      usage: {
        weight: {
          "1m": 12,
        },
      },
    },
  );

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 6_000,
    state: "rate_limited",
    usage: {
      weight: {
        "1m": 12,
      },
    },
  });
});

test("BudgetRateLimiter registers topology idempotently and rejects conflicts", () => {
  const limiter = new BudgetRateLimiter();

  limiter.registerRateLimitTopology(BINANCE_RATE_LIMIT_TOPOLOGY);
  limiter.registerRateLimitTopology(BINANCE_RATE_LIMIT_TOPOLOGY);

  const existingBucket = BINANCE_RATE_LIMIT_TOPOLOGY.buckets[0];
  if (!existingBucket) {
    throw new Error("Binance topology is missing buckets");
  }
  const conflictingTopology: RateLimitTopology = {
    id: "conflicting-binance",
    buckets: [
      {
        ...existingBucket,
        limit: 1,
      },
    ],
    plans: [],
  };

  expect(() => limiter.registerRateLimitTopology(conflictingTopology)).toThrow(
    "Conflicting rate limit bucket descriptor",
  );
});

test("registerBinanceRateLimitTopology feature-detects old custom limiters", () => {
  const seen: RateLimitRequestContext[] = [];
  const oldLimiter = {
    beforeRequest(ctx: RateLimitRequestContext): void {
      seen.push(ctx);
    },
    afterResponse(): void {},
    onTransportError(): void {},
    getSnapshot(): undefined {
      return undefined;
    },
  };

  expect(() => registerBinanceRateLimitTopology(oldLimiter)).not.toThrow();
  oldLimiter.beforeRequest({
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  });
  expect(seen.at(-1)?.planId).toBe(BINANCE_RATE_LIMIT_PLANS.papiAccount);
});

test("BudgetRateLimiter falls back to endpoint scope for unknown plans", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  limiter.registerRateLimitTopology(BINANCE_RATE_LIMIT_TOPOLOGY);

  const unknownPlanContext = {
    scope: accountScope,
    planId: "binance:papi:unknown",
  };

  limiter.onTransportError(unknownPlanContext, {
    status: 429,
    retryAfterMs: 500,
  });

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 1_500,
    state: "rate_limited",
  });

  await limiter.beforeRequest(unknownPlanContext);
  expect(sleeps).toEqual([500]);
});

test("BudgetRateLimiter blocks known Binance request-weight buckets for 418", async () => {
  let now = 10_000;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  registerBinanceRateLimitTopology(limiter);

  const accountContext = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  };
  const balanceContext = {
    scope: {
      venue: "binance",
      endpointKey: "GET /papi/v1/balance",
    } satisfies RateLimitScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiBalance,
  };

  limiter.onTransportError(accountContext, {
    status: 418,
    retryAfterMs: 3_000,
  });

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 13_000,
    state: "banned",
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 13_000,
      state: "banned",
    }),
  ]);

  await limiter.beforeRequest(balanceContext);
  expect(sleeps).toEqual([3_000]);
});

test("BudgetRateLimiter rechecks longer blocks after sleeping", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      if (sleeps.length === 1) {
        limiter.onTransportError(
          {
            scope: accountScope,
            planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
          },
          {
            status: 418,
            retryAfterMs: 60_000,
          },
        );
      }
    },
  });
  registerBinanceRateLimitTopology(limiter);

  const context = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  };
  limiter.onTransportError(context, {
    status: 429,
    retryAfterMs: 1_000,
  });

  await limiter.beforeRequest(context);
  expect(sleeps).toEqual([1_000, 60_000]);
  expect(now).toBe(62_000);
});

test("BudgetRateLimiter blocks the single affected bucket for 429", () => {
  const limiter = new BudgetRateLimiter({ now: () => 2_000 });
  registerBinanceRateLimitTopology(limiter);

  const context = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  };
  limiter.onTransportError(context, {
    status: 429,
    retryAfterMs: 1_000,
  });

  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 3_000,
      state: "rate_limited",
    }),
  ]);
});

test("BudgetRateLimiter keeps a reactive block for 429 without Retry-After", async () => {
  let now = 2_000;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  registerBinanceRateLimitTopology(limiter);

  const context = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  };
  limiter.onTransportError(context, {
    status: 429,
  });

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 2_001,
    retryAfterMs: 1,
    state: "rate_limited",
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 2_001,
      retryAfterMs: 1,
      state: "rate_limited",
    }),
  ]);

  await limiter.beforeRequest(context);
  expect(sleeps).toEqual([1]);
});

test("BudgetRateLimiter does not downgrade an active ban with a shorter 429", () => {
  const limiter = new BudgetRateLimiter({ now: () => 5_000 });
  registerBinanceRateLimitTopology(limiter);

  const context = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  };
  limiter.onTransportError(context, {
    status: 418,
    retryAfterMs: 60_000,
  });
  limiter.onTransportError(context, {
    status: 429,
    retryAfterMs: 1_000,
  });

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 65_000,
    retryAfterMs: 60_000,
    state: "banned",
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 65_000,
      retryAfterMs: 60_000,
      state: "banned",
    }),
  ]);
});

test("BudgetRateLimiter does not downgrade an active ban with an equal-deadline 429", () => {
  const limiter = new BudgetRateLimiter({ now: () => 5_000 });
  registerBinanceRateLimitTopology(limiter);

  const context = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  };
  limiter.onTransportError(context, {
    status: 418,
    retryAfterMs: 1_000,
  });
  limiter.onTransportError(context, {
    status: 429,
    retryAfterMs: 1_000,
  });

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 6_000,
    retryAfterMs: 1_000,
    state: "banned",
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 6_000,
      retryAfterMs: 1_000,
      state: "banned",
    }),
  ]);
});

test("BudgetRateLimiter conservatively blocks all positive-cost buckets for multi-bucket 429", () => {
  const topology: RateLimitTopology = {
    id: "multi-bucket-test",
    buckets: [
      {
        id: "bucket:weight",
        kind: "request_weight",
        limit: 100,
        intervalMs: 60_000,
        scope: ["venue"],
      },
      {
        id: "bucket:orders",
        kind: "orders",
        limit: 10,
        intervalMs: 60_000,
        scope: ["venue", "account"],
      },
    ],
    plans: [
      {
        id: "plan:multi",
        costs: [
          { bucketId: "bucket:weight", cost: 1 },
          { bucketId: "bucket:orders", cost: 1 },
        ],
      },
    ],
  };
  const limiter = new BudgetRateLimiter({ now: () => 1_000 });
  limiter.registerRateLimitTopology(topology);

  limiter.onTransportError(
    {
      scope: accountScope,
      planId: "plan:multi",
    },
    {
      status: 429,
      retryAfterMs: 2_000,
    },
  );

  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      blockedUntil: 3_000,
    }),
    expect.objectContaining({
      bucketId: "bucket:orders",
      blockedUntil: 3_000,
    }),
  ]);
});

test("BudgetRateLimiter aggregate snapshot fields come from the same latest bucket block", () => {
  const topology: RateLimitTopology = {
    id: "aggregate-snapshot-test",
    buckets: [
      {
        id: "bucket:weight",
        kind: "request_weight",
        limit: 100,
        intervalMs: 60_000,
        scope: ["venue"],
      },
      {
        id: "bucket:orders",
        kind: "orders",
        limit: 10,
        intervalMs: 60_000,
        scope: ["venue", "account"],
      },
    ],
    plans: [
      {
        id: "plan:weight",
        costs: [{ bucketId: "bucket:weight", cost: 1 }],
      },
      {
        id: "plan:orders",
        costs: [{ bucketId: "bucket:orders", cost: 1 }],
      },
      {
        id: "plan:snapshot",
        costs: [
          { bucketId: "bucket:weight", cost: 1 },
          { bucketId: "bucket:orders", cost: 1 },
        ],
      },
    ],
  };
  const limiter = new BudgetRateLimiter({ now: () => 1_000 });
  limiter.registerRateLimitTopology(topology);

  limiter.onTransportError(
    {
      scope: accountScope,
      planId: "plan:orders",
    },
    {
      status: 429,
      retryAfterMs: 30_000,
    },
  );
  limiter.onTransportError(
    {
      scope: accountScope,
      planId: "plan:weight",
    },
    {
      status: 418,
      retryAfterMs: 10_000,
    },
  );
  limiter.afterResponse(
    {
      scope: accountScope,
      planId: "plan:snapshot",
    },
    { status: 200 },
  );

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 31_000,
    retryAfterMs: 30_000,
    state: "rate_limited",
  });
});

test("BudgetRateLimiter maps response usage to the current plan bucket", () => {
  const limiter = new BudgetRateLimiter({ now: () => 1_000 });
  registerBinanceRateLimitTopology(limiter);

  const context = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiNewOrder,
  };
  limiter.afterResponse(context, {
    status: 200,
    usage: {
      weight: { "1m": 55 },
      orderCount: { "1m": 7 },
    },
  });

  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      used: 55,
    }),
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiOrders1m,
      used: 7,
    }),
  ]);
});

test("Binance topology uses semantic plans for host and openOrders variants", () => {
  expect(getBinanceCatalogRateLimitPlanId("GET /api/v3/exchangeInfo")).toBe(
    BINANCE_RATE_LIMIT_PLANS.spotExchangeInfo,
  );
  expect(getBinanceCatalogRateLimitPlanId("GET /fapi/v1/exchangeInfo")).toBe(
    BINANCE_RATE_LIMIT_PLANS.fapiExchangeInfo,
  );
  expect(getBinanceCatalogRateLimitPlanId("GET /dapi/v1/exchangeInfo")).toBe(
    BINANCE_RATE_LIMIT_PLANS.dapiExchangeInfo,
  );
  expect(getBinanceServerTimeRateLimitPlanId()).toBe(
    BINANCE_RATE_LIMIT_PLANS.fapiServerTime,
  );
  expect(
    getBinancePapiRateLimitPlanId("GET", "/papi/v1/um/openOrders", {
      symbol: "BTCUSDT",
    }),
  ).toBe(BINANCE_RATE_LIMIT_PLANS.papiOpenOrdersSymbol);
  expect(getBinancePapiRateLimitPlanId("GET", "/papi/v1/um/openOrders")).toBe(
    BINANCE_RATE_LIMIT_PLANS.papiOpenOrdersAll,
  );
});
