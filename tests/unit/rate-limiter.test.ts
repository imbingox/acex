import { expect, test } from "bun:test";
import { parseBinanceRateLimitUsage } from "../../src/adapters/binance/rate-limit.ts";
import { ReactiveRateLimiter } from "../../src/internal/rate-limiter.ts";
import type { RateLimitScope } from "../../src/types/index.ts";

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
