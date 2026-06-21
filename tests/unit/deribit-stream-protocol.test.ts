import { expect, test } from "bun:test";
import { normalizeDeribitOptionInstrument } from "../../src/adapters/deribit/market-catalog.ts";
import { DeribitStreamProtocol } from "../../src/adapters/deribit/stream-protocol.ts";
import { deribitFixtures } from "../support/exchanges/deribit.ts";

const market = normalizeDeribitOptionInstrument(
  deribitFixtures.instruments.BTC[0],
);

test("Deribit stream protocol encodes quote subscriptions", () => {
  const protocol = new DeribitStreamProtocol();
  const frame = JSON.parse(
    protocol.encodeSubscribe([{ channel: "l1book", market }]),
  ) as Record<string, unknown>;

  expect(frame).toMatchObject({
    jsonrpc: "2.0",
    method: "public/subscribe",
    params: {
      channels: ["quote.BTC-21JUN26-57000-C"],
    },
    id: 1,
  });
  expect(protocol.subscriptionKey({ channel: "l1book", market })).toBe(
    "l1book:BTC-21JUN26-57000-C",
  );
});

test("Deribit stream protocol routes complete quote payloads as L1 data", () => {
  const protocol = new DeribitStreamProtocol();
  const routed = protocol.routeMessage({
    method: "subscription",
    params: {
      channel: "quote.BTC-21JUN26-57000-C",
      data: {
        timestamp: 1710000000001,
        best_bid_price: 0.101,
        best_bid_amount: 2,
        best_ask_price: 0.102,
        best_ask_amount: 3,
      },
    },
  });

  expect(routed).toEqual({
    kind: "data",
    subscriptionKey: "l1book:BTC-21JUN26-57000-C",
    payload: {
      channel: "l1book",
      bidPrice: "0.101",
      bidSize: "2",
      askPrice: "0.102",
      askSize: "3",
      exchangeTs: 1710000000001,
    },
  });
});

test("Deribit stream protocol canonicalizes scientific notation quote decimals", () => {
  const protocol = new DeribitStreamProtocol();
  const routed = protocol.routeMessage({
    method: "subscription",
    params: {
      channel: "quote.BTC-21JUN26-57000-C",
      data: {
        timestamp: 1710000000001,
        best_bid_price: 1e-8,
        best_bid_amount: 2e-7,
        best_ask_price: "1.10e-8",
        best_ask_amount: "3.00e-7",
      },
    },
  });

  expect(routed).toEqual({
    kind: "data",
    subscriptionKey: "l1book:BTC-21JUN26-57000-C",
    payload: {
      channel: "l1book",
      bidPrice: "0.00000001",
      bidSize: "0.0000002",
      askPrice: "0.000000011",
      askSize: "0.0000003",
      exchangeTs: 1710000000001,
    },
  });
});

test("Deribit stream protocol routes missing or non-positive quote as no_quote status", () => {
  const protocol = new DeribitStreamProtocol();

  for (const data of [
    {
      timestamp: 1710000000002,
      best_bid_price: null,
      best_bid_amount: 2,
      best_ask_price: 0.102,
      best_ask_amount: 3,
    },
    {
      timestamp: 1710000000003,
      best_bid_price: 0.101,
      best_bid_amount: 0,
      best_ask_price: 0.102,
      best_ask_amount: 3,
    },
    {
      timestamp: 1710000000004,
      best_bid_price: Number.POSITIVE_INFINITY,
      best_bid_amount: 2,
      best_ask_price: 0.102,
      best_ask_amount: 3,
    },
  ]) {
    const routed = protocol.routeMessage({
      method: "subscription",
      params: {
        channel: "quote.BTC-21JUN26-57000-C",
        data,
      },
    });

    expect(routed).toMatchObject({
      kind: "status",
      subscriptionKey: "l1book:BTC-21JUN26-57000-C",
      payload: {
        channel: "l1book",
        reason: "no_quote",
        exchangeTs: data.timestamp,
      },
    });
  }
});
