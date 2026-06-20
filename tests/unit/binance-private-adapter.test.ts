import { expect, test } from "bun:test";
import { BinanceMarketCatalog } from "../../src/adapters/binance/market-catalog.ts";
import { BinancePrivateAdapter } from "../../src/adapters/binance/private-adapter.ts";
import {
  OrderInputValidationError,
  type RawAccountUpdate,
  type RawRiskLevelChange,
  SymbolMappingError,
} from "../../src/adapters/types.ts";
import { isTransportError } from "../../src/internal/http-client.ts";
import {
  FakeWebSocket,
  jsonResponse,
  textResponse,
  waitForSocket,
} from "../support/test-utils.ts";

const USDM_EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const SPOT_EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo";
const PAPI_REST_BASE_URL = "https://papi.binance.com";
const PAPI_WS_URL = "wss://fstream.binance.com/pm/ws/test-listen-key";

const streamOptions = {
  openTimeoutMs: 100,
  reconnectDelayMs: 1,
  reconnectMaxDelayMs: 1,
  listenKeyKeepAliveMs: 60_000,
  staleAfterMs: 60_000,
};

function usdmExchangeInfo(extraSymbols: unknown[] = []) {
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
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.10" },
          { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
        ],
      },
      ...extraSymbols,
    ],
  };
}

function spotExchangeInfo(extraSymbols: unknown[] = []) {
  return {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.01" },
          { filterType: "LOT_SIZE", minQty: "0.0001", stepSize: "0.0001" },
        ],
      },
      ...extraSymbols,
    ],
  };
}

function newUsdtSymbol() {
  return {
    symbol: "NEWUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    deliveryDate: 0,
    baseAsset: "NEW",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.10" },
      { filterType: "LOT_SIZE", minQty: "1", stepSize: "1" },
    ],
  };
}

function orderTradeUpdate(symbol: string, orderType = "LIMIT") {
  return {
    e: "ORDER_TRADE_UPDATE",
    E: 1710000000000,
    o: {
      s: symbol,
      i: 9001,
      c: "cid-9001",
      S: "BUY",
      o: orderType,
      x: "TRADE",
      X: "FILLED",
      p: "1.00",
      q: "2",
      z: "2",
      ap: "1.00",
      t: 7001,
      l: "2",
      L: "1.00",
      n: "0",
      N: "USDT",
      rp: "0.5",
      m: false,
      ps: "BOTH",
      T: 1710000000100,
    },
  };
}

function successfulOrderResponse(symbol: string) {
  return {
    symbol,
    orderId: 9101,
    clientOrderId: "cid-9101",
    side: "BUY",
    type: "LIMIT",
    status: "NEW",
    price: "1.00",
    stopPrice: "0",
    origQty: "2",
    executedQty: "0",
    avgPrice: "0",
    reduceOnly: false,
    positionSide: "BOTH",
    updateTime: 1710000000200,
  };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 200,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(1);
  }

  throw new Error("Timed out waiting for condition");
}

test("BinancePrivateAdapter safe reads do not retry HTTP failures", async () => {
  const attemptsByPath = new Map<string, number>();
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      attemptsByPath.set(
        url.pathname,
        (attemptsByPath.get(url.pathname) ?? 0) + 1,
      );

      if (url.pathname === "/papi/v1/account") {
        return textResponse("binance down", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }

      return jsonResponse([]);
    },
  });

  const error = await adapter
    .bootstrapAccount({
      apiKey: "key",
      secret: "secret",
    })
    .catch((caught: unknown) => caught);

  expect(attemptsByPath.get("/papi/v1/account")).toBe(1);
  expect(isTransportError(error)).toBe(true);
  if (!isTransportError(error)) {
    throw new Error("Expected TransportError");
  }
  expect(error.attempts).toBe(1);
  expect(error.kind).toBe("http");
});

test("BinancePrivateAdapter normalizes REST open order types and preserves rawType", async () => {
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
        return jsonResponse(spotExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/um/openOrders"
      ) {
        return jsonResponse([
          { ...successfulOrderResponse("BTCUSDT"), orderId: 1, type: "LIMIT" },
          { ...successfulOrderResponse("BTCUSDT"), orderId: 2, type: "MARKET" },
          {
            ...successfulOrderResponse("BTCUSDT"),
            orderId: 3,
            type: "STOP_MARKET",
          },
          {
            ...successfulOrderResponse("BTCUSDT"),
            orderId: 4,
            type: "LIMIT_MAKER",
          },
        ]);
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/margin/openOrders"
      ) {
        return jsonResponse([]);
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });

  const updates = await adapter.bootstrapOpenOrders({
    apiKey: "key",
    secret: "secret",
  });

  expect(
    updates.map((update) => ({
      orderId: update.orderId,
      type: update.type,
      rawType: update.rawType,
    })),
  ).toEqual([
    { orderId: "1", type: "limit", rawType: "LIMIT" },
    { orderId: "2", type: "market", rawType: "MARKET" },
    { orderId: "3", type: "stop_market", rawType: "STOP_MARKET" },
    { orderId: "4", type: "unknown", rawType: "LIMIT_MAKER" },
  ]);
});

test("BinancePrivateAdapter routes spot createOrder to PAPI margin order endpoint", async () => {
  const requests: URL[] = [];
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
        return jsonResponse(spotExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/margin/order"
      ) {
        requests.push(url);
        return jsonResponse({
          symbol: "BTCUSDT",
          orderId: 9201,
          clientOrderId: "cid-margin-9201",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "1.00",
          origQty: "2",
          executedQty: "0",
          cummulativeQuoteQty: "0",
          transactTime: 1710000000250,
        });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });

  const update = await adapter.createOrder(
    { apiKey: "key", secret: "secret" },
    {
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      price: "1.00",
      amount: "2",
      clientOrderId: "cid-margin-9201",
      margin: {
        sideEffectType: "auto_borrow_repay",
        autoRepayAtCancel: false,
      },
    },
  );

  expect(update).toMatchObject({
    symbol: "BTC/USDT",
    status: "open",
    orderId: "9201",
  });
  expect(update.reduceOnly).toBeUndefined();
  expect(update.positionSide).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.searchParams.get("symbol")).toBe("BTCUSDT");
  expect(requests[0]?.searchParams.get("sideEffectType")).toBe(
    "AUTO_BORROW_REPAY",
  );
  expect(requests[0]?.searchParams.get("autoRepayAtCancel")).toBe("false");
  expect(requests[0]?.searchParams.get("reduceOnly")).toBeNull();
  expect(requests[0]?.searchParams.get("positionSide")).toBeNull();
});

test("BinancePrivateAdapter rejects product option mismatches before REST", async () => {
  let marginPosts = 0;
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
        return jsonResponse(spotExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/margin/order"
      ) {
        marginPosts += 1;
        return jsonResponse({});
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });

  const error = await adapter
    .createOrder(
      { apiKey: "key", secret: "secret" },
      {
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: "2",
        um: {
          reduceOnly: true,
        },
      },
    )
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(OrderInputValidationError);
  expect(marginPosts).toBe(0);
});

test("BinancePrivateAdapter merges UM and margin open order snapshots", async () => {
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
        return jsonResponse(spotExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/um/openOrders"
      ) {
        return jsonResponse([successfulOrderResponse("BTCUSDT")]);
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/margin/openOrders"
      ) {
        return jsonResponse([
          {
            symbol: "BTCUSDT",
            orderId: 9301,
            clientOrderId: "cid-margin-9301",
            side: "SELL",
            type: "LIMIT",
            status: "NEW",
            price: "2.00",
            origQty: "3",
            executedQty: "1",
            updateTime: 1710000000260,
          },
        ]);
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });

  const snapshot = await adapter.fetchOpenOrders?.({
    apiKey: "key",
    secret: "secret",
  });

  expect(snapshot?.orders).toMatchObject([
    {
      symbol: "BTC/USDT:USDT",
      orderId: "9101",
      positionSide: "net",
    },
    {
      symbol: "BTC/USDT",
      orderId: "9301",
    },
  ]);
  expect(snapshot?.orders[1]?.positionSide).toBeUndefined();
  expect(snapshot?.orders[0]?.receivedAt).toBe(snapshot?.snapshotReceivedAt);
  expect(snapshot?.orders[1]?.receivedAt).toBe(snapshot?.snapshotReceivedAt);
});

test("BinancePrivateAdapter routes spot fetch and cancel commands to PAPI margin endpoints", async () => {
  const requests: Array<{
    method: string;
    path: string;
    symbol: string | null;
  }> = [];
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? "GET";
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
        return jsonResponse(spotExchangeInfo());
      }
      if (url.origin !== PAPI_REST_BASE_URL) {
        throw new Error(`Unexpected URL: ${url.toString()}`);
      }

      requests.push({
        method,
        path: url.pathname,
        symbol: url.searchParams.get("symbol"),
      });

      if (`${method} ${url.pathname}` === "GET /papi/v1/margin/order") {
        return jsonResponse({
          symbol: "BTCUSDT",
          orderId: 9401,
          clientOrderId: "cid-margin-9401",
          side: "BUY",
          type: "LIMIT",
          status: "FILLED",
          price: "1.00",
          origQty: "2",
          executedQty: "2",
          updateTime: 1710000000270,
        });
      }
      if (`${method} ${url.pathname}` === "DELETE /papi/v1/margin/order") {
        return jsonResponse({
          symbol: "BTCUSDT",
          orderId: 9401,
          clientOrderId: "cid-margin-9401",
          side: "BUY",
          type: "LIMIT",
          status: "CANCELED",
          price: "1.00",
          origQty: "2",
          executedQty: "0",
          updateTime: 1710000000280,
        });
      }
      if (`${method} ${url.pathname}` === "GET /papi/v1/margin/openOrders") {
        return jsonResponse([
          {
            symbol: "BTCUSDT",
            orderId: 9402,
            clientOrderId: "cid-margin-9402",
            side: "SELL",
            type: "LIMIT",
            status: "NEW",
            price: "2.00",
            origQty: "3",
            executedQty: "0",
            updateTime: 1710000000290,
          },
        ]);
      }
      if (
        `${method} ${url.pathname}` === "DELETE /papi/v1/margin/allOpenOrders"
      ) {
        return jsonResponse({ code: 200, msg: "done" });
      }

      throw new Error(`Unexpected URL: ${method} ${url.toString()}`);
    },
  });

  const fetched = await adapter.fetchOrder?.(
    { apiKey: "key", secret: "secret" },
    { symbol: "BTC/USDT", orderId: "9401" },
  );
  const canceled = await adapter.cancelOrder(
    { apiKey: "key", secret: "secret" },
    { symbol: "BTC/USDT", orderId: "9401" },
  );
  const canceledAll = await adapter.cancelAllOrders(
    { apiKey: "key", secret: "secret" },
    { symbol: "BTC/USDT" },
  );

  expect(fetched).toMatchObject({
    symbol: "BTC/USDT",
    orderId: "9401",
    status: "filled",
  });
  expect(canceled).toMatchObject({
    symbol: "BTC/USDT",
    orderId: "9401",
    status: "canceled",
  });
  expect(canceledAll).toMatchObject([
    {
      symbol: "BTC/USDT",
      orderId: "9402",
      status: "canceled",
    },
  ]);
  expect(
    requests.map((request) => `${request.method} ${request.path}`),
  ).toEqual([
    "GET /papi/v1/margin/order",
    "DELETE /papi/v1/margin/order",
    "GET /papi/v1/margin/openOrders",
    "DELETE /papi/v1/margin/allOpenOrders",
  ]);
  expect(requests.every((request) => request.symbol === "BTCUSDT")).toBe(true);
});

test("BinancePrivateAdapter maps PAPI UM leverage brackets", async () => {
  const requestedUrls: URL[] = [];
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/um/leverageBracket"
      ) {
        requestedUrls.push(url);
        return jsonResponse([
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
            ],
          },
        ]);
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });

  const snapshot = await adapter.fetchSymbolRiskLimit?.(
    { apiKey: "key", secret: "secret" },
    { symbol: "BTC/USDT:USDT" },
  );

  expect(snapshot).toMatchObject({
    symbol: "BTC/USDT:USDT",
    notionalCoefficient: "1.5",
    tiers: [
      {
        tier: 1,
        initialLeverage: "125",
        notionalFloor: "0",
        notionalCap: "50000",
        maintenanceMarginRatio: "0.004",
        cumulativeMaintenanceAmount: "0",
      },
    ],
  });
  expect(requestedUrls[0]?.searchParams.get("symbol")).toBe("BTCUSDT");
});

test("BinancePrivateAdapter sets PAPI UM leverage", async () => {
  const requestedUrls: URL[] = [];
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/um/leverage"
      ) {
        requestedUrls.push(url);
        return jsonResponse({
          symbol: "BTCUSDT",
          leverage: 4,
          maxNotionalValue: "500000.0000",
        });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });

  const update = await adapter.setSymbolLeverage?.(
    { apiKey: "key", secret: "secret" },
    { symbol: "BTC/USDT:USDT", leverage: "4" },
  );

  expect(update).toMatchObject({
    symbol: "BTC/USDT:USDT",
    leverage: "4",
    maxNotionalValue: "500000",
  });
  expect(requestedUrls[0]?.searchParams.get("symbol")).toBe("BTCUSDT");
  expect(requestedUrls[0]?.searchParams.get("leverage")).toBe("4");
});

test("BinancePrivateAdapter normalizes websocket order types and preserves rawType", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/listenKey"
      ) {
        return jsonResponse({ listenKey: "test-listen-key" });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });
  const updates: unknown[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(update): void {
        updates.push(update);
      },
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson(orderTradeUpdate("BTCUSDT", "TAKE_PROFIT_MARKET"));
  socket.emitJson(orderTradeUpdate("BTCUSDT", "VENUE_ONLY_TYPE"));

  await waitForCondition(() => updates.length === 2);
  expect(updates).toMatchObject([
    {
      symbol: "BTC/USDT:USDT",
      type: "take_profit_market",
      rawType: "TAKE_PROFIT_MARKET",
    },
    {
      symbol: "BTC/USDT:USDT",
      type: "unknown",
      rawType: "VENUE_ONLY_TYPE",
    },
  ]);
  handle.close();
});

test("BinancePrivateAdapter maps PAPI riskLevelChange risk levels", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/listenKey"
      ) {
        return jsonResponse({ listenKey: "test-listen-key" });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });
  const events: RawRiskLevelChange[] = [];
  const riskFrames = [
    {
      e: "riskLevelChange",
      E: 1710000000001,
      u: "1.2300",
      s: "MARGIN_CALL",
      eq: "30.2341672800",
      ae: "28.1000",
      m: "15.1170837100",
    },
    {
      e: "riskLevelChange",
      E: 1710000000002,
      u: "2.3400",
      s: "REDUCE_ONLY",
      eq: "31.0000",
      ae: "29.0000",
      m: "16.0000",
    },
    {
      e: "riskLevelChange",
      E: 1710000000003,
      u: "3.4500",
      s: "FORCE_LIQUIDATION",
      eq: "32.0000",
      ae: "30.0000",
      m: "17.0000",
    },
    {
      e: "riskLevelChange",
      E: 1710000000004,
      s: "VENUE_ONLY_RISK",
    },
  ];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(event): void {
        events.push(event);
      },
      onOrderUpdate(): void {},
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  for (const frame of riskFrames) {
    expect(frame.e).toBe("riskLevelChange");
    expect(frame.e).not.toBe("MARGIN_CALL");
    socket.emitJson(frame);
  }

  await waitForCondition(() => events.length === 4);
  expect(events).toMatchObject([
    {
      riskLevel: "margin_call",
      riskRatio: "1.23",
      netEquity: "30.23416728",
      riskEquity: "28.1",
      maintenanceMargin: "15.11708371",
      exchangeTs: 1710000000001,
    },
    {
      riskLevel: "reduce_only",
      riskRatio: "2.34",
      netEquity: "31",
      riskEquity: "29",
      maintenanceMargin: "16",
      exchangeTs: 1710000000002,
    },
    {
      riskLevel: "force_liquidation",
      riskRatio: "3.45",
      netEquity: "32",
      riskEquity: "30",
      maintenanceMargin: "17",
      exchangeTs: 1710000000003,
    },
    {
      riskLevel: "margin_call",
      exchangeTs: 1710000000004,
    },
  ]);
  socket.emitJson({ e: "ACCOUNT_CONFIG_UPDATE", E: 1710000000005 });
  await Bun.sleep(0);
  expect(events).toHaveLength(4);
  handle.close();
});

test("BinancePrivateAdapter maps ACCOUNT_CONFIG_UPDATE leverage updates", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/listenKey"
      ) {
        return jsonResponse({ listenKey: "test-listen-key" });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });
  const updates: RawAccountUpdate[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(update): void {
        updates.push(update);
      },
      onRiskLevelChange(): void {},
      onOrderUpdate(): void {},
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson({
    e: "ACCOUNT_CONFIG_UPDATE",
    E: 1710000000005,
    T: 1710000000004,
    fs: "UM",
    ac: {
      s: "BTCUSDT",
      l: 25,
    },
  });

  await waitForCondition(() => updates.length === 1);
  expect(updates[0]).toMatchObject({
    exchangeTs: 1710000000004,
    positions: [
      {
        symbol: "BTC/USDT:USDT",
        side: "net",
        leverage: "25",
        exchangeTs: 1710000000004,
      },
      {
        symbol: "BTC/USDT:USDT",
        side: "long",
        leverage: "25",
        exchangeTs: 1710000000004,
      },
      {
        symbol: "BTC/USDT:USDT",
        side: "short",
        leverage: "25",
        exchangeTs: 1710000000004,
      },
    ],
  });
  expect(updates[0]?.positions?.map((position) => position.size)).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  handle.close();
});

test("BinancePrivateAdapter maps margin executionReport order and trade updates", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
        return jsonResponse(spotExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/listenKey"
      ) {
        return jsonResponse({ listenKey: "test-listen-key" });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });
  const updates: unknown[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(update): void {
        updates.push(update);
      },
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson({
    e: "executionReport",
    E: 1710000000300,
    s: "BTCUSDT",
    i: 9501,
    c: "cid-margin-9501",
    S: "BUY",
    o: "LIMIT",
    x: "TRADE",
    X: "FILLED",
    p: "1.00",
    q: "2",
    z: "2",
    t: 8101,
    l: "2",
    L: "1.00",
    n: "0",
    N: "USDT",
    m: false,
    T: 1710000000310,
  });

  await waitForCondition(() => updates.length === 1);
  expect(updates[0]).toMatchObject({
    symbol: "BTC/USDT",
    status: "filled",
    orderId: "9501",
    clientOrderId: "cid-margin-9501",
    trade: {
      tradeId: "8101",
      fee: { cost: "0", asset: "USDT" },
      maker: false,
    },
  });
  expect((updates[0] as { reduceOnly?: unknown }).reduceOnly).toBeUndefined();
  expect(
    (updates[0] as { positionSide?: unknown }).positionSide,
  ).toBeUndefined();
  expect(
    (updates[0] as { trade?: { realizedPnl?: unknown } }).trade?.realizedPnl,
  ).toBeUndefined();
  handle.close();
});

test("BinancePrivateAdapter maps margin balance and liability stream events", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/listenKey"
      ) {
        return jsonResponse({ listenKey: "test-listen-key" });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });
  const updates: RawAccountUpdate[] = [];
  const reconcileReasons: string[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(update): void {
        updates.push(update);
      },
      onRiskLevelChange(): void {},
      onOrderUpdate(): void {},
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      requestReconcile(reason): void {
        reconcileReasons.push(reason);
      },
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson({
    e: "outboundAccountPosition",
    E: 1710000000400,
    u: 1710000000390,
    B: [{ a: "USDT", f: "10.5", l: "1.25" }],
  });
  socket.emitJson({
    e: "balanceUpdate",
    E: 1710000000410,
    a: "USDT",
    d: "1.00",
    T: 1710000000411,
  });
  socket.emitJson({
    e: "liabilityChange",
    E: 1710000000420,
    a: "USDT",
    p: "5",
    i: "0.25",
    l: "5.25",
    T: 1710000000421,
  });
  socket.emitJson({
    e: "openOrderLoss",
    E: 1710000000430,
  });

  await waitForCondition(() => updates.length === 2);
  expect(updates[0]).toMatchObject({
    balances: [
      {
        asset: "USDT",
        free: "10.5",
        used: "1.25",
        total: "11.75",
      },
    ],
  });
  expect(updates[1]).toMatchObject({
    balances: [
      {
        asset: "USDT",
        lending: {
          borrowed: "5.25",
          interest: "0.25",
        },
      },
    ],
  });
  expect(reconcileReasons).toEqual(["margin_open_order_loss"]);
  handle.close();
});

test("BinancePrivateAdapter replays quarantined ACCOUNT_CONFIG_UPDATE after catalog refresh", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  let catalogRequests = 0;
  let reconcileRequests = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      return jsonResponse(
        catalogRequests === 1
          ? usdmExchangeInfo()
          : usdmExchangeInfo([newUsdtSymbol()]),
      );
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/listenKey"
    ) {
      return jsonResponse({ listenKey: "test-listen-key" });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({ fetchFn });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });
  const updates: RawAccountUpdate[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(update): void {
        updates.push(update);
      },
      onRiskLevelChange(): void {},
      onOrderUpdate(): void {},
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      requestReconcile(): void {
        reconcileRequests += 1;
      },
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson({
    e: "ACCOUNT_CONFIG_UPDATE",
    E: 1710000000005,
    ac: {
      s: "NEWUSDT",
      l: "10.0000",
    },
  });
  expect(updates).toHaveLength(0);

  await waitForCondition(() => updates.length === 1);
  expect(reconcileRequests).toBe(0);
  expect(catalogRequests).toBe(2);
  expect(updates[0]).toMatchObject({
    exchangeTs: 1710000000005,
    positions: [
      {
        symbol: "NEW/USDT:USDT",
        side: "net",
        leverage: "10",
      },
      {
        symbol: "NEW/USDT:USDT",
        side: "long",
        leverage: "10",
      },
      {
        symbol: "NEW/USDT:USDT",
        side: "short",
        leverage: "10",
      },
    ],
  });
  handle.close();
});

test("BinancePrivateAdapter requests signing clock resync on timestamp errors", async () => {
  let resyncs = 0;
  const adapter = new BinancePrivateAdapter({
    signingClock: {
      now: () => 1_000,
      requestResync: () => {
        resyncs += 1;
      },
    },
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }

      return textResponse(
        '{"code":-1021,"msg":"Timestamp for this request was outside of the recvWindow."}',
        {
          status: 400,
          statusText: "Bad Request",
        },
      );
    },
  });

  const error = await adapter
    .createOrder(
      {
        apiKey: "key",
        secret: "secret",
      },
      {
        symbol: "BTC/USDT:USDT",
        side: "buy",
        type: "market",
        amount: "0.01",
      },
    )
    .catch((caught: unknown) => caught);

  expect(isTransportError(error)).toBe(true);
  expect(resyncs).toBe(1);
});

test("BinancePrivateAdapter requests signing clock resync on resolved timestamp error body", async () => {
  let resyncs = 0;
  const adapter = new BinancePrivateAdapter({
    signingClock: {
      now: () => 1_000,
      requestResync: () => {
        resyncs += 1;
      },
    },
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return jsonResponse(usdmExchangeInfo());
      }

      return textResponse(
        '{"code":-1021,"msg":"Timestamp for this request was outside of the recvWindow."}',
        {
          status: 200,
          statusText: "OK",
        },
      );
    },
  });

  const error = await adapter
    .createOrder(
      {
        apiKey: "key",
        secret: "secret",
      },
      {
        symbol: "BTC/USDT:USDT",
        side: "buy",
        type: "market",
        amount: "0.01",
      },
    )
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(resyncs).toBe(1);
});

test("BinancePrivateAdapter waits for catalog before creating the private WebSocket", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const listenKey = "catalog-gated-listen-key";
  const websocketUrl = `wss://fstream.binance.com/pm/ws/${listenKey}`;
  let resolveCatalog: ((response: Response) => void) | undefined;
  const adapter = new BinancePrivateAdapter({
    fetchFn: async (input) => {
      const url = new URL(input.toString());
      if (url.toString() === USDM_EXCHANGE_INFO_URL) {
        return await new Promise<Response>((resolve) => {
          resolveCatalog = resolve;
        });
      }
      if (
        url.origin === PAPI_REST_BASE_URL &&
        `${url.pathname}` === "/papi/v1/listenKey"
      ) {
        return jsonResponse({ listenKey });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    },
  });

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(): void {},
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  await Bun.sleep(10);
  expect(
    FakeWebSocket.instances.filter((socket) => socket.url === websocketUrl),
  ).toHaveLength(0);

  resolveCatalog?.(jsonResponse(usdmExchangeInfo()));
  await waitForSocket(websocketUrl);
  await handle.ready;
  handle.close();
});

test("BinancePrivateAdapter quarantines symbol misses, refreshes catalog, and replays raw order updates without reconcile churn", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  let catalogRequests = 0;
  let reconcileRequests = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      return jsonResponse(
        catalogRequests === 1
          ? usdmExchangeInfo()
          : usdmExchangeInfo([newUsdtSymbol()]),
      );
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/listenKey"
    ) {
      return jsonResponse({ listenKey: "test-listen-key" });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({ fetchFn });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });
  const updates: unknown[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(update): void {
        updates.push(update);
      },
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      requestReconcile(): void {
        reconcileRequests += 1;
      },
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson(orderTradeUpdate("NEWUSDT"));
  expect(updates).toHaveLength(0);

  await waitForCondition(() => updates.length === 1);
  expect(reconcileRequests).toBe(0);
  expect(catalogRequests).toBe(2);
  expect(updates[0]).toMatchObject({
    symbol: "NEW/USDT:USDT",
    status: "filled",
    trade: {
      tradeId: "7001",
      fee: { cost: "0", asset: "USDT" },
      realizedPnl: "0.5",
    },
  });
  handle.close();
});

test("BinancePrivateAdapter does not request reconcile or replay after close during symbol refresh", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  let catalogRequests = 0;
  let reconcileRequests = 0;
  let resolveRefresh: ((response: Response) => void) | undefined;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      if (catalogRequests === 1) {
        return jsonResponse(usdmExchangeInfo());
      }

      return await new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/listenKey"
    ) {
      return jsonResponse({ listenKey: "test-listen-key" });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({ fetchFn });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });
  const updates: unknown[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(update): void {
        updates.push(update);
      },
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      requestReconcile(): void {
        reconcileRequests += 1;
      },
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson(orderTradeUpdate("NEWUSDT"));

  await waitForCondition(
    () => catalogRequests === 2 && resolveRefresh !== undefined,
  );
  expect(updates).toHaveLength(0);

  handle.close();
  const finishRefresh = resolveRefresh;
  if (!finishRefresh) {
    throw new Error("Expected catalog refresh to be in flight");
  }
  finishRefresh(jsonResponse(usdmExchangeInfo([newUsdtSymbol()])));

  await Bun.sleep(20);
  expect(reconcileRequests).toBe(0);
  expect(updates).toHaveLength(0);
  expect(catalogRequests).toBe(2);
});

test("BinancePrivateAdapter retains quarantined trade updates when catalog refresh fails and replays after retry", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  let catalogRequests = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      if (catalogRequests === 2) {
        throw new TypeError("exchangeInfo unavailable");
      }

      return jsonResponse(
        catalogRequests === 1
          ? usdmExchangeInfo()
          : usdmExchangeInfo([newUsdtSymbol()]),
      );
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/listenKey"
    ) {
      return jsonResponse({ listenKey: "test-listen-key" });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({
    fetchFn,
    missRefreshCooldownMs: 5,
  });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });
  const updates: unknown[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(update): void {
        updates.push(update);
      },
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson(orderTradeUpdate("NEWUSDT"));

  await waitForCondition(() => catalogRequests >= 2);
  expect(updates).toHaveLength(0);

  await waitForCondition(() => updates.length === 1, 500);
  expect(catalogRequests).toBeGreaterThanOrEqual(3);
  expect(updates[0]).toMatchObject({
    symbol: "NEW/USDT:USDT",
    status: "filled",
    trade: {
      tradeId: "7001",
      fee: { cost: "0", asset: "USDT" },
      realizedPnl: "0.5",
    },
  });
  handle.close();
});

test("BinancePrivateAdapter drops quarantined raw updates after refresh still misses and reports once", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const runtimeErrors: Error[] = [];
  let reconcileRequests = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      return jsonResponse(usdmExchangeInfo());
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/listenKey"
    ) {
      return jsonResponse({ listenKey: "test-listen-key" });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({
    fetchFn,
    publishRuntimeError: (_source, error) => {
      runtimeErrors.push(error);
    },
  });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });
  const updates: unknown[] = [];

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(update): void {
        updates.push(update);
      },
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      requestReconcile(): void {
        reconcileRequests += 1;
      },
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;
  socket.emitJson(orderTradeUpdate("NEWUSDT"));

  await waitForCondition(() => runtimeErrors.length === 1);
  await Bun.sleep(10);
  expect(updates).toHaveLength(0);
  expect(reconcileRequests).toBe(1);
  expect(runtimeErrors[0]).toBeInstanceOf(SymbolMappingError);
  handle.close();
});

test("BinancePrivateAdapter cooldown limits repeated bad-symbol refresh and reconcile requests", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const runtimeErrors: Error[] = [];
  let catalogRequests = 0;
  let reconcileRequests = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      return jsonResponse(usdmExchangeInfo());
    }
    if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
      return jsonResponse(spotExchangeInfo());
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/listenKey"
    ) {
      return jsonResponse({ listenKey: "test-listen-key" });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({
    fetchFn,
    missRefreshCooldownMs: 1_000,
    publishRuntimeError: (_source, error) => {
      runtimeErrors.push(error);
    },
  });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(): void {},
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      requestReconcile(): void {
        reconcileRequests += 1;
      },
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;

  for (let i = 0; i < 5; i += 1) {
    socket.emitJson(orderTradeUpdate("BADUSDT"));
  }
  await waitForCondition(() => runtimeErrors.length === 1);
  const requestsAfterFirstMiss = catalogRequests;

  for (let i = 0; i < 5; i += 1) {
    socket.emitJson(orderTradeUpdate("BADUSDT"));
  }
  await Bun.sleep(20);

  expect(requestsAfterFirstMiss).toBe(2);
  expect(catalogRequests).toBe(requestsAfterFirstMiss);
  expect(reconcileRequests).toBe(1);
  expect(runtimeErrors[0]).toBeInstanceOf(SymbolMappingError);
  handle.close();
});

test("BinancePrivateAdapter reports overflowed quarantined symbol misses and requests reconcile", async () => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const runtimeErrors: Error[] = [];
  let catalogRequests = 0;
  let reconcileRequests = 0;
  let resolveRefresh: ((response: Response) => void) | undefined;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      if (catalogRequests === 1) {
        return jsonResponse(usdmExchangeInfo());
      }

      return await new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/listenKey"
    ) {
      return jsonResponse({ listenKey: "test-listen-key" });
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({
    fetchFn,
    publishRuntimeError: (_source, error) => {
      runtimeErrors.push(error);
    },
  });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });

  const handle = adapter.createPrivateStream(
    { apiKey: "key", secret: "secret" },
    {
      onAccountSnapshot(): void {},
      onAccountUpdate(): void {},
      onRiskLevelChange(): void {},
      onOrderUpdate(): void {},
      onFreshnessChange(): void {},
      onDisconnected(): void {},
      onReconnected(): void {},
      requestReconcile(): void {
        reconcileRequests += 1;
      },
      onError(error): void {
        throw error;
      },
    },
    streamOptions,
  );

  const socket = await waitForSocket(PAPI_WS_URL);
  await handle.ready;

  for (let i = 0; i < 65; i += 1) {
    socket.emitJson(orderTradeUpdate(`BAD${i}USDT`));
  }

  await waitForCondition(() => runtimeErrors.length === 1);
  expect(runtimeErrors[0]).toBeInstanceOf(SymbolMappingError);
  expect(reconcileRequests).toBe(1);
  expect(catalogRequests).toBe(2);

  resolveRefresh?.(jsonResponse(usdmExchangeInfo()));
  handle.close();
});

test("BinancePrivateAdapter refreshes stale command catalog misses and retries symbol mapping before POST", async () => {
  let catalogRequests = 0;
  const postSymbols: string[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      return jsonResponse(
        catalogRequests === 1
          ? usdmExchangeInfo()
          : usdmExchangeInfo([newUsdtSymbol()]),
      );
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/um/order"
    ) {
      const symbol = url.searchParams.get("symbol") ?? "";
      postSymbols.push(symbol);
      return jsonResponse(successfulOrderResponse(symbol));
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({ fetchFn });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });

  const update = await adapter.createOrder(
    { apiKey: "key", secret: "secret" },
    {
      symbol: "NEW/USDT:USDT",
      side: "buy",
      type: "limit",
      price: "1.00",
      amount: "2",
      clientOrderId: "cid-9101",
    },
  );

  expect(catalogRequests).toBe(2);
  expect(postSymbols).toEqual(["NEWUSDT"]);
  expect(update).toMatchObject({
    symbol: "NEW/USDT:USDT",
    status: "open",
    orderId: "9101",
  });
});

test("BinancePrivateAdapter rejects command catalog misses after one refresh without sending POST", async () => {
  let catalogRequests = 0;
  let postRequests = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === USDM_EXCHANGE_INFO_URL) {
      catalogRequests += 1;
      return jsonResponse(usdmExchangeInfo());
    }
    if (url.toString() === SPOT_EXCHANGE_INFO_URL) {
      return jsonResponse(spotExchangeInfo());
    }
    if (
      url.origin === PAPI_REST_BASE_URL &&
      `${url.pathname}` === "/papi/v1/um/order"
    ) {
      postRequests += 1;
      return jsonResponse(successfulOrderResponse("NEWUSDT"));
    }

    throw new Error(`Unexpected URL: ${url.toString()}`);
  };
  const catalog = new BinanceMarketCatalog({ fetchFn });
  const adapter = new BinancePrivateAdapter({
    fetchFn,
    marketCatalog: catalog,
  });

  const error = await adapter
    .createOrder(
      { apiKey: "key", secret: "secret" },
      {
        symbol: "NEW/USDT:USDT",
        side: "buy",
        type: "limit",
        price: "1.00",
        amount: "2",
        clientOrderId: "cid-9101",
      },
    )
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(SymbolMappingError);
  expect(catalogRequests).toBe(2);
  expect(postRequests).toBe(0);
});
