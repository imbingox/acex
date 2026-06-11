import { createHmac } from "node:crypto";
import BigNumber from "bignumber.js";
import {
  type HttpClientMessages,
  type HttpRetryPolicy,
  httpRequest,
  isTransportError,
} from "../../internal/http-client.ts";
import { createManagedWebSocket } from "../../internal/managed-websocket.ts";
import type {
  AccountCredentials,
  PositionSide,
  RateLimiter,
  RateLimitPriority,
  RateLimitScope,
  TimeProvider,
  VenueAccountCapabilities,
  VenueOrderCapabilities,
} from "../../types/index.ts";
import type {
  CancelAllOrdersRequest,
  CancelOrderRequest,
  CreateOrderRequest,
  FetchOrderRequest,
  PrivateStreamCallbacks,
  PrivateStreamOptions,
  PrivateUserDataAdapter,
  RawAccountBootstrap,
  RawAccountUpdate,
  RawBalanceUpdate,
  RawOpenOrdersSnapshot,
  RawOrderUpdate,
  RawPositionUpdate,
  RawRiskUpdate,
  StreamHandle,
} from "../types.ts";
import { normalizeBinanceErrorCode } from "./error-codes.ts";
import { parseBinanceRateLimitUsage } from "./rate-limit.ts";
import {
  getBinancePapiRateLimitPlanId,
  registerBinanceRateLimitTopology,
} from "./rate-limit-topology.ts";

type TimerHandle = ReturnType<typeof setInterval>;
type SignedRequestMethod = "GET" | "POST" | "DELETE";
type FetchLike = typeof fetch;

interface BinancePapiBalance {
  asset?: string;
  totalWalletBalance?: string;
  crossMarginFree?: string;
  crossMarginLocked?: string;
  availableBalance?: string;
  maxWithdrawAmount?: string;
  balance?: string;
}

interface BinancePapiAccount {
  accountEquity?: string;
  actualEquity?: string;
  totalEquity?: string;
  accountInitialMargin?: string;
  totalInitialMargin?: string;
  accountMaintMargin?: string;
  totalMaintMargin?: string;
  uniMMR?: string;
  updateTime?: number;
}

interface BinancePapiUmPosition {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  markPrice?: string;
  unRealizedProfit?: string;
  unrealizedProfit?: string;
  liquidationPrice?: string;
  leverage?: string;
  notional?: string;
  positionSide?: string;
  updateTime?: number;
}

interface BinancePapiOpenOrder {
  symbol?: string;
  orderId?: number | string;
  clientOrderId?: string;
  side?: string;
  type?: string;
  status?: string;
  price?: string;
  stopPrice?: string;
  origQty?: string;
  executedQty?: string;
  avgPrice?: string;
  reduceOnly?: boolean;
  positionSide?: string;
  updateTime?: number;
  time?: number;
}

interface BinancePapiCancelAllResponse {
  code?: number | string;
  msg?: string;
}

interface BinanceListenKeyResponse {
  listenKey?: string;
}

interface BinanceAccountUpdateBalance {
  a?: string;
  wb?: string;
  cw?: string;
  bc?: string;
}

interface BinanceAccountUpdatePosition {
  s?: string;
  pa?: string;
  ep?: string;
  cr?: string;
  up?: string;
  mt?: string;
  iw?: string;
  ps?: string;
  ma?: string;
}

interface BinanceAccountUpdateMessage {
  e?: string;
  E?: number;
  T?: number;
  a?: {
    B?: BinanceAccountUpdateBalance[];
    P?: BinanceAccountUpdatePosition[];
  };
}

interface BinanceOrderTradeUpdatePayload {
  s?: string;
  i?: number | string;
  c?: string;
  S?: string;
  o?: string;
  X?: string;
  p?: string;
  sp?: string;
  q?: string;
  z?: string;
  ap?: string;
  R?: boolean;
  ps?: string;
  T?: number;
}

interface BinanceOrderTradeUpdateMessage {
  e?: string;
  E?: number;
  T?: number;
  o?: BinanceOrderTradeUpdatePayload;
}

interface BinanceListenKeyExpiredMessage {
  e?: string;
  E?: number;
  listenKey?: string;
}

type BinancePrivateMessage =
  | BinanceAccountUpdateMessage
  | BinanceOrderTradeUpdateMessage
  | BinanceListenKeyExpiredMessage;

const BINANCE_PAPI_REST_BASE_URL = "https://papi.binance.com";
const BINANCE_PAPI_WS_BASE_URL = "wss://fstream.binance.com/pm/ws";
const DEFAULT_RECV_WINDOW = 5_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const USDM_QUOTE_ASSETS = ["FDUSD", "USDC", "BUSD", "USDT"];
const SAFE_READ_RETRY_POLICY: HttpRetryPolicy = {
  idempotent: true,
  maxAttempts: 3,
};
const NO_RETRY_POLICY: HttpRetryPolicy = {
  idempotent: false,
  maxAttempts: 1,
};
const LISTEN_KEY_KEEPALIVE_RETRY_POLICY: HttpRetryPolicy = {
  idempotent: true,
  maxAttempts: 3,
};
function getBinancePapiHttpMessages(timeoutMs: number): HttpClientMessages {
  return {
    http: ({ status, statusText, url, rawBody }) =>
      `Binance PAPI request failed: ${status} ${statusText ?? ""} ${url}${
        rawBody ? ` ${rawBody}` : ""
      }`,
    timeout: () => `Binance PAPI fetch timeout after ${timeoutMs}ms`,
    aborted: () => "Binance PAPI fetch aborted",
    parse: ({ url }) => `Binance PAPI response parse failed: ${url}`,
  };
}

function requirePrivateCredentials(credentials: AccountCredentials): {
  apiKey: string;
  secret: string;
} {
  if (!credentials.apiKey || !credentials.secret) {
    throw new Error("Binance PAPI credentials require apiKey and secret");
  }

  return {
    apiKey: credentials.apiKey,
    secret: credentials.secret,
  };
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

function getNumberOption(
  options: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = options?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function signQuery(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

function normalizeUmSymbol(symbol: string): string {
  for (const quote of USDM_QUOTE_ASSETS) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return `${symbol.slice(0, -quote.length)}/${quote}:${quote}`;
    }
  }

  return symbol;
}

function encodeUmSymbol(symbol: string): string {
  const matched = /^([^/]+)\/([^:]+):([^:]+)$/.exec(symbol);
  if (matched && matched[2] === matched[3]) {
    return `${matched[1]}${matched[2]}`;
  }

  return symbol;
}

function normalizePositionSide(value?: string): PositionSide {
  switch (value) {
    case "LONG":
      return "long";
    case "SHORT":
      return "short";
    default:
      return "net";
  }
}

function normalizeOrderSide(value?: string): "buy" | "sell" {
  return value === "SELL" ? "sell" : "buy";
}

function encodeOrderSide(value: CreateOrderRequest["side"]): "BUY" | "SELL" {
  return value === "sell" ? "SELL" : "BUY";
}

function encodeOrderType(
  value: CreateOrderRequest["type"],
): "LIMIT" | "MARKET" {
  return value === "market" ? "MARKET" : "LIMIT";
}

function encodePositionSide(
  value?: PositionSide,
): "BOTH" | "LONG" | "SHORT" | undefined {
  switch (value) {
    case "long":
      return "LONG";
    case "short":
      return "SHORT";
    case "net":
      return "BOTH";
    default:
      return undefined;
  }
}

function normalizeOrderStatus(
  value?: string,
): RawOrderUpdate["status"] | undefined {
  switch (value) {
    case "PARTIALLY_FILLED":
      return "partially_filled";
    case "FILLED":
      return "filled";
    case "CANCELED":
    case "CANCELLED":
      return "canceled";
    case "REJECTED":
      return "rejected";
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "expired";
    default:
      return value ? "open" : undefined;
  }
}

function mapBalance(
  input: BinancePapiBalance,
  receivedAt: number,
): RawBalanceUpdate | undefined {
  if (!input.asset) {
    return undefined;
  }

  const total = firstString(input.totalWalletBalance, input.balance) ?? "0";
  const free =
    firstString(
      input.crossMarginFree,
      input.availableBalance,
      input.maxWithdrawAmount,
      total,
    ) ?? "0";

  return {
    asset: input.asset,
    free,
    used: input.crossMarginLocked,
    total,
    receivedAt,
  };
}

function mapAccountRisk(
  input: BinancePapiAccount,
  receivedAt: number,
  positions: BinancePapiUmPosition[] = [],
): RawRiskUpdate | undefined {
  const uniMmr = firstString(input.uniMMR);
  const riskRatio = uniMmr
    ? new BigNumber(1).dividedBy(uniMmr).toString(10)
    : undefined;
  const netEquity = firstString(input.actualEquity);
  const riskEquity = firstString(input.accountEquity, input.totalEquity);
  const riskLeverage = calculateRiskLeverage(riskEquity, positions);
  const risk: RawRiskUpdate = {
    netEquity,
    riskEquity,
    riskRatio,
    riskLeverage,
    initialMargin: firstString(
      input.accountInitialMargin,
      input.totalInitialMargin,
    ),
    maintenanceMargin: firstString(
      input.accountMaintMargin,
      input.totalMaintMargin,
    ),
    exchangeTs: input.updateTime,
    receivedAt,
  };

  if (
    !risk.netEquity &&
    !risk.riskEquity &&
    !risk.riskRatio &&
    !risk.riskLeverage &&
    !risk.initialMargin &&
    !risk.maintenanceMargin
  ) {
    return undefined;
  }

  return risk;
}

function calculateRiskLeverage(
  riskEquity: string | undefined,
  positions: BinancePapiUmPosition[],
): string | undefined {
  if (!riskEquity) {
    return undefined;
  }

  const riskEquityValue = new BigNumber(riskEquity);
  if (!riskEquityValue.isFinite() || riskEquityValue.isZero()) {
    return undefined;
  }

  const grossExposure = positions.reduce((total, position) => {
    const notional = firstString(position.notional);
    if (!notional) {
      return total;
    }

    const value = new BigNumber(notional);
    return value.isFinite() ? total.plus(value.absoluteValue()) : total;
  }, new BigNumber(0));

  return grossExposure.isZero()
    ? undefined
    : grossExposure.dividedBy(riskEquityValue).toString(10);
}

function mapUmPosition(
  input: BinancePapiUmPosition,
  receivedAt: number,
): RawPositionUpdate | undefined {
  if (!input.symbol) {
    return undefined;
  }

  return {
    symbol: normalizeUmSymbol(input.symbol),
    side: normalizePositionSide(input.positionSide),
    size: input.positionAmt ?? "0",
    entryPrice: input.entryPrice,
    markPrice: input.markPrice,
    unrealizedPnl: firstString(input.unRealizedProfit, input.unrealizedProfit),
    leverage: input.leverage,
    liquidationPrice: input.liquidationPrice,
    exchangeTs: input.updateTime,
    receivedAt,
  };
}

function mapAccountRefresh(
  account: BinancePapiAccount,
  positions: BinancePapiUmPosition[],
  receivedAt: number,
): RawAccountUpdate {
  return {
    positions: positions.flatMap((position) => {
      const mapped = mapUmPosition(position, receivedAt);
      return mapped ? [mapped] : [];
    }),
    risk: mapAccountRisk(account, receivedAt, positions),
    exchangeTs: account.updateTime,
    receivedAt,
  };
}

function mapAccountBootstrap(
  balances: BinancePapiBalance[],
  account: BinancePapiAccount,
  positions: BinancePapiUmPosition[],
  receivedAt: number,
): RawAccountBootstrap {
  return {
    balances: balances.flatMap((balance) => {
      const mapped = mapBalance(balance, receivedAt);
      return mapped ? [mapped] : [];
    }),
    positions: positions.flatMap((position) => {
      const mapped = mapUmPosition(position, receivedAt);
      return mapped ? [mapped] : [];
    }),
    risk: mapAccountRisk(account, receivedAt, positions),
    exchangeTs: account.updateTime,
    receivedAt,
  };
}

function mapOpenOrder(
  input: BinancePapiOpenOrder,
  receivedAt: number,
): RawOrderUpdate | undefined {
  const status = normalizeOrderStatus(input.status);
  if (!input.symbol || !status) {
    return undefined;
  }

  return {
    orderId: input.orderId === undefined ? undefined : `${input.orderId}`,
    clientOrderId: input.clientOrderId,
    symbol: normalizeUmSymbol(input.symbol),
    side: normalizeOrderSide(input.side),
    type: input.type ?? "unknown",
    status,
    price: input.price,
    triggerPrice: input.stopPrice,
    amount: input.origQty ?? "0",
    filled: input.executedQty ?? "0",
    avgFillPrice: input.avgPrice,
    reduceOnly: input.reduceOnly,
    positionSide: normalizePositionSide(input.positionSide),
    exchangeTs: input.updateTime ?? input.time,
    receivedAt,
  };
}

function mapAccountUpdateBalance(
  input: BinanceAccountUpdateBalance,
  exchangeTs: number | undefined,
  receivedAt: number,
): RawBalanceUpdate | undefined {
  if (!input.a) {
    return undefined;
  }

  const total = input.wb ?? "0";
  return {
    asset: input.a,
    free: input.cw ?? total,
    total,
    exchangeTs,
    receivedAt,
  };
}

function mapAccountUpdatePosition(
  input: BinanceAccountUpdatePosition,
  exchangeTs: number | undefined,
  receivedAt: number,
): RawPositionUpdate | undefined {
  if (!input.s) {
    return undefined;
  }

  return {
    symbol: normalizeUmSymbol(input.s),
    side: normalizePositionSide(input.ps),
    size: input.pa ?? "0",
    entryPrice: input.ep,
    unrealizedPnl: input.up,
    exchangeTs,
    receivedAt,
  };
}

function parsePrivateMessage(data: string): BinancePrivateMessage | undefined {
  const parsed = JSON.parse(data) as BinancePrivateMessage;
  return parsed.e === "ACCOUNT_UPDATE" ||
    parsed.e === "ORDER_TRADE_UPDATE" ||
    parsed.e === "listenKeyExpired"
    ? parsed
    : undefined;
}

function isAccountUpdateMessage(
  message: BinancePrivateMessage,
): message is BinanceAccountUpdateMessage {
  return message.e === "ACCOUNT_UPDATE";
}

function isListenKeyExpiredMessage(
  message: BinancePrivateMessage,
): message is BinanceListenKeyExpiredMessage {
  return message.e === "listenKeyExpired";
}

function mapAccountUpdate(
  message: BinanceAccountUpdateMessage,
  receivedAt: number,
): RawAccountUpdate {
  const exchangeTs = message.T ?? message.E;
  return {
    balances: message.a?.B?.flatMap((balance) => {
      const mapped = mapAccountUpdateBalance(balance, exchangeTs, receivedAt);
      return mapped ? [mapped] : [];
    }),
    positions: message.a?.P?.flatMap((position) => {
      const mapped = mapAccountUpdatePosition(position, exchangeTs, receivedAt);
      return mapped ? [mapped] : [];
    }),
    exchangeTs,
    receivedAt,
  };
}

function mapOrderUpdate(
  message: BinanceOrderTradeUpdateMessage,
  receivedAt: number,
): RawOrderUpdate | undefined {
  const payload = message.o;
  const status = normalizeOrderStatus(payload?.X);
  if (!payload?.s || !status) {
    return undefined;
  }

  return {
    orderId: payload.i === undefined ? undefined : `${payload.i}`,
    clientOrderId: payload.c,
    symbol: normalizeUmSymbol(payload.s),
    side: normalizeOrderSide(payload.S),
    type: payload.o ?? "unknown",
    status,
    price: payload.p,
    triggerPrice: payload.sp,
    amount: payload.q ?? "0",
    filled: payload.z ?? "0",
    avgFillPrice: payload.ap,
    reduceOnly: payload.R,
    positionSide: normalizePositionSide(payload.ps),
    exchangeTs: payload.T ?? message.T ?? message.E,
    receivedAt,
  };
}

function isBinanceOrderNotFound(error: unknown): boolean {
  if (!isTransportError(error) || error.kind !== "http") {
    return false;
  }

  if (error.status !== 400 && error.status !== 404) {
    return false;
  }

  const rawBody = error.rawBody;
  if (!rawBody) {
    return false;
  }

  try {
    const parsed = JSON.parse(rawBody) as { code?: unknown };
    return normalizeBinanceErrorCode(`${parsed.code}`) === "order_not_found";
  } catch {
    return false;
  }
}

export class BinancePrivateAdapter implements PrivateUserDataAdapter {
  readonly venue = "binance" as const;
  readonly readOnly = false;
  readonly notes = [
    "Capabilities describe the current SDK runtime, not Binance's full exchange API surface.",
    "Funding rate support depends on the market type.",
    "Order commands currently target Binance PAPI UM USD-M symbols; venue-level order.supported does not mean every Binance market type is orderable.",
  ];
  readonly accountCapabilities: VenueAccountCapabilities = {
    register: "supported",
    snapshot: "supported",
    updates: "websocket",
    balances: "supported",
    positions: "supported",
    risk: "supported",
    lending: "unsupported",
    credentialsRequired: true,
  };
  readonly orderCapabilities: VenueOrderCapabilities = {
    supported: true,
    openOrders: "supported",
    updates: "websocket",
    create: "supported",
    cancel: "supported",
    cancelAll: "symbol",
    orderTypes: ["limit", "market"],
    timeInForce: ["gtc", "post_only"],
    postOnly: true,
    reduceOnly: true,
    positionSide: "required_for_hedge",
    clientOrderId: true,
  };

  constructor(
    private readonly options: {
      readonly fetchFn?: FetchLike;
      readonly httpTimeoutMs?: number;
      readonly signingClock?: TimeProvider;
      readonly rateLimiter?: RateLimiter;
    } = {},
  ) {
    registerBinanceRateLimitTopology(this.options.rateLimiter);
  }

  normalizeVenueErrorCode(code: string) {
    return normalizeBinanceErrorCode(code);
  }

  async bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap> {
    const receivedAt = Date.now();
    const [balances, account, positions] = await Promise.all([
      this.signedRequest<BinancePapiBalance[]>(
        "GET",
        "/papi/v1/balance",
        credentials,
        accountOptions,
        undefined,
        SAFE_READ_RETRY_POLICY,
      ),
      this.signedRequest<BinancePapiAccount>(
        "GET",
        "/papi/v1/account",
        credentials,
        accountOptions,
        undefined,
        SAFE_READ_RETRY_POLICY,
      ),
      this.signedRequest<BinancePapiUmPosition[]>(
        "GET",
        "/papi/v1/um/positionRisk",
        credentials,
        accountOptions,
        undefined,
        SAFE_READ_RETRY_POLICY,
      ),
    ]);

    return mapAccountBootstrap(balances, account, positions, receivedAt);
  }

  async reconcileAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap> {
    return this.bootstrapAccount(credentials, accountOptions);
  }

  async refreshAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountUpdate> {
    const receivedAt = Date.now();
    const [account, positions] = await Promise.all([
      this.signedRequest<BinancePapiAccount>(
        "GET",
        "/papi/v1/account",
        credentials,
        accountOptions,
        undefined,
        SAFE_READ_RETRY_POLICY,
      ),
      this.signedRequest<BinancePapiUmPosition[]>(
        "GET",
        "/papi/v1/um/positionRisk",
        credentials,
        accountOptions,
        undefined,
        SAFE_READ_RETRY_POLICY,
      ),
    ]);

    return mapAccountRefresh(account, positions, receivedAt);
  }

  async bootstrapOpenOrders(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]> {
    const snapshot = await this.fetchOpenOrders(credentials, accountOptions);
    return snapshot.orders;
  }

  async fetchOpenOrders(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOpenOrdersSnapshot> {
    const receivedAt = Date.now();
    const orders = await this.signedRequest<BinancePapiOpenOrder[]>(
      "GET",
      "/papi/v1/um/openOrders",
      credentials,
      accountOptions,
      undefined,
      SAFE_READ_RETRY_POLICY,
    );

    return {
      orders: orders.flatMap((order) => {
        const mapped = mapOpenOrder(order, receivedAt);
        return mapped ? [mapped] : [];
      }),
      snapshotReceivedAt: receivedAt,
    };
  }

  async fetchOrder(
    credentials: AccountCredentials,
    request: FetchOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate | undefined> {
    const receivedAt = Date.now();
    try {
      const response = await this.signedRequest<BinancePapiOpenOrder>(
        "GET",
        "/papi/v1/um/order",
        credentials,
        accountOptions,
        {
          symbol: encodeUmSymbol(request.symbol),
          orderId: request.orderId,
          origClientOrderId: request.clientOrderId,
        },
        SAFE_READ_RETRY_POLICY,
      );

      return mapOpenOrder(response, receivedAt);
    } catch (error) {
      if (isBinanceOrderNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async createOrder(
    credentials: AccountCredentials,
    request: CreateOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate> {
    const receivedAt = Date.now();
    const response = await this.signedRequest<BinancePapiOpenOrder>(
      "POST",
      "/papi/v1/um/order",
      credentials,
      accountOptions,
      {
        symbol: encodeUmSymbol(request.symbol),
        side: encodeOrderSide(request.side),
        type: encodeOrderType(request.type),
        quantity: request.amount,
        price: request.price,
        timeInForce:
          request.type === "limit"
            ? request.postOnly === true
              ? "GTX"
              : "GTC"
            : undefined,
        newClientOrderId: request.clientOrderId,
        reduceOnly:
          request.reduceOnly === undefined
            ? undefined
            : `${request.reduceOnly}`,
        positionSide: encodePositionSide(request.positionSide),
      },
      NO_RETRY_POLICY,
    );

    const mapped = mapOpenOrder(response, receivedAt);
    if (!mapped) {
      throw new Error(
        "Binance PAPI createOrder response did not contain an order",
      );
    }

    return mapped;
  }

  async cancelOrder(
    credentials: AccountCredentials,
    request: CancelOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate> {
    const receivedAt = Date.now();
    const response = await this.signedRequest<BinancePapiOpenOrder>(
      "DELETE",
      "/papi/v1/um/order",
      credentials,
      accountOptions,
      {
        symbol: encodeUmSymbol(request.symbol),
        orderId: request.orderId,
        origClientOrderId: request.clientOrderId,
      },
      NO_RETRY_POLICY,
      "cancel",
    );

    const mapped = mapOpenOrder(response, receivedAt);
    if (!mapped) {
      throw new Error(
        "Binance PAPI cancelOrder response did not contain an order",
      );
    }

    return mapped;
  }

  async cancelAllOrders(
    credentials: AccountCredentials,
    request: CancelAllOrdersRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]> {
    const symbol = encodeUmSymbol(request.symbol);
    const openOrders = await this.signedRequest<BinancePapiOpenOrder[]>(
      "GET",
      "/papi/v1/um/openOrders",
      credentials,
      accountOptions,
      {
        symbol,
      },
      SAFE_READ_RETRY_POLICY,
      "cancel",
    );

    // Venue responds {code,msg}; returned updates are synthesized from the
    // pre-fetch. Orders that fill between fetch and cancel are corrected by
    // the WS terminal event / reconcile.
    const response = await this.signedRequest<BinancePapiCancelAllResponse>(
      "DELETE",
      "/papi/v1/um/allOpenOrders",
      credentials,
      accountOptions,
      {
        symbol,
      },
      NO_RETRY_POLICY,
      "cancel",
    );

    if (response.code !== undefined && `${response.code}` !== "200") {
      throw new Error(
        `Binance PAPI cancelAllOrders failed: code=${response.code}, msg=${
          response.msg ?? ""
        }`,
      );
    }

    const receivedAt = Date.now();
    return openOrders.flatMap((order) => {
      const mapped = mapOpenOrder(order, receivedAt);
      return mapped
        ? [
            {
              ...mapped,
              status: "canceled",
              exchangeTs: undefined,
              receivedAt,
            },
          ]
        : [];
    });
  }

  createPrivateStream(
    credentials: AccountCredentials,
    callbacks: PrivateStreamCallbacks,
    options: PrivateStreamOptions,
    accountOptions?: Record<string, unknown>,
  ): StreamHandle {
    interface PrivateStreamSession {
      readonly listenKey: string;
      websocket?: StreamHandle;
      keepAliveTimer?: TimerHandle;
      stopped: boolean;
    }

    type RecoveryReason =
      | "heartbeat_timeout"
      | "keepalive_failed"
      | "listen_key_expired";

    let closed = false;
    let activeSession: PrivateStreamSession | undefined;
    let recoveryInFlight: Promise<void> | undefined;
    let recoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let openedOnce = false;

    const clearRecoveryRetry = () => {
      if (recoveryRetryTimer) {
        clearTimeout(recoveryRetryTimer);
        recoveryRetryTimer = undefined;
      }
    };

    const closeListenKey = (listenKey: string) => {
      void this.closeUserDataStream(
        credentials,
        listenKey,
        accountOptions,
      ).catch((error) => {
        if (!closed) {
          callbacks.onError(
            toError(error, "Failed to close Binance PAPI listenKey"),
          );
        }
      });
    };

    const closeSession = (
      session: PrivateStreamSession | undefined,
      shouldCloseListenKey: boolean,
    ) => {
      if (!session || session.stopped) {
        return;
      }

      session.stopped = true;
      if (session.keepAliveTimer) {
        clearInterval(session.keepAliveTimer);
        session.keepAliveTimer = undefined;
      }
      session.websocket?.close();
      session.websocket = undefined;
      if (shouldCloseListenKey) {
        closeListenKey(session.listenKey);
      }
    };

    const activateSession = (nextSession: PrivateStreamSession) => {
      if (closed) {
        closeSession(nextSession, true);
        return;
      }

      const previousSession = activeSession;
      activeSession = nextSession;
      closeSession(previousSession, true);

      if (openedOnce) {
        callbacks.onReconnected();
      } else {
        openedOnce = true;
      }
    };

    const scheduleRecoveryRetry = (reason: RecoveryReason) => {
      if (closed || recoveryRetryTimer) {
        return;
      }

      recoveryRetryTimer = setTimeout(() => {
        recoveryRetryTimer = undefined;
        recoverPrivateStream(reason);
      }, options.reconnectDelayMs);
    };

    const createSession = async (): Promise<
      PrivateStreamSession | undefined
    > => {
      const listenKey = await this.startUserDataStream(
        credentials,
        accountOptions,
      );
      if (closed) {
        closeListenKey(listenKey);
        return undefined;
      }

      const nextSession: PrivateStreamSession = {
        listenKey,
        stopped: false,
      };

      nextSession.keepAliveTimer = setInterval(() => {
        if (closed || activeSession !== nextSession) {
          return;
        }

        void this.keepAliveUserDataStream(
          credentials,
          nextSession.listenKey,
          accountOptions,
        ).catch((error) => {
          if (closed || activeSession !== nextSession) {
            return;
          }

          callbacks.onError(
            toError(error, "Failed to keep Binance PAPI listenKey alive"),
          );
          recoverPrivateStream("keepalive_failed");
        });
      }, options.listenKeyKeepAliveMs);

      nextSession.websocket = createManagedWebSocket<BinancePrivateMessage>({
        url: `${BINANCE_PAPI_WS_BASE_URL}/${listenKey}`,
        initialMessageTimeoutMs: options.openTimeoutMs,
        readyWhen: "open",
        now: options.now,
        parseMessage: parsePrivateMessage,
        onOpen() {
          if (closed || activeSession !== nextSession) {
            return;
          }

          if (openedOnce) {
            callbacks.onReconnected();
          } else {
            openedOnce = true;
          }
        },
        onMessage(message, receivedAt) {
          if (closed || activeSession !== nextSession) {
            return;
          }

          if (isListenKeyExpiredMessage(message)) {
            recoverPrivateStream("listen_key_expired");
            return;
          }

          if (isAccountUpdateMessage(message)) {
            callbacks.onAccountUpdate(mapAccountUpdate(message, receivedAt));
            return;
          }

          const orderUpdate = mapOrderUpdate(message, receivedAt);
          if (orderUpdate) {
            callbacks.onOrderUpdate(orderUpdate);
          }
        },
        onUnexpectedClose() {
          if (closed || activeSession !== nextSession) {
            return;
          }

          callbacks.onDisconnected();
        },
        onError() {
          if (closed || activeSession !== nextSession) {
            return;
          }

          callbacks.onError(
            new Error("WebSocket error for Binance PAPI private stream"),
          );
        },
        messageWatchdog: {
          staleAfterMs: options.staleAfterMs,
          onStale() {
            if (closed || activeSession !== nextSession) {
              return;
            }

            recoverPrivateStream("heartbeat_timeout");
          },
        },
        reconnect: {
          initialDelayMs: options.reconnectDelayMs,
          maxDelayMs: options.reconnectMaxDelayMs,
          reconnectWithoutMessages: true,
        },
      });

      try {
        await nextSession.websocket.ready;
      } catch (error) {
        closeSession(nextSession, true);
        throw error;
      }

      return nextSession;
    };

    const recoverPrivateStream = (reason: RecoveryReason) => {
      if (closed || recoveryInFlight) {
        return;
      }

      clearRecoveryRetry();
      if (reason === "heartbeat_timeout") {
        callbacks.onFreshnessChange("stale", "heartbeat_timeout");
      } else {
        callbacks.onDisconnected();
      }

      const recovery = (async () => {
        const previousSession = activeSession;
        activeSession = undefined;
        closeSession(previousSession, true);

        try {
          const nextSession = await createSession();
          if (nextSession) {
            activateSession(nextSession);
          }
        } catch (error) {
          if (!closed) {
            callbacks.onError(
              toError(error, "Failed to rebuild Binance PAPI private stream"),
            );
            scheduleRecoveryRetry(reason);
          }
        }
      })().finally(() => {
        if (recoveryInFlight === recovery) {
          recoveryInFlight = undefined;
        }
      });

      recoveryInFlight = recovery;
    };

    const ready = (async () => {
      const initialSession = await createSession();
      if (initialSession) {
        activateSession(initialSession);
      }
    })();

    return {
      ready,
      close() {
        if (closed) {
          return;
        }

        closed = true;
        clearRecoveryRetry();
        closeSession(activeSession, true);
        activeSession = undefined;
      },
    };
  }

  private async signedRequest<T>(
    method: SignedRequestMethod,
    path: string,
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
    queryParams?: Record<string, string | undefined>,
    retryPolicy?: HttpRetryPolicy,
    priority?: RateLimitPriority,
  ): Promise<T> {
    const { apiKey, secret } = requirePrivateCredentials(credentials);
    const scope = this.rateLimitScope(method, path, accountOptions);
    const requestContext = {
      scope,
      planId: getBinancePapiRateLimitPlanId(method, path, queryParams),
      priority,
    };
    const reservation =
      (await this.options.rateLimiter?.beforeRequest(requestContext)) ??
      undefined;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams ?? {})) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }
    params.set(
      "timestamp",
      `${
        getNumberOption(accountOptions, "timestamp") ??
        this.options.signingClock?.now() ??
        Date.now()
      }`,
    );
    params.set(
      "recvWindow",
      `${getNumberOption(accountOptions, "recvWindow") ?? DEFAULT_RECV_WINDOW}`,
    );
    params.set("signature", signQuery(params.toString(), secret));

    const url = `${BINANCE_PAPI_REST_BASE_URL}${path}?${params.toString()}`;
    const timeoutMs = this.options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    try {
      const response = await httpRequest<T>({
        fetchFn: this.options.fetchFn,
        url,
        method,
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
        timeoutMs,
        parseAs: "json",
        emptyBody: "empty_object",
        retryPolicy: retryPolicy ?? NO_RETRY_POLICY,
        messages: getBinancePapiHttpMessages(timeoutMs),
      });

      await this.options.rateLimiter?.afterResponse(requestContext, {
        status: response.status,
        headers: response.headers,
        usage: parseBinanceRateLimitUsage(response.headers),
        reservation,
      });

      return response.body;
    } catch (error) {
      if (isTransportError(error)) {
        await this.options.rateLimiter?.onTransportError(requestContext, {
          status: error.status,
          headers: error.headers,
          retryAfterMs: error.retryAfterMs,
          usage: parseBinanceRateLimitUsage(error.headers),
          reservation,
        });
      }

      throw error;
    }
  }

  private async startUserDataStream(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<string> {
    const response = await this.userStreamRequest<BinanceListenKeyResponse>(
      "POST",
      credentials,
      undefined,
      NO_RETRY_POLICY,
      accountOptions,
    );
    if (!response.listenKey) {
      throw new Error("Binance PAPI did not return a listenKey");
    }

    return response.listenKey;
  }

  private async keepAliveUserDataStream(
    credentials: AccountCredentials,
    listenKey: string,
    accountOptions?: Record<string, unknown>,
  ): Promise<void> {
    await this.userStreamRequest<Record<string, never>>(
      "PUT",
      credentials,
      listenKey,
      LISTEN_KEY_KEEPALIVE_RETRY_POLICY,
      accountOptions,
    );
  }

  private async closeUserDataStream(
    credentials: AccountCredentials,
    listenKey: string,
    accountOptions?: Record<string, unknown>,
  ): Promise<void> {
    await this.userStreamRequest<Record<string, never>>(
      "DELETE",
      credentials,
      listenKey,
      NO_RETRY_POLICY,
      accountOptions,
    );
  }

  private async userStreamRequest<T>(
    method: "POST" | "PUT" | "DELETE",
    credentials: AccountCredentials,
    listenKey?: string,
    retryPolicy: HttpRetryPolicy = NO_RETRY_POLICY,
    accountOptions?: Record<string, unknown>,
  ): Promise<T> {
    const { apiKey } = requirePrivateCredentials(credentials);
    const scope = this.rateLimitScope(
      method,
      "/papi/v1/listenKey",
      accountOptions,
    );
    const requestContext = {
      scope,
      planId: getBinancePapiRateLimitPlanId(method, "/papi/v1/listenKey"),
    };
    const reservation =
      (await this.options.rateLimiter?.beforeRequest(requestContext)) ??
      undefined;

    const params = new URLSearchParams();
    if (listenKey) {
      params.set("listenKey", listenKey);
    }

    const query = params.toString();
    const url = `${BINANCE_PAPI_REST_BASE_URL}/papi/v1/listenKey${
      query ? `?${query}` : ""
    }`;
    const timeoutMs = this.options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    try {
      const response = await httpRequest<T>({
        fetchFn: this.options.fetchFn,
        url,
        method,
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
        timeoutMs,
        parseAs: "json",
        emptyBody: "empty_object",
        retryPolicy,
        messages: getBinancePapiHttpMessages(timeoutMs),
      });

      await this.options.rateLimiter?.afterResponse(requestContext, {
        status: response.status,
        headers: response.headers,
        usage: parseBinanceRateLimitUsage(response.headers),
        reservation,
      });

      return response.body;
    } catch (error) {
      if (isTransportError(error)) {
        await this.options.rateLimiter?.onTransportError(requestContext, {
          status: error.status,
          headers: error.headers,
          retryAfterMs: error.retryAfterMs,
          usage: parseBinanceRateLimitUsage(error.headers),
          reservation,
        });
      }

      throw error;
    }
  }

  private rateLimitScope(
    method: string,
    path: string,
    accountOptions?: Record<string, unknown>,
  ): RateLimitScope {
    return {
      venue: "binance",
      accountId: getStringOption(accountOptions, "accountId"),
      endpointKey: `${method} ${path}`,
    };
  }
}
