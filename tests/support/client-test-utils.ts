import { afterEach } from "bun:test";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

const SPOT_EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo";
const USDM_EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COINM_EXCHANGE_INFO_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const PAPI_REST_BASE_URL = "https://papi.binance.com";

export const PAPI_LISTEN_KEY = "test-listen-key";
export const PAPI_ACCOUNT_WS_URL = `wss://fstream.binance.com/pm/ws/${PAPI_LISTEN_KEY}`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

export function textResponse(
  body: string,
  options: { status: number; statusText: string },
): Response {
  return new Response(body, options);
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
  },
};

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) {
        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  send(): void {}

  emitJson(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  disconnect(code = 1006, reason = "network down"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason,
        wasClean: false,
      }),
    );
  }

  close(code = 1000, reason = "manual close"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code,
        reason,
        wasClean: true,
      }),
    );
  }
}

export async function waitForSocket(
  url: string,
  instanceIndex = 0,
  timeoutMs = 100,
): Promise<FakeWebSocket> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const matches = FakeWebSocket.instances.filter(
      (instance) => instance.url === url,
    );
    const socket = matches[instanceIndex];
    if (socket) {
      return socket;
    }

    await Bun.sleep(1);
  }

  throw new Error(`Timed out waiting for FakeWebSocket ${url}`);
}

export function installBinanceMarketInfra(): void {
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
  balance?: unknown;
  account?: unknown;
  umPositions?: unknown;
}): FetchRequestRecord[] {
  const requests: FetchRequestRecord[] = [];

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

      switch (`${method} ${url.pathname}`) {
        case "GET /papi/v1/balance":
          return jsonResponse(options?.balance ?? binanceFixtures.papi.balance);
        case "GET /papi/v1/account":
          return jsonResponse(options?.account ?? binanceFixtures.papi.account);
        case "GET /papi/v1/um/positionRisk":
          return jsonResponse(
            options?.umPositions ?? binanceFixtures.papi.umPositions,
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

export async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs = 1000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = (await Promise.race([
    iterator.next().then((value) => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      return value;
    }),
    new Promise<IteratorResult<T>>((_, reject) => {
      timeout = setTimeout(() => {
        timeout = undefined;
        reject(new Error("Timed out waiting for event"));
      }, timeoutMs);
    }),
  ])) as IteratorResult<T>;

  if (result.done) {
    throw new Error("Event stream closed unexpectedly");
  }

  return result.value;
}

export async function expectPending<T>(
  promise: Promise<T>,
  timeoutMs = 25,
): Promise<void> {
  const result = await Promise.race([
    promise.then(() => "resolved" as const),
    Bun.sleep(timeoutMs).then(() => "pending" as const),
  ]);

  if (result !== "pending") {
    throw new Error(`Expected promise to stay pending for ${timeoutMs}ms`);
  }
}

afterEach(() => {
  FakeWebSocket.reset();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originalWebSocket,
  });
});
