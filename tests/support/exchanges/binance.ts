import { stopAllClientsForTests } from "../../../src/client/runtime.ts";
import { FakeWebSocket, jsonResponse, textResponse } from "../test-utils.ts";
import {
  DERIBIT_GET_INSTRUMENTS_URL,
  deribitInstrumentsResponse,
} from "./deribit.ts";

const SPOT_EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo";
const USDM_EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COINM_EXCHANGE_INFO_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const USDM_SERVER_TIME_URL = "https://fapi.binance.com/fapi/v1/time";
const USDM_AGG_TRADES_URL = "https://fapi.binance.com/fapi/v1/aggTrades";
const USDM_HISTORICAL_TRADES_URL =
  "https://fapi.binance.com/fapi/v1/historicalTrades";
const USDM_FUNDING_RATE_URL = "https://fapi.binance.com/fapi/v1/fundingRate";
const PAPI_REST_BASE_URL = "https://papi.binance.com";

export const BINANCE_SPOT_WS_BASE_URL = "wss://stream.binance.com:9443/ws";
export const BINANCE_USDM_WS_BASE_URL = "wss://fstream.binance.com/ws";
export const BINANCE_USDM_MARKET_WS_BASE_URL =
  "wss://fstream.binance.com/market/ws";
export const BINANCE_COINM_WS_BASE_URL = "wss://dstream.binance.com/ws";
export const PAPI_LISTEN_KEY = "test-listen-key";
export function papiAccountWsUrl(listenKey = PAPI_LISTEN_KEY): string {
  return `wss://fstream.binance.com/pm/ws/${listenKey}`;
}
export const PAPI_ACCOUNT_WS_URL = papiAccountWsUrl();

interface BinanceControlFrame {
  readonly method?: string;
  readonly params?: string[];
}

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
        symbol: "AAPLUSDT",
        status: "TRADING",
        contractType: "TRADIFI_PERPETUAL",
        deliveryDate: Date.UTC(2100, 11, 25),
        baseAsset: "AAPL",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        pricePrecision: 5,
        quantityPrecision: 2,
        underlyingType: "EQUITY",
        underlyingSubType: ["TradFi"],
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.01000",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "0.01",
            stepSize: "0.01",
          },
          {
            filterType: "MIN_NOTIONAL",
            notional: "5",
          },
        ],
      },
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
      {
        symbol: "BTCUSDT_250627",
        status: "TRADING",
        contractType: "CURRENT_QUARTER",
        deliveryDate: Date.UTC(2025, 5, 27),
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
      {
        symbol: "BTCUSDC",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "BTC",
        quoteAsset: "USDC",
        marginAsset: "USDC",
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
      {
        symbol: "1000SHIBUSDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "1000SHIB",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        pricePrecision: 6,
        quantityPrecision: 0,
        filters: [
          {
            filterType: "PRICE_FILTER",
            tickSize: "0.000001",
          },
          {
            filterType: "LOT_SIZE",
            minQty: "1",
            stepSize: "1",
          },
          {
            filterType: "MIN_NOTIONAL",
            minNotional: "5",
          },
        ],
      },
      {
        symbol: "ETHUSDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        deliveryDate: 0,
        baseAsset: "ETH",
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
      actualEquity: "1300.50",
      accountInitialMargin: "120.10",
      accountMaintMargin: "45.20",
      uniMMR: "31.0",
      accountStatus: "NORMAL",
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
        notional: "1010.002",
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
    commissionRate: {
      symbol: "BTCUSDT",
      makerCommissionRate: "0.00020000",
      takerCommissionRate: "0.00050000",
    },
    leverageBrackets: [
      {
        symbol: "BTCUSDT",
        notionalCoef: "1.5000",
        brackets: [
          {
            bracket: 1,
            initialLeverage: 125,
            notionalFloor: "0",
            notionalCap: "50000",
            maintMarginRatio: "0.0040",
            cum: "0",
          },
          {
            bracket: 2,
            initialLeverage: 50,
            notionalFloor: "50000",
            notionalCap: "250000",
            maintMarginRatio: "0.0050",
            cum: "50",
          },
        ],
      },
      {
        symbol: "ETHUSDT",
        brackets: [
          {
            bracket: 1,
            initialLeverage: 100,
            notionalFloor: "0",
            notionalCap: "25000",
            maintMarginRatio: "0.0050",
            cum: "0",
          },
        ],
      },
    ],
    leverageUpdate: {
      symbol: "BTCUSDT",
      leverage: 4,
      maxNotionalValue: "500000",
    },
  },
  publicTrades: {
    aggTrades: [
      {
        a: 9000,
        p: "102000.10",
        q: "0.010",
        f: 1000,
        l: 1002,
        T: 1710000000000,
        m: false,
      },
    ],
    rawTrades: [
      {
        id: 1000,
        price: "102000.10",
        qty: "0.010",
        quoteQty: "1020.001",
        time: 1710000000000,
        isBuyerMaker: false,
      },
      {
        id: 1001,
        price: "102000.20",
        qty: "0.020",
        quoteQty: "2040.004",
        time: 1710000000100,
        isBuyerMaker: true,
      },
      {
        id: 1002,
        price: "102000.30",
        qty: "0.030",
        quoteQty: "3060.009",
        time: 1710000000200,
        isBuyerMaker: false,
      },
    ],
  },
  fundingRateHistory: [
    {
      symbol: "BTCUSDT",
      fundingRate: "0.00010000",
      fundingTime: 1710000000000,
      markPrice: "102000.10",
    },
    {
      symbol: "BTCUSDT",
      fundingRate: "-0.00020000",
      fundingTime: 1710028800000,
      markPrice: "101500.00",
    },
  ],
};

function parseControlFrame(frame: string): BinanceControlFrame | undefined {
  try {
    const parsed = JSON.parse(frame) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const params = Array.isArray(record.params)
      ? record.params.filter(
          (param): param is string => typeof param === "string",
        )
      : undefined;

    return {
      method: typeof record.method === "string" ? record.method : undefined,
      params,
    };
  } catch {
    return undefined;
  }
}

export async function waitForBinanceControlFrame(
  socket: FakeWebSocket,
  method: "SUBSCRIBE" | "UNSUBSCRIBE",
  streams: string[],
  timeoutMs = 300,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const frame of socket.sentFrames) {
      const parsed = parseControlFrame(frame);
      if (
        parsed?.method === method &&
        streams.every((stream) => parsed.params?.includes(stream))
      ) {
        return;
      }
    }

    await Bun.sleep(1);
  }

  throw new Error(
    `Timed out waiting for Binance ${method} frame containing ${streams.join(", ")}`,
  );
}

export function installBinanceMarketInfra(): void {
  stopAllClientsForTests();
  FakeWebSocket.reset();

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const parsed = new URL(url);
      const endpoint = `${parsed.origin}${parsed.pathname}`;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );

      if (endpoint === DERIBIT_GET_INSTRUMENTS_URL) {
        return deribitInstrumentsResponse(
          parsed.searchParams.get("currency") ?? "",
        );
      }

      if (endpoint === USDM_AGG_TRADES_URL) {
        return jsonResponse(binanceFixtures.publicTrades.aggTrades);
      }

      if (endpoint === USDM_HISTORICAL_TRADES_URL) {
        if (headers.get("X-MBX-APIKEY") !== "market-key") {
          return textResponse('{"code":-2015,"msg":"Invalid API-key"}', {
            status: 401,
            statusText: "Unauthorized",
          });
        }

        const fromId = Number(parsed.searchParams.get("fromId") ?? "0");
        const limit = Number(parsed.searchParams.get("limit") ?? "500");
        return jsonResponse(
          binanceFixtures.publicTrades.rawTrades
            .filter((trade) => trade.id >= fromId)
            .slice(0, limit),
        );
      }

      if (endpoint === USDM_FUNDING_RATE_URL) {
        const limit = Number(parsed.searchParams.get("limit") ?? "100");
        return jsonResponse(binanceFixtures.fundingRateHistory.slice(0, limit));
      }

      switch (url) {
        case SPOT_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.spot);
        case USDM_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.usdm);
        case COINM_EXCHANGE_INFO_URL:
          return jsonResponse(binanceFixtures.coinm);
        case USDM_SERVER_TIME_URL:
          return jsonResponse({ serverTime: 1710000000123 });
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
  rateLimitBootstrap?: boolean;
  banBootstrap?: boolean;
  failOpenOrders?: boolean;
  rateLimitOpenOrders?: boolean;
  banOpenOrders?: boolean;
  failCreateOrder?: boolean;
  failCancelOrder?: boolean;
  failCancelAllOrders?: boolean;
  balance?: unknown;
  balanceResponses?: unknown[];
  balanceDelayMs?: number;
  account?: unknown;
  accountResponses?: unknown[];
  accountDelayMs?: number;
  umPositions?: unknown;
  umPositionResponses?: unknown[];
  umPositionDelayMs?: number;
  openOrders?: unknown;
  openOrderResponses?: unknown[];
  openOrdersDelayMs?: number;
  marginOpenOrders?: unknown;
  marginOpenOrderResponses?: unknown[];
  queryOrder?: unknown;
  marginQueryOrder?: unknown;
  queryOrderResponses?: unknown[];
  commissionRate?: unknown;
  beforeCommissionRateResponse?: () => void;
  failCommissionRate?: boolean;
  leverageBrackets?: unknown;
  leverageBracketResponses?: unknown[];
  failLeverageBracket?: boolean;
  leverageUpdate?: unknown;
  failSetLeverage?: boolean;
  failQueryOrder?: boolean;
  networkErrorQueryOrder?: boolean;
  networkErrorQueryOrderCount?: number;
  createOrder?: unknown;
  marginCreateOrder?: unknown;
  createOrderDelayMs?: number;
  cancelOrder?: unknown;
  marginCancelOrder?: unknown;
  listenKeys?: string[];
  failListenKeyKeepAliveCount?: number;
}): FetchRequestRecord[] {
  const requests: FetchRequestRecord[] = [];

  stopAllClientsForTests();
  FakeWebSocket.reset();

  let accountRequestCount = 0;
  let umPositionRequestCount = 0;
  let balanceRequestCount = 0;
  let openOrdersRequestCount = 0;
  let marginOpenOrdersRequestCount = 0;
  let queryOrderRequestCount = 0;
  let leverageBracketRequestCount = 0;
  let listenKeyRequestCount = 0;
  let listenKeyKeepAliveFailureCount = 0;

  const nextResponse = (
    responses: unknown[] | undefined,
    fallback: unknown,
    index: number,
  ): unknown =>
    responses?.[index] ?? responses?.[responses.length - 1] ?? fallback;
  const filterOpenOrdersBySymbol = (
    response: unknown,
    symbol: string | null,
  ): unknown => {
    if (!symbol || !Array.isArray(response)) {
      return response;
    }

    return response.filter((order) => {
      if (!order || typeof order !== "object" || Array.isArray(order)) {
        return false;
      }

      return (order as { symbol?: unknown }).symbol === symbol;
    });
  };
  const filterLeverageBracketsBySymbol = (
    response: unknown,
    symbol: string | null,
  ): unknown => {
    if (!symbol || !Array.isArray(response)) {
      return response;
    }

    return response.filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }

      return (entry as { symbol?: unknown }).symbol === symbol;
    });
  };

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

      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(binanceFixtures.usdm);
      }
      if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
        return jsonResponse(binanceFixtures.spot);
      }
      if (url.toString() === USDM_SERVER_TIME_URL) {
        return jsonResponse({ serverTime: 1710000000123 });
      }

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

      if (options?.rateLimitBootstrap && url.pathname === "/papi/v1/account") {
        return textResponse('{"code":-1003,"msg":"Too many requests"}', {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": "2",
            "X-MBX-USED-WEIGHT-1m": "1200",
          },
        });
      }

      if (options?.banBootstrap && url.pathname === "/papi/v1/account") {
        return textResponse('{"code":-1003,"msg":"IP banned"}', {
          status: 418,
          statusText: "I'm a teapot",
          headers: {
            "Retry-After": "60",
            "X-MBX-USED-WEIGHT-1m": "1400",
          },
        });
      }

      if (
        options?.failOpenOrders &&
        `${method} ${url.pathname}` === "GET /papi/v1/um/openOrders"
      ) {
        return textResponse('{"code":-2015,"msg":"Invalid API-key"}', {
          status: 401,
          statusText: "Unauthorized",
        });
      }

      if (
        options?.rateLimitOpenOrders &&
        `${method} ${url.pathname}` === "GET /papi/v1/um/openOrders"
      ) {
        return textResponse('{"code":-1003,"msg":"Too many requests"}', {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": "2",
            "X-MBX-ORDER-COUNT-10S": "50",
          },
        });
      }

      if (
        options?.banOpenOrders &&
        `${method} ${url.pathname}` === "GET /papi/v1/um/openOrders"
      ) {
        return textResponse('{"code":-1003,"msg":"IP banned"}', {
          status: 418,
          statusText: "I'm a teapot",
          headers: {
            "Retry-After": "60",
            "X-MBX-ORDER-COUNT-10S": "55",
          },
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
          if (options?.balanceDelayMs) {
            await Bun.sleep(options.balanceDelayMs);
          }
          return jsonResponse(
            nextResponse(
              options?.balanceResponses,
              options?.balance ?? binanceFixtures.papi.balance,
              balanceRequestCount++,
            ),
          );
        case "GET /papi/v1/account":
          if (options?.accountDelayMs) {
            await Bun.sleep(options.accountDelayMs);
          }
          return jsonResponse(
            nextResponse(
              options?.accountResponses,
              options?.account ?? binanceFixtures.papi.account,
              accountRequestCount++,
            ),
          );
        case "GET /papi/v1/um/positionRisk":
          if (options?.umPositionDelayMs) {
            await Bun.sleep(options.umPositionDelayMs);
          }
          return jsonResponse(
            nextResponse(
              options?.umPositionResponses,
              options?.umPositions ?? binanceFixtures.papi.umPositions,
              umPositionRequestCount++,
            ),
          );
        case "GET /papi/v1/um/openOrders":
          if (options?.openOrdersDelayMs) {
            await Bun.sleep(options.openOrdersDelayMs);
          }
          return jsonResponse(
            filterOpenOrdersBySymbol(
              nextResponse(
                options?.openOrderResponses,
                options?.openOrders ?? binanceFixtures.papi.openOrders,
                openOrdersRequestCount++,
              ),
              url.searchParams.get("symbol"),
            ),
          );
        case "GET /papi/v1/margin/openOrders":
          return jsonResponse(
            filterOpenOrdersBySymbol(
              nextResponse(
                options?.marginOpenOrderResponses,
                options?.marginOpenOrders ?? [],
                marginOpenOrdersRequestCount++,
              ),
              url.searchParams.get("symbol"),
            ),
          );
        case "GET /papi/v1/um/order":
          if (
            options?.networkErrorQueryOrder ||
            (options?.networkErrorQueryOrderCount !== undefined &&
              queryOrderRequestCount < options.networkErrorQueryOrderCount)
          ) {
            queryOrderRequestCount += 1;
            throw new TypeError("fetch failed");
          }
          if (options?.failQueryOrder) {
            return textResponse(
              '{"code":-2013,"msg":"Order does not exist."}',
              {
                status: 400,
                statusText: "Bad Request",
              },
            );
          }
          return jsonResponse(
            nextResponse(
              options?.queryOrderResponses,
              options?.queryOrder ?? {
                symbol: "BTCUSDT",
                orderId: 1001,
                clientOrderId: "cid-1001",
                side: "BUY",
                type: "LIMIT",
                status: "FILLED",
                price: "100500.00",
                stopPrice: "0",
                origQty: "0.020",
                executedQty: "0.020",
                avgPrice: "100450.00",
                reduceOnly: false,
                positionSide: "BOTH",
                updateTime: 1710000000500,
              },
              queryOrderRequestCount++,
            ),
          );
        case "GET /papi/v1/margin/order":
          return jsonResponse(
            options?.marginQueryOrder ?? {
              symbol: "BTCUSDT",
              orderId: 3001,
              clientOrderId: "cid-margin-3001",
              side: "BUY",
              type: "LIMIT",
              status: "FILLED",
              price: "100000.00",
              origQty: "0.010",
              executedQty: "0.010",
              cummulativeQuoteQty: "1000.00",
              updateTime: 1710000000550,
            },
          );
        case "GET /papi/v1/um/commissionRate":
          if (options?.failCommissionRate) {
            return textResponse('{"code":-2015,"msg":"Invalid API-key"}', {
              status: 401,
              statusText: "Unauthorized",
            });
          }
          options?.beforeCommissionRateResponse?.();
          return jsonResponse(
            options?.commissionRate ?? binanceFixtures.papi.commissionRate,
          );
        case "GET /papi/v1/um/leverageBracket":
          if (options?.failLeverageBracket) {
            return textResponse('{"code":-2015,"msg":"Invalid API-key"}', {
              status: 401,
              statusText: "Unauthorized",
            });
          }
          return jsonResponse(
            filterLeverageBracketsBySymbol(
              nextResponse(
                options?.leverageBracketResponses,
                options?.leverageBrackets ??
                  binanceFixtures.papi.leverageBrackets,
                leverageBracketRequestCount++,
              ),
              url.searchParams.get("symbol"),
            ),
          );
        case "POST /papi/v1/um/order":
          if (options?.createOrderDelayMs) {
            await Bun.sleep(options.createOrderDelayMs);
          }
          return jsonResponse(
            options?.createOrder ?? {
              symbol: "BTCUSDT",
              orderId: 2001,
              clientOrderId:
                url.searchParams.get("newClientOrderId") ?? "cid-2001",
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
        case "POST /papi/v1/margin/order":
          return jsonResponse(
            options?.marginCreateOrder ?? {
              symbol: "BTCUSDT",
              orderId: 3001,
              clientOrderId:
                url.searchParams.get("newClientOrderId") ?? "cid-margin-3001",
              side: "BUY",
              type: "LIMIT",
              status: "NEW",
              price: "101000.00",
              origQty: "0.010",
              executedQty: "0",
              cummulativeQuoteQty: "0",
              transactTime: 1710000000450,
            },
          );
        case "POST /papi/v1/um/leverage":
          if (options?.failSetLeverage) {
            return textResponse(
              '{"code":-2027,"msg":"Exceeded the maximum allowable position at current leverage."}',
              {
                status: 400,
                statusText: "Bad Request",
              },
            );
          }
          {
            const leverageUpdate =
              options?.leverageUpdate &&
              typeof options.leverageUpdate === "object"
                ? (options.leverageUpdate as Record<string, unknown>)
                : binanceFixtures.papi.leverageUpdate;
            return jsonResponse({
              ...leverageUpdate,
              leverage: url.searchParams.get("leverage") ?? 4,
            });
          }
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
        case "DELETE /papi/v1/margin/order":
          return jsonResponse(
            options?.marginCancelOrder ?? {
              symbol: "BTCUSDT",
              orderId: 3001,
              clientOrderId: "cid-margin-3001",
              side: "BUY",
              type: "LIMIT",
              status: "CANCELED",
              price: "100000.00",
              origQty: "0.010",
              executedQty: "0",
              cummulativeQuoteQty: "0",
              updateTime: 1710000000360,
            },
          );
        case "DELETE /papi/v1/um/allOpenOrders":
          return jsonResponse({
            code: 200,
            msg: "The operation of cancel all open order is done.",
          });
        case "DELETE /papi/v1/margin/allOpenOrders":
          return jsonResponse({
            code: 200,
            msg: "The operation of cancel all margin open order is done.",
          });
        case "POST /papi/v1/listenKey":
          return jsonResponse({
            listenKey: nextResponse(
              options?.listenKeys,
              PAPI_LISTEN_KEY,
              listenKeyRequestCount++,
            ),
          });
        case "PUT /papi/v1/listenKey":
          if (
            listenKeyKeepAliveFailureCount <
            (options?.failListenKeyKeepAliveCount ?? 0)
          ) {
            listenKeyKeepAliveFailureCount += 1;
            return textResponse('{"code":-1001,"msg":"Internal error"}', {
              status: 500,
              statusText: "Internal Server Error",
            });
          }
          return jsonResponse({});
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
