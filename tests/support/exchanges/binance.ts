import { stopAllClientsForTests } from "../../../src/client/runtime.ts";
import { FakeWebSocket, jsonResponse, textResponse } from "../test-utils.ts";

const SPOT_EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo";
const USDM_EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COINM_EXCHANGE_INFO_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const PAPI_REST_BASE_URL = "https://papi.binance.com";

export const PAPI_LISTEN_KEY = "test-listen-key";
export const PAPI_ACCOUNT_WS_URL = `wss://fstream.binance.com/pm/ws/${PAPI_LISTEN_KEY}`;

const binanceFixtures = {
  spot: {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.01",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.0001",
            stepSize: "0.0001",
          },
          {
            filterType: "MIN_NOTIONAL",
            minNotional: "10",
          },
        ],
      },
      {
        symbol: "ETHUSDT",
        status: "BREAK",
        baseAsset: "ETH",
        quoteAsset: "USDT",
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.01",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.001",
            stepSize: "0.001",
          },
        ],
      },
    ],
  },
  usdm: {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        pricePrecision: 2,
        quantityPrecision: 3,
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.10",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.001",
            stepSize: "0.001",
          },
          {
            filterType: "MIN_NOTIONAL",
            minNotional: "5",
          },
        ],
      },
    ],
  },
  coinm: {
    symbols: [
      {
        symbol: "BTCUSD_PERP",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "BTC",
        quoteAsset: "USD",
        marginAsset: "BTC",
        contractSize: 100,
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.1",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "1",
            stepSize: "1",
          },
        ],
      },
      {
        symbol: "BTCUSD_250627",
        status: "TRADING",
        contractType: "CURRENT_QUARTER",
        deliveryDate: Date.UTC(2025, 5, 27),
        baseAsset: "BTC",
        quoteAsset: "USD",
        marginAsset: "BTC",
        contractSize: 100,
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.1",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "1",
            stepSize: "1",
          },
        ],
      },
    ],
  },
  papi: {
    balance: [
      {
        asset: "USDT",
        totalWalletBalance: "1250.50",
        crossMarginFree: "1000.25",
        crossMarginLocked: "250.25",
      },
      {
        asset: "BTC",
        totalWalletBalance: "0.0500",
        crossMarginFree: "0.0400",
      },
    ],
    account: {
      accountEquity: "1400.75",
      accountInitialMargin: "120.10",
      accountMaintMargin: "45.20",
      uniMMR: "31.0",
      updateTime: 1710000000100,
    },
    umPositions: [
      {
        symbol: "BTCUSDT",
        positionAmt: "0.010",
        entryPrice: "100000.10",
        markPrice: "101000.20",
        unRealizedProfit: "10.50",
        liquidationPrice: "80000.00",
        leverage: "5",
        positionSide: "BOTH",
        updateTime: 1710000000200,
      },
    ],
    openOrders: [
      {
        symbol: "BTCUSDT",
        orderId: 1001,
        clientOrderId: "cid-1001",
        side: "BUY",
        type: "LIMIT",
        status: "NEW",
        price: "100500.00",
        stopPrice: "0",
        origQty: "0.020",
        executedQty: "0.005",
        avgPrice: "100400.00",
        reduceOnly: false,
        positionSide: "BOTH",
        updateTime: 1710000000300,
      },
    ],
  },
};

export function installBinanceMarketInfra(): void {
  stopAllClientsForTests();
  FakeWebSocket.reset();

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();

      switch (url) {
        case SPOT_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.spot);
        case USDM_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.usdm);
        case COINM_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.coinm);
        default:
          throw new Error(`Unexpected fetch URL: ${url}`);
      }
    },
  });

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
}

export interface FetchRequestRecord {
  method: string;
  url: URL;
  apiKey: string | null;
}

export function installBinancePrivateAccountInfra(options?: {
  failBootstrap?: boolean;
  failCreateOrder?: boolean;
  failCancelOrder?: boolean;
  failCancelAllOrders?: boolean;
  balance?: unknown;
  account?: unknown;
  umPositions?: unknown;
  openOrders?: unknown;
  createOrder?: unknown;
  cancelOrder?: unknown;
  cancelAllOrders?: unknown;
}): FetchRequestRecord[] {
  const requests: FetchRequestRecord[] = [];

  stopAllClientsForTests();
  FakeWebSocket.reset();

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(rawUrl);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );

      requests.push({
        method,
        url,
        apiKey: headers.get("X-MBX-APIKEY"),
      });

      if (url.origin !== PAPI_REST_BASE_URL) {
        throw new Error(`Unexpected fetch URL: ${url.toString()}`);
      }

      if (options?.failBootstrap && url.pathname === "/papi/v1/account") {
        return textResponse('{"code":-2015,"msg":"Invalid API-key"}', {
          status: 401,
          statusText: "Unauthorized",
        });
      }

      if (
        options?.failCreateOrder &&
        `${method} ${url.pathname}` === "POST /papi/v1/um/order"
      ) {
        return textResponse(
          '{"code":-2010,"msg":"Order would immediately trigger."}',
          {
            status: 400,
            statusText: "Bad Request",
          },
        );
      }

      if (
        options?.failCancelOrder &&
        `${method} ${url.pathname}` === "DELETE /papi/v1/um/order"
      ) {
        return textResponse('{"code":-2011,"msg":"Unknown order sent."}', {
          status: 400,
          statusText: "Bad Request",
        });
      }

      if (
        options?.failCancelAllOrders &&
        `${method} ${url.pathname}` === "DELETE /papi/v1/um/allOpenOrders"
      ) {
        return textResponse('{"code":-2011,"msg":"Unknown order sent."}', {
          status: 400,
          statusText: "Bad Request",
        });
      }

      switch (`${method} ${url.pathname}`) {
        case "GET /papi/v1/balance":
          return jsonResponse(options?.balance ?? binanceFixtures.papi.balance);
        case "GET /papi/v1/account":
          return jsonResponse(options?.account ?? binanceFixtures.papi.account);
        case "GET /papi/v1/um/positionRisk":
          return jsonResponse(
            options?.umPositions ?? binanceFixtures.papi.umPositions,
          );
        case "GET /papi/v1/um/openOrders":
          return jsonResponse(
            options?.openOrders ?? binanceFixtures.papi.openOrders,
          );
        case "POST /papi/v1/um/order":
          return jsonResponse(
            options?.createOrder ?? {
              symbol: "BTCUSDT",
              orderId: 2001,
              clientOrderId: "cid-2001",
              side: "BUY",
              type: "LIMIT",
              status: "NEW",
              price: "101000.00",
              stopPrice: "0",
              origQty: "0.010",
              executedQty: "0",
              avgPrice: "0",
              reduceOnly: false,
              positionSide: "BOTH",
              updateTime: 1710000000400,
            },
          );
        case "DELETE /papi/v1/um/order":
          return jsonResponse(
            options?.cancelOrder ?? {
              symbol: "BTCUSDT",
              orderId: 1001,
              clientOrderId: "cid-1001",
              side: "BUY",
              type: "LIMIT",
              status: "CANCELED",
              price: "100500.00",
              stopPrice: "0",
              origQty: "0.020",
              executedQty: "0.005",
              avgPrice: "100400.00",
              reduceOnly: false,
              positionSide: "BOTH",
              updateTime: 1710000000350,
            },
          );
        case "DELETE /papi/v1/um/allOpenOrders":
          return jsonResponse(
            options?.cancelAllOrders ?? [
              {
                symbol: "BTCUSDT",
                orderId: 1001,
                clientOrderId: "cid-1001",
                side: "BUY",
                type: "LIMIT",
                status: "CANCELED",
                price: "100500.00",
                stopPrice: "0",
                origQty: "0.020",
                executedQty: "0.005",
                avgPrice: "100400.00",
                reduceOnly: false,
                positionSide: "BOTH",
                updateTime: 1710000000350,
              },
            ],
          );
        case "POST /papi/v1/listenKey":
          return jsonResponse({ listenKey: PAPI_LISTEN_KEY });
        case "PUT /papi/v1/listenKey":
        case "DELETE /papi/v1/listenKey":
          return jsonResponse({});
        default:
          throw new Error(`Unexpected fetch URL: ${method} ${url.toString()}`);
      }
    },
  });

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  return requests;
}
