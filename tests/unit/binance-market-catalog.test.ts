import { expect, test } from "bun:test";
import {
  BinanceMarketCatalog,
  type BinanceMarketFamily,
} from "../../src/adapters/binance/market-catalog.ts";
import { SymbolMappingError } from "../../src/adapters/types.ts";
import { jsonResponse, textResponse } from "../support/test-utils.ts";

const SPOT_EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo";
const USDM_EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COINM_EXCHANGE_INFO_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";

function filters() {
  return [
    { filterType: "PRICE_FILTER", tickSize: "0.10" },
    { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
    { filterType: "MIN_NOTIONAL", minNotional: "5" },
  ];
}

function spotExchangeInfo() {
  return {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        filters: filters(),
      },
    ],
  };
}

function usdmExchangeInfo(
  includeDelivery = true,
  extraSymbols: unknown[] = [],
) {
  return {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        filters: filters(),
      },
      ...(includeDelivery
        ? [
            {
              symbol: "BTCUSDT_250627",
              status: "TRADING",
              contractType: "CURRENT_QUARTER",
              deliveryDate: Date.UTC(2025, 5, 27),
              baseAsset: "BTC",
              quoteAsset: "USDT",
              marginAsset: "USDT",
              filters: filters(),
            },
          ]
        : []),
      {
        symbol: "BTCUSDC",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "BTC",
        quoteAsset: "USDC",
        marginAsset: "USDC",
        filters: filters(),
      },
      {
        symbol: "1000SHIBUSDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "1000SHIB",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        filters: filters(),
      },
      ...extraSymbols,
    ],
  };
}

function coinmExchangeInfo() {
  return { symbols: [] };
}

function fetchForFamilies(
  requested: string[],
  overrides: Partial<Record<BinanceMarketFamily, () => Promise<Response>>> = {},
) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = input.toString();
    requested.push(url);
    if (url === SPOT_EXCHANGE_INFO_URL) {
      return overrides.spot?.() ?? jsonResponse(spotExchangeInfo());
    }
    if (url === USDM_EXCHANGE_INFO_URL) {
      return overrides.usdm?.() ?? jsonResponse(usdmExchangeInfo());
    }
    if (url === COINM_EXCHANGE_INFO_URL) {
      return overrides.coinm?.() ?? jsonResponse(coinmExchangeInfo());
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("BinanceMarketCatalog maps USDM delivery, multi quote, 1000SHIB, and family-scoped collisions", async () => {
  const requested: string[] = [];
  const catalog = new BinanceMarketCatalog({
    fetchFn: fetchForFamilies(requested),
  });

  await catalog.ensureLoaded("usdm");
  expect(catalog.toUnified("usdm", "BTCUSDT_250627")).toBe(
    "BTC/USDT:USDT-20250627",
  );
  expect(catalog.toVenueId("usdm", "BTC/USDT:USDT-20250627")).toBe(
    "BTCUSDT_250627",
  );
  expect(catalog.toUnified("usdm", "BTCUSDC")).toBe("BTC/USDC:USDC");
  expect(catalog.toVenueId("usdm", "BTC/USDC:USDC")).toBe("BTCUSDC");
  expect(catalog.toUnified("usdm", "1000SHIBUSDT")).toBe("1000SHIB/USDT:USDT");

  await catalog.ensureLoaded("spot");
  expect(catalog.toUnified("spot", "BTCUSDT")).toBe("BTC/USDT");
  expect(catalog.toUnified("usdm", "BTCUSDT")).toBe("BTC/USDT:USDT");
  expect(requested).toEqual([USDM_EXCHANGE_INFO_URL, SPOT_EXCHANGE_INFO_URL]);
});

test("BinanceMarketCatalog loads a single family and coalesces concurrent ensureLoaded calls", async () => {
  const requested: string[] = [];
  let usdmRequests = 0;
  const catalog = new BinanceMarketCatalog({
    fetchFn: fetchForFamilies(requested, {
      usdm: async () => {
        usdmRequests += 1;
        await Bun.sleep(5);
        return jsonResponse(usdmExchangeInfo());
      },
      spot: async () => {
        throw new Error("spot must not load for usdm ensureLoaded");
      },
      coinm: async () => {
        throw new Error("coinm must not load for usdm ensureLoaded");
      },
    }),
  });

  await Promise.all([
    catalog.ensureLoaded("usdm"),
    catalog.ensureLoaded("usdm"),
    catalog.ensureLoaded("usdm"),
  ]);

  expect(usdmRequests).toBe(1);
  expect(requested).toEqual([USDM_EXCHANGE_INFO_URL]);
});

test("BinanceMarketCatalog loadAll refreshes already loaded families", async () => {
  let includeExtra = false;
  let usdmRequests = 0;
  const catalog = new BinanceMarketCatalog({
    fetchFn: fetchForFamilies([], {
      usdm: async () => {
        usdmRequests += 1;
        return jsonResponse(
          usdmExchangeInfo(true, includeExtra ? [newUsdmExtraSymbol()] : []),
        );
      },
    }),
  });

  await catalog.ensureLoaded("usdm");
  includeExtra = true;
  await catalog.loadAll();

  expect(usdmRequests).toBe(2);
  expect(catalog.toUnified("usdm", "ETHUSDT")).toBe("ETH/USDT:USDT");
});

function newUsdmExtraSymbol() {
  return {
    symbol: "ETHUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    deliveryDate: 0,
    baseAsset: "ETH",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    filters: filters(),
  };
}

test("BinanceMarketCatalog keeps the previous family map when refresh fails and reports once", async () => {
  const runtimeErrors: Error[] = [];
  let usdmRequests = 0;
  const catalog = new BinanceMarketCatalog({
    publishRuntimeError: (_source, error) => {
      runtimeErrors.push(error);
    },
    fetchFn: fetchForFamilies([], {
      usdm: async () => {
        usdmRequests += 1;
        return usdmRequests === 1
          ? jsonResponse(usdmExchangeInfo())
          : textResponse("binance down", {
              status: 503,
              statusText: "Service Unavailable",
            });
      },
    }),
  });

  await catalog.ensureLoaded("usdm");
  await expect(catalog.refreshFamily("usdm")).rejects.toThrow();
  await expect(catalog.refreshFamily("usdm")).rejects.toThrow();

  expect(catalog.toUnified("usdm", "BTCUSDT")).toBe("BTC/USDT:USDT");
  expect(runtimeErrors).toHaveLength(1);
  expect(runtimeErrors[0]?.message).toContain("Failed to load Binance usdm");
});

test("BinanceMarketCatalog retains bounded delivery tombstones after exchangeInfo removal", async () => {
  let includeDelivery = true;
  const catalog = new BinanceMarketCatalog({
    fetchFn: fetchForFamilies([], {
      usdm: async () => jsonResponse(usdmExchangeInfo(includeDelivery)),
    }),
  });

  await catalog.ensureLoaded("usdm");
  includeDelivery = false;
  await catalog.refreshFamily("usdm");

  expect(catalog.toUnified("usdm", "BTCUSDT_250627")).toBe(
    "BTC/USDT:USDT-20250627",
  );
  expect(catalog.toVenueId("usdm", "BTC/USDT:USDT-20250627")).toBe(
    "BTCUSDT_250627",
  );
});

test("BinanceMarketCatalog throws typed SymbolMappingError for command-side misses", async () => {
  const catalog = new BinanceMarketCatalog({
    fetchFn: fetchForFamilies([]),
  });
  await catalog.ensureLoaded("usdm");

  expect(() => catalog.toVenueId("usdm", "DOGE/USDT:USDT")).toThrow(
    SymbolMappingError,
  );
});
