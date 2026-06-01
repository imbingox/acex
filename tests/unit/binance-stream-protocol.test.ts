import { expect, test } from "bun:test";
import { BinanceStreamProtocol } from "../../src/adapters/binance/stream-protocol.ts";

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
