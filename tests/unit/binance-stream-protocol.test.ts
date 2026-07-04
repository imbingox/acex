import { expect, test } from "bun:test";
import type { BinanceMarketDefinition } from "../../src/adapters/binance/market-catalog.ts";
import { BinanceStreamProtocol } from "../../src/adapters/binance/stream-protocol.ts";

const binanceUsdmMarket: BinanceMarketDefinition = {
  venue: "binance",
  family: "usdm",
  symbol: "BTC/USDT:USDT",
  id: "BTCUSDT",
  type: "swap",
  base: "BTC",
  quote: "USDT",
  settle: "USDT",
  active: true,
  contract: true,
  linear: true,
  contractSize: "1",
  pricePrecision: 1,
  amountPrecision: 3,
  priceStep: "0.1",
  amountStep: "0.001",
  raw: {},
};

test("BinanceStreamProtocol routes funding only for markPriceUpdate events", () => {
  const protocol = new BinanceStreamProtocol();

  expect(protocol.routeMessage({ s: "BTCUSDT", r: "0.00010000" })).toEqual({
    kind: "ignore",
  });
  expect(
    protocol.routeMessage({
      e: "markPriceUpdate",
      s: "BTCUSDT",
      r: "0.00010000",
    }),
  ).toMatchObject({
    kind: "data",
    subscriptionKey: "fundingRate:BTCUSDT",
    payload: {
      channel: "fundingRate",
      fundingRate: "0.00010000",
    },
  });
});

test("BinanceStreamProtocol applies periodic reconnect liveness only to funding rate streams", () => {
  const protocol = new BinanceStreamProtocol();

  expect(
    protocol.livenessPolicy({
      channel: "fundingRate",
      market: binanceUsdmMarket,
    }),
  ).toEqual({
    kind: "periodic",
    onStale: "reconnect",
  });
  expect(
    protocol.livenessPolicy({
      channel: "l1book",
      market: binanceUsdmMarket,
    }),
  ).toBeUndefined();
});
