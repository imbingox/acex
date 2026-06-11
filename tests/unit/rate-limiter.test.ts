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

test("BudgetRateLimiter blocks a 429 without Retry-After until the bucket window ends plus jitter", async () => {
  let now = 2_000;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    random: () => 0.5,
    retryJitterMs: 100,
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
    blockedUntil: 60_050,
    retryAfterMs: 58_050,
    state: "rate_limited",
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 60_050,
      retryAfterMs: 58_050,
      state: "rate_limited",
    }),
  ]);

  await limiter.beforeRequest(context);
  expect(sleeps).toEqual([58_050]);
});

test("BudgetRateLimiter uses a conservative 418 fallback ban without Retry-After", () => {
  let now = 2_000;
  const limiter = new BudgetRateLimiter({
    now: () => now,
  });
  registerBinanceRateLimitTopology(limiter);

  const context = {
    scope: accountScope,
    planId: BINANCE_RATE_LIMIT_PLANS.papiAccount,
  };
  limiter.onTransportError(context, {
    status: 418,
  });

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 122_000,
    retryAfterMs: 120_000,
    state: "banned",
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 122_000,
      retryAfterMs: 120_000,
      state: "banned",
    }),
  ]);

  now = 3_000;
  limiter.onTransportError(context, {
    status: 418,
  });

  expect(limiter.getSnapshot(accountScope)).toMatchObject({
    blockedUntil: 243_000,
    retryAfterMs: 240_000,
    state: "banned",
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      blockedUntil: 243_000,
      retryAfterMs: 240_000,
      state: "banned",
    }),
  ]);
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

test("BudgetRateLimiter proactively waits when fixed-window budget is exhausted", async () => {
  let now = 100;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  limiter.registerRateLimitTopology({
    id: "active-budget-test",
    buckets: [
      {
        id: "bucket:weight",
        kind: "request_weight",
        limit: 10,
        intervalMs: 1_000,
        scope: ["venue"],
      },
    ],
    plans: [
      {
        id: "plan:weight",
        costs: [{ bucketId: "bucket:weight", cost: 5 }],
      },
    ],
  });

  const context = {
    scope: accountScope,
    planId: "plan:weight",
  };

  expect(await limiter.beforeRequest(context)).toBeDefined();
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      used: 5,
      windowStartMs: 0,
      windowEndMs: 1_000,
    }),
  ]);

  expect(await limiter.beforeRequest(context)).toBeDefined();
  expect(sleeps).toEqual([900]);
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      used: 5,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }),
  ]);
});

test("BudgetRateLimiter admits one-unit buckets under utilization target", async () => {
  let now = 100;
  let allowSleep = false;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      if (!allowSleep) {
        throw new Error(`Unexpected sleep before first admission: ${ms}`);
      }
      sleeps.push(ms);
      now += ms;
    },
  });
  limiter.registerRateLimitTopology({
    id: "tiny-budget-test",
    buckets: [
      {
        id: "bucket:tiny",
        kind: "request_weight",
        limit: 1,
        intervalMs: 1_000,
        scope: ["venue"],
      },
    ],
    plans: [
      {
        id: "plan:tiny",
        costs: [{ bucketId: "bucket:tiny", cost: 1 }],
      },
    ],
  });

  const context = {
    scope: accountScope,
    planId: "plan:tiny",
  };

  expect(await limiter.beforeRequest(context)).toBeDefined();
  expect(sleeps).toEqual([]);
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:tiny",
      used: 1,
      windowStartMs: 0,
      windowEndMs: 1_000,
    }),
  ]);

  allowSleep = true;
  expect(await limiter.beforeRequest(context)).toBeDefined();
  expect(sleeps).toEqual([900]);
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:tiny",
      used: 1,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }),
  ]);
});

test("BudgetRateLimiter preserves reserve headroom for matching priority", async () => {
  let now = 100;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    utilizationTarget: 1,
  });
  limiter.registerRateLimitTopology({
    id: "reserve-test",
    buckets: [
      {
        id: "bucket:weight",
        kind: "request_weight",
        limit: 10,
        intervalMs: 1_000,
        scope: ["venue"],
        reserve: {
          priority: "cancel",
          units: 2,
        },
      },
    ],
    plans: [
      {
        id: "plan:normal",
        costs: [{ bucketId: "bucket:weight", cost: 8 }],
      },
      {
        id: "plan:normal-small",
        costs: [{ bucketId: "bucket:weight", cost: 1 }],
      },
      {
        id: "plan:cancel",
        costs: [{ bucketId: "bucket:weight", cost: 2 }],
      },
    ],
  });

  const normal = {
    scope: accountScope,
    planId: "plan:normal",
  };
  const normalSmall = {
    scope: accountScope,
    planId: "plan:normal-small",
  };
  const cancel = {
    scope: accountScope,
    planId: "plan:cancel",
    priority: "cancel" as const,
  };

  expect(await limiter.beforeRequest(normal)).toBeDefined();
  expect(await limiter.beforeRequest(cancel)).toBeDefined();
  expect(sleeps).toEqual([]);
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      reserve: {
        priority: "cancel",
        units: 2,
      },
      used: 10,
    }),
  ]);

  expect(await limiter.beforeRequest(normalSmall)).toBeDefined();
  expect(sleeps).toEqual([900]);
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      used: 1,
      windowStartMs: 1_000,
    }),
  ]);
});

test("BudgetRateLimiter reconciles header usage and ignores stale reservation windows", async () => {
  let now = 900;
  const limiter = new BudgetRateLimiter({
    now: () => now,
    utilizationTarget: 1,
  });
  limiter.registerRateLimitTopology({
    id: "reservation-reconcile-test",
    buckets: [
      {
        id: "bucket:weight",
        kind: "request_weight",
        limit: 10,
        intervalMs: 1_000,
        scope: ["venue"],
      },
    ],
    plans: [
      {
        id: "plan:weight",
        costs: [{ bucketId: "bucket:weight", cost: 1 }],
      },
    ],
  });

  const context = {
    scope: accountScope,
    planId: "plan:weight",
  };
  const oldReservation = await limiter.beforeRequest(context);
  if (!oldReservation) {
    throw new Error("expected rate limit reservation");
  }

  now = 1_000;
  const newReservation = await limiter.beforeRequest(context);
  if (!newReservation) {
    throw new Error("expected rate limit reservation");
  }

  limiter.afterResponse(context, {
    status: 200,
    usage: {
      weight: {
        "1s": 9,
      },
    },
    reservation: oldReservation,
  });

  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      used: 1,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }),
  ]);

  limiter.afterResponse(context, {
    status: 200,
    usage: {
      weight: {
        "1s": 2,
      },
    },
    reservation: newReservation,
  });

  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      used: 2,
      windowStartMs: 1_000,
    }),
  ]);
});

test("BudgetRateLimiter ignores stale reservation usage after the local window advances", async () => {
  let now = 900;
  const limiter = new BudgetRateLimiter({
    now: () => now,
    utilizationTarget: 1,
  });
  limiter.registerRateLimitTopology({
    id: "stale-reservation-rollover-test",
    buckets: [
      {
        id: "bucket:weight",
        kind: "request_weight",
        limit: 10,
        intervalMs: 1_000,
        scope: ["venue"],
      },
    ],
    plans: [
      {
        id: "plan:weight",
        costs: [{ bucketId: "bucket:weight", cost: 1 }],
      },
    ],
  });

  const context = {
    scope: accountScope,
    planId: "plan:weight",
  };
  const reservation = await limiter.beforeRequest(context);
  if (!reservation) {
    throw new Error("expected rate limit reservation");
  }

  now = 1_000;
  limiter.afterResponse(context, {
    status: 200,
    usage: {
      weight: {
        "1s": 9,
      },
    },
    reservation,
  });

  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:weight",
      used: 0,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }),
  ]);
});

test("BudgetRateLimiter treats lower header usage without a reservation after a local boundary as a new window", async () => {
  let now = 100;
  const limiter = new BudgetRateLimiter({
    now: () => now,
    utilizationTarget: 1,
  });
  limiter.registerRateLimitTopology({
    id: "header-rollover-test",
    buckets: [
      {
        id: "bucket:weight",
        kind: "request_weight",
        limit: 10,
        intervalMs: 1_000,
        scope: ["venue"],
      },
    ],
    plans: [
      {
        id: "plan:weight",
        costs: [{ bucketId: "bucket:weight", cost: 1 }],
      },
    ],
  });

  const context = {
    scope: accountScope,
    planId: "plan:weight",
  };
  const reservation = await limiter.beforeRequest(context);
  if (!reservation) {
    throw new Error("expected rate limit reservation");
  }

  limiter.afterResponse(context, {
    status: 200,
    usage: {
      weight: {
        "1s": 8,
      },
    },
    reservation,
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      used: 8,
      windowStartMs: 0,
    }),
  ]);

  now = 1_000;
  limiter.afterResponse(context, {
    status: 200,
    usage: {
      weight: {
        "1s": 1,
      },
    },
  });

  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      used: 1,
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    }),
  ]);
});

test("BudgetRateLimiter refunds only requestNotSent reservations", async () => {
  const limiter = new BudgetRateLimiter({
    now: () => 100,
    utilizationTarget: 1,
  });
  limiter.registerRateLimitTopology({
    id: "refund-test",
    buckets: [
      {
        id: "bucket:orders",
        kind: "orders",
        limit: 10,
        intervalMs: 1_000,
        scope: ["venue", "account"],
      },
    ],
    plans: [
      {
        id: "plan:orders",
        costs: [{ bucketId: "bucket:orders", cost: 3 }],
      },
    ],
  });

  const context = {
    scope: accountScope,
    planId: "plan:orders",
  };
  const refunded = await limiter.beforeRequest(context);
  if (!refunded) {
    throw new Error("expected rate limit reservation");
  }
  limiter.onTransportError(context, {
    requestNotSent: true,
    reservation: refunded,
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:orders",
      used: 0,
    }),
  ]);

  const retained = await limiter.beforeRequest(context);
  if (!retained) {
    throw new Error("expected rate limit reservation");
  }
  limiter.onTransportError(context, {
    reservation: retained,
  });
  expect(limiter.getSnapshot(accountScope)?.buckets).toEqual([
    expect.objectContaining({
      bucketId: "bucket:orders",
      used: 3,
    }),
  ]);
});

test("BudgetRateLimiter keeps account-scoped order budgets isolated", async () => {
  let now = 100;
  const sleeps: number[] = [];
  const limiter = new BudgetRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    utilizationTarget: 1,
  });
  limiter.registerRateLimitTopology({
    id: "account-scope-budget-test",
    buckets: [
      {
        id: "bucket:orders",
        kind: "orders",
        limit: 1,
        intervalMs: 1_000,
        scope: ["venue", "account"],
      },
    ],
    plans: [
      {
        id: "plan:orders",
        costs: [{ bucketId: "bucket:orders", cost: 1 }],
      },
    ],
  });

  const accountA = {
    scope: {
      ...accountScope,
      accountId: "account-a",
    },
    planId: "plan:orders",
  };
  const accountB = {
    scope: {
      ...accountScope,
      accountId: "account-b",
    },
    planId: "plan:orders",
  };

  expect(await limiter.beforeRequest(accountA)).toBeDefined();
  expect(await limiter.beforeRequest(accountB)).toBeDefined();
  expect(sleeps).toEqual([]);

  expect(await limiter.beforeRequest(accountA)).toBeDefined();
  expect(sleeps).toEqual([900]);
});

test("Binance topology uses semantic plans for host and openOrders variants", () => {
  expect(BINANCE_RATE_LIMIT_TOPOLOGY.buckets).toContainEqual(
    expect.objectContaining({
      id: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
      reserve: {
        priority: "cancel",
        units: 300,
      },
    }),
  );
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
