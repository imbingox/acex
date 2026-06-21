import { expect, test } from "bun:test";
import { BigNumber } from "../../index.ts";
import {
  loadDeribitOptionMarkets,
  normalizeDeribitOptionInstrument,
  normalizeDeribitUnderlyings,
} from "../../src/adapters/deribit/market-catalog.ts";
import { deribitFixtures } from "../support/exchanges/deribit.ts";
import { jsonResponse, textResponse } from "../support/test-utils.ts";

test("Deribit option catalog normalization exposes stable option market fields", () => {
  const market = normalizeDeribitOptionInstrument(
    deribitFixtures.instruments.BTC[0],
  );

  expect(market).toMatchObject({
    venue: "deribit",
    symbol: "BTC/USD:BTC-20260621-57000-C",
    id: "BTC-21JUN26-57000-C",
    type: "option",
    base: "BTC",
    quote: "USD",
    underlying: "BTC",
    strike: "57000",
    strikeCurrency: "USD",
    optionType: "call",
    premiumCurrency: "BTC",
    settle: "BTC",
    active: true,
    contract: true,
    inverse: true,
    linear: false,
    contractSize: "1",
    priceStep: new BigNumber("0.0005").toFixed(),
    amountStep: new BigNumber("0.1").toFixed(),
    minAmount: new BigNumber("0.1").toFixed(),
    pricePrecision: 4,
    amountPrecision: 1,
  });
  expect(market.raw.tick_size_steps).toEqual([
    { above_price: 0.2, tick_size: 0.001 },
  ]);
});

test("Deribit active flag combines is_active and optional state", () => {
  const closed = normalizeDeribitOptionInstrument(
    deribitFixtures.instruments.BTC[3],
  );
  const noState = normalizeDeribitOptionInstrument({
    ...deribitFixtures.instruments.BTC[0],
    state: undefined,
  });

  expect(closed.active).toBe(false);
  expect(noState.active).toBe(true);
});

test("Deribit underlyings are normalized and empty input is rejected", () => {
  expect(normalizeDeribitUnderlyings([" btc ", "ETH", "btc"])).toEqual([
    "BTC",
    "ETH",
  ]);
  expect(() => normalizeDeribitUnderlyings([])).toThrow(
    "underlyings must not be empty",
  );
  expect(() => normalizeDeribitUnderlyings(["  "])).toThrow(
    "underlyings must not be empty",
  );
});

test("Deribit option catalog loads requested underlyings through get_instruments", async () => {
  const requestedCurrencies: string[] = [];
  const markets = await loadDeribitOptionMarkets(
    async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const parsed = new URL(url);
      const currency = parsed.searchParams.get("currency") ?? "";
      requestedCurrencies.push(currency);
      return jsonResponse({
        jsonrpc: "2.0",
        result:
          deribitFixtures.instruments[
            currency as keyof typeof deribitFixtures.instruments
          ] ?? [],
      });
    },
    { underlyings: [" eth ", "BTC", "ETH"] },
  );

  expect(requestedCurrencies).toEqual(["ETH", "BTC"]);
  expect(markets.map((market) => market.symbol)).toEqual([
    "BTC/USD:BTC-20260621-57000-C",
    "BTC/USD:BTC-20260621-57000-P",
    "BTC/USD:BTC-20260621-58000-C",
    "BTC/USD:BTC-20260621-59000-P",
    "ETH/USD:ETH-20260621-3000-C",
    "ETH/USD:ETH-20260621-3000-P",
  ]);
});

test("Deribit catalog load fails for unsupported or failed underlyings", async () => {
  await expect(
    loadDeribitOptionMarkets(
      async () => jsonResponse({ jsonrpc: "2.0", result: [] }),
      { underlyings: ["DOGE"] },
    ),
  ).rejects.toThrow("returned no option instruments for DOGE");

  await expect(
    loadDeribitOptionMarkets(
      async () =>
        textResponse("deribit down", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      { underlyings: ["BTC"] },
    ),
  ).rejects.toThrow("Deribit request failed: 503");
});
