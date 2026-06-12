import { expect, test } from "bun:test";
import { BinanceMarketCatalog } from "../../src/adapters/binance/market-catalog.ts";
import { BinancePrivateAdapter } from "../../src/adapters/binance/private-adapter.ts";
import { SymbolMappingError } from "../../src/adapters/types.ts";
import { isTransportError } from "../../src/internal/http-client.ts";
import {
  FakeWebSocket,
  jsonResponse,
  textResponse,
  waitForSocket,
} from "../support/test-utils.ts";

const USDM_EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
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

function orderTradeUpdate(symbol: string) {
  return {
    e: "ORDER_TRADE_UPDATE",
    E: 1710000000000,
    o: {
      s: symbol,
      i: 9001,
      c: "cid-9001",
      S: "BUY",
      o: "LIMIT",
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

test("BinancePrivateAdapter quarantines symbol misses, refreshes catalog, and replays raw order updates", async () => {
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
  expect(reconcileRequests).toBe(1);
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
