import { createHmac } from "node:crypto";
import BigNumber from "bignumber.js";
import { toCanonical } from "../../internal/decimal.ts";
import {
  type HttpClientMessages,
  type HttpRetryPolicy,
  httpRequest,
  isTransportError,
} from "../../internal/http-client.ts";
import { createManagedWebSocket } from "../../internal/managed-websocket.ts";
import type {
  AccountCredentials,
  BinanceMarginSideEffectType,
  OrderType,
  PositionSide,
  RateLimiter,
  RateLimitPriority,
  RateLimitScope,
  RiskAlertLevel,
  RiskLevel,
  TimeProvider,
  VenueAccountCapabilities,
  VenueOrderCapabilities,
} from "../../types/index.ts";
import type {
  CancelAllOrdersRequest,
  CancelOrderRequest,
  CreateOrderRequest,
  FetchOrderRequest,
  FetchRiskLimitsRequest,
  FetchSymbolFeeRateRequest,
  FetchSymbolRiskLimitRequest,
  PrivateStreamCallbacks,
  PrivateStreamOptions,
  PrivateUserDataAdapter,
  RawAccountBootstrap,
  RawAccountUpdate,
  RawBalanceUpdate,
  RawOpenOrdersSnapshot,
  RawOrderUpdate,
  RawPositionUpdate,
  RawRiskLevelChange,
  RawRiskUpdate,
  RawSymbolFeeRate,
  RawSymbolLeverageUpdate,
  RawSymbolRiskLimit,
  SetSymbolLeverageRequest,
  StreamHandle,
} from "../types.ts";
import {
  CatalogUnavailableError,
  isSymbolMappingError,
  OrderInputValidationError,
  SymbolMappingError,
  UnsupportedSymbolProductError,
} from "../types.ts";
import { normalizeBinanceErrorCode } from "./error-codes.ts";
import {
  BinanceMarketCatalog,
  type BinanceMarketDefinition,
  type BinanceMarketFamily,
} from "./market-catalog.ts";
import { parseBinanceRateLimitUsage } from "./rate-limit.ts";
import {
  getBinancePapiRateLimitPlanId,
  registerBinanceRateLimitTopology,
} from "./rate-limit-topology.ts";

type TimerHandle = ReturnType<typeof setInterval>;
type SignedRequestMethod = "GET" | "POST" | "DELETE";
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
  accountStatus?: string;
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
  transactTime?: number;
  side?: string;
  type?: string;
  status?: string;
  price?: string;
  stopPrice?: string;
  origQty?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
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

interface BinancePapiUmCommissionRate {
  symbol?: string;
  makerCommissionRate?: string;
  takerCommissionRate?: string;
}

interface BinancePapiUmLeverageBracketItem {
  bracket?: number;
  initialLeverage?: number | string;
  notionalFloor?: number | string;
  notionalCap?: number | string;
  maintMarginRatio?: number | string;
  cum?: number | string;
}

interface BinancePapiUmLeverageBracket {
  symbol?: string;
  notionalCoef?: number | string;
  brackets?: BinancePapiUmLeverageBracketItem[];
}

interface BinancePapiUmLeverageUpdate {
  symbol?: string;
  leverage?: number | string;
  maxNotionalValue?: number | string;
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
  x?: string;
  X?: string;
  p?: string;
  sp?: string;
  q?: string;
  z?: string;
  ap?: string;
  t?: number | string;
  l?: string;
  L?: string;
  n?: string;
  N?: string;
  rp?: string;
  m?: boolean;
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

interface BinanceMarginExecutionReportMessage {
  e?: string;
  E?: number;
  s?: string;
  i?: number | string;
  c?: string;
  S?: string;
  o?: string;
  x?: string;
  X?: string;
  p?: string;
  q?: string;
  z?: string;
  L?: string;
  l?: string;
  n?: string;
  N?: string;
  m?: boolean;
  T?: number;
  t?: number | string;
}

interface BinanceMarginAccountPositionBalance {
  a?: string;
  f?: string;
  l?: string;
}

interface BinanceMarginOutboundAccountPositionMessage {
  e?: string;
  E?: number;
  u?: number;
  B?: BinanceMarginAccountPositionBalance[];
}

interface BinanceMarginBalanceUpdateMessage {
  e?: string;
  E?: number;
  a?: string;
  d?: string;
  T?: number;
}

interface BinanceMarginLiabilityChangeMessage {
  e?: string;
  E?: number;
  a?: string;
  t?: string;
  p?: string;
  i?: string;
  l?: string;
  T?: number;
}

interface BinanceMarginOpenOrderLossMessage {
  e?: string;
  E?: number;
}

interface BinanceListenKeyExpiredMessage {
  e?: string;
  E?: number;
  listenKey?: string;
}

interface BinanceRiskLevelChangeMessage {
  e?: string;
  E?: number;
  u?: string;
  s?: string;
  eq?: string;
  ae?: string;
  m?: string;
}

interface BinanceAccountConfigUpdatePayload {
  s?: string;
  l?: number | string;
}

interface BinanceAccountConfigUpdateMessage {
  e?: string;
  E?: number;
  T?: number;
  ac?: BinanceAccountConfigUpdatePayload;
}

type BinancePrivateMessage =
  | BinanceAccountUpdateMessage
  | BinanceOrderTradeUpdateMessage
  | BinanceMarginExecutionReportMessage
  | BinanceMarginOutboundAccountPositionMessage
  | BinanceMarginBalanceUpdateMessage
  | BinanceMarginLiabilityChangeMessage
  | BinanceMarginOpenOrderLossMessage
  | BinanceListenKeyExpiredMessage
  | BinanceRiskLevelChangeMessage
  | BinanceAccountConfigUpdateMessage;

interface SymbolMappingMiss {
  readonly family: BinanceMarketFamily;
  readonly venueId: string;
}

interface QuarantinedPrivateMessage {
  readonly message: BinancePrivateMessage;
  readonly receivedAt: number;
  readonly misses: SymbolMappingMiss[];
}

const BINANCE_PAPI_REST_BASE_URL = "https://papi.binance.com";
const BINANCE_PAPI_WS_BASE_URL = "wss://fstream.binance.com/pm/ws";
const DEFAULT_RECV_WINDOW = 5_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const BINANCE_PRIVATE_SYMBOL_FAMILY = "usdm" as const;
const BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY = "spot" as const;
const MAX_SYMBOL_MAPPING_QUARANTINE = 64;
const SINGLE_ATTEMPT_IDEMPOTENT_POLICY: HttpRetryPolicy = {
  idempotent: true,
  maxAttempts: 1,
};
const NO_RETRY_POLICY: HttpRetryPolicy = {
  idempotent: false,
  maxAttempts: 1,
};
const BINANCE_ORDER_TYPE_MAP: Record<string, OrderType> = {
  LIMIT: "limit",
  MARKET: "market",
  STOP: "stop",
  STOP_MARKET: "stop_market",
  TAKE_PROFIT: "take_profit",
  TAKE_PROFIT_MARKET: "take_profit_market",
  TRAILING_STOP_MARKET: "trailing_stop_market",
};
const BINANCE_MARGIN_SIDE_EFFECT_TYPE_MAP: Record<
  BinanceMarginSideEffectType,
  string
> = {
  no_side_effect: "NO_SIDE_EFFECT",
  margin_buy: "MARGIN_BUY",
  auto_repay: "AUTO_REPAY",
  auto_borrow_repay: "AUTO_BORROW_REPAY",
};
const BINANCE_RISK_LEVEL_CHANGE_MAP: Record<string, RiskAlertLevel> = {
  MARGIN_CALL: "margin_call",
  REDUCE_ONLY: "reduce_only",
  FORCE_LIQUIDATION: "force_liquidation",
};
const BINANCE_ACCOUNT_CONFIG_POSITION_SIDES: readonly PositionSide[] = [
  "net",
  "long",
  "short",
];
const BINANCE_ACCOUNT_STATUS_RISK_LEVEL_MAP: Record<string, RiskLevel> = {
  NORMAL: "normal",
  MARGIN_CALL: "margin_call",
  SUPPLY_MARGIN: "margin_call",
  REDUCE_ONLY: "reduce_only",
  ACTIVE_LIQUIDATION: "force_liquidation",
  FORCE_LIQUIDATION: "force_liquidation",
  BANKRUPTED: "force_liquidation",
};

type BinancePrivateOrderRoute =
  | {
      product: "um";
      family: typeof BINANCE_PRIVATE_SYMBOL_FAMILY;
      venueId: string;
    }
  | {
      product: "margin";
      family: typeof BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY;
      venueId: string;
    };

function getPrivateOrderProduct(
  definition: BinanceMarketDefinition,
): BinancePrivateOrderRoute["product"] | undefined {
  if (
    definition.family === BINANCE_PRIVATE_SYMBOL_FAMILY &&
    definition.contract === true &&
    (definition.type === "swap" || definition.type === "future")
  ) {
    return "um";
  }

  if (
    definition.family === BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY &&
    definition.contract === false &&
    definition.type === "spot"
  ) {
    return "margin";
  }

  return undefined;
}
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

function canonicalString(
  value: number | string | undefined,
): string | undefined {
  return value === undefined || value === ""
    ? undefined
    : toCanonical(`${value}`);
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

function encodeMarginSideEffectType(
  value?: BinanceMarginSideEffectType,
): string | undefined {
  return value === undefined
    ? undefined
    : BINANCE_MARGIN_SIDE_EFFECT_TYPE_MAP[value];
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

function normalizeOrderType(
  rawType: string | undefined,
): Pick<RawOrderUpdate, "type" | "rawType"> {
  if (!rawType) {
    return { type: "unknown" };
  }

  return {
    type: BINANCE_ORDER_TYPE_MAP[rawType] ?? "unknown",
    rawType,
  };
}

function normalizeRiskAlertLevel(rawLevel: string | undefined): RiskAlertLevel {
  return rawLevel
    ? (BINANCE_RISK_LEVEL_CHANGE_MAP[rawLevel] ?? "margin_call")
    : "margin_call";
}

function normalizeAccountStatusRiskLevel(
  rawStatus: string | undefined,
): RiskLevel | undefined {
  return rawStatus
    ? BINANCE_ACCOUNT_STATUS_RISK_LEVEL_MAP[rawStatus]
    : undefined;
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
    riskLevel: normalizeAccountStatusRiskLevel(input.accountStatus),
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
    !risk.maintenanceMargin &&
    !risk.riskLevel
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
    ? "0"
    : grossExposure.dividedBy(riskEquityValue).toString(10);
}

function mapUmPosition(
  catalog: BinanceMarketCatalog,
  input: BinancePapiUmPosition,
  receivedAt: number,
): RawPositionUpdate | undefined {
  if (!input.symbol) {
    return undefined;
  }

  const symbol = catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, input.symbol);
  if (!symbol) {
    return undefined;
  }

  return {
    symbol,
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
  catalog: BinanceMarketCatalog,
  account: BinancePapiAccount,
  positions: BinancePapiUmPosition[],
  receivedAt: number,
): RawAccountUpdate {
  return {
    positions: positions.flatMap((position) => {
      const mapped = mapUmPosition(catalog, position, receivedAt);
      return mapped ? [mapped] : [];
    }),
    risk: mapAccountRisk(account, receivedAt, positions),
    exchangeTs: account.updateTime,
    receivedAt,
  };
}

function mapAccountBootstrap(
  catalog: BinanceMarketCatalog,
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
      const mapped = mapUmPosition(catalog, position, receivedAt);
      return mapped ? [mapped] : [];
    }),
    risk: mapAccountRisk(account, receivedAt, positions),
    exchangeTs: account.updateTime,
    receivedAt,
  };
}

function mapOpenOrder(
  catalog: BinanceMarketCatalog,
  family: BinancePrivateOrderRoute["family"],
  input: BinancePapiOpenOrder,
  receivedAt: number,
): RawOrderUpdate | undefined {
  const status = normalizeOrderStatus(input.status);
  const orderType = normalizeOrderType(input.type);
  if (!input.symbol || !status) {
    return undefined;
  }

  const symbol = catalog.toUnified(family, input.symbol);
  if (!symbol) {
    return undefined;
  }

  const update: RawOrderUpdate = {
    orderId: input.orderId === undefined ? undefined : `${input.orderId}`,
    clientOrderId: input.clientOrderId,
    symbol,
    side: normalizeOrderSide(input.side),
    ...orderType,
    status,
    price: input.price,
    triggerPrice: input.stopPrice,
    amount: input.origQty ?? "0",
    filled: input.executedQty ?? "0",
    avgFillPrice: input.avgPrice,
    exchangeTs: input.updateTime ?? input.time ?? input.transactTime,
    receivedAt,
  };
  if (family === BINANCE_PRIVATE_SYMBOL_FAMILY) {
    update.reduceOnly = input.reduceOnly;
    update.positionSide = normalizePositionSide(input.positionSide);
  }

  return update;
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
  catalog: BinanceMarketCatalog,
  input: BinanceAccountUpdatePosition,
  exchangeTs: number | undefined,
  receivedAt: number,
): RawPositionUpdate | undefined {
  if (!input.s) {
    return undefined;
  }

  const symbol = catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, input.s);
  if (!symbol) {
    return undefined;
  }

  return {
    symbol,
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
    parsed.e === "executionReport" ||
    parsed.e === "outboundAccountPosition" ||
    parsed.e === "balanceUpdate" ||
    parsed.e === "liabilityChange" ||
    parsed.e === "openOrderLoss" ||
    parsed.e === "listenKeyExpired" ||
    parsed.e === "riskLevelChange" ||
    parsed.e === "ACCOUNT_CONFIG_UPDATE"
    ? parsed
    : undefined;
}

function isAccountUpdateMessage(
  message: BinancePrivateMessage,
): message is BinanceAccountUpdateMessage {
  return message.e === "ACCOUNT_UPDATE";
}

function isOrderTradeUpdateMessage(
  message: BinancePrivateMessage,
): message is BinanceOrderTradeUpdateMessage {
  return message.e === "ORDER_TRADE_UPDATE";
}

function isMarginExecutionReportMessage(
  message: BinancePrivateMessage,
): message is BinanceMarginExecutionReportMessage {
  return message.e === "executionReport";
}

function isMarginOutboundAccountPositionMessage(
  message: BinancePrivateMessage,
): message is BinanceMarginOutboundAccountPositionMessage {
  return message.e === "outboundAccountPosition";
}

function isMarginBalanceUpdateMessage(
  message: BinancePrivateMessage,
): message is BinanceMarginBalanceUpdateMessage {
  return message.e === "balanceUpdate";
}

function isMarginLiabilityChangeMessage(
  message: BinancePrivateMessage,
): message is BinanceMarginLiabilityChangeMessage {
  return message.e === "liabilityChange";
}

function isMarginOpenOrderLossMessage(
  message: BinancePrivateMessage,
): message is BinanceMarginOpenOrderLossMessage {
  return message.e === "openOrderLoss";
}

function isListenKeyExpiredMessage(
  message: BinancePrivateMessage,
): message is BinanceListenKeyExpiredMessage {
  return message.e === "listenKeyExpired";
}

function isRiskLevelChangeMessage(
  message: BinancePrivateMessage,
): message is BinanceRiskLevelChangeMessage {
  return message.e === "riskLevelChange";
}

function isAccountConfigUpdateMessage(
  message: BinancePrivateMessage,
): message is BinanceAccountConfigUpdateMessage {
  return message.e === "ACCOUNT_CONFIG_UPDATE";
}

function mapAccountUpdate(
  catalog: BinanceMarketCatalog,
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
      const mapped = mapAccountUpdatePosition(
        catalog,
        position,
        exchangeTs,
        receivedAt,
      );
      return mapped ? [mapped] : [];
    }),
    exchangeTs,
    receivedAt,
  };
}

function mapRiskLevelChange(
  message: BinanceRiskLevelChangeMessage,
  receivedAt: number,
): RawRiskLevelChange {
  return {
    riskLevel: normalizeRiskAlertLevel(message.s),
    riskRatio: canonicalString(message.u),
    netEquity: canonicalString(message.eq),
    riskEquity: canonicalString(message.ae),
    maintenanceMargin: canonicalString(message.m),
    exchangeTs: message.E,
    receivedAt,
  };
}

function mapAccountConfigUpdate(
  catalog: BinanceMarketCatalog,
  message: BinanceAccountConfigUpdateMessage,
  receivedAt: number,
): RawAccountUpdate | undefined {
  const venueId = message.ac?.s;
  const leverage = canonicalString(message.ac?.l);
  if (!venueId || leverage === undefined) {
    return undefined;
  }

  const symbol = catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, venueId);
  if (!symbol) {
    return undefined;
  }

  const exchangeTs = message.T ?? message.E;
  return {
    positions: BINANCE_ACCOUNT_CONFIG_POSITION_SIDES.map((side) => ({
      symbol,
      side,
      leverage,
      exchangeTs,
      receivedAt,
    })),
    exchangeTs,
    receivedAt,
  };
}

function mapOrderUpdate(
  catalog: BinanceMarketCatalog,
  message: BinanceOrderTradeUpdateMessage,
  receivedAt: number,
): RawOrderUpdate | undefined {
  const payload = message.o;
  const status = normalizeOrderStatus(payload?.X);
  const orderType = normalizeOrderType(payload?.o);
  if (!payload?.s || !status) {
    return undefined;
  }

  const symbol = catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, payload.s);
  if (!symbol) {
    return undefined;
  }

  return {
    orderId: payload.i === undefined ? undefined : `${payload.i}`,
    clientOrderId: payload.c,
    symbol,
    side: normalizeOrderSide(payload.S),
    ...orderType,
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
    trade: mapOrderTrade(payload),
  };
}

function mapOrderTrade(
  payload: BinanceOrderTradeUpdatePayload,
): RawOrderUpdate["trade"] {
  if (payload.x !== "TRADE" || !(Number(payload.l) > 0)) {
    return undefined;
  }

  const fee =
    payload.n !== undefined && payload.N !== undefined
      ? {
          cost: payload.n,
          asset: payload.N,
        }
      : undefined;

  return {
    tradeId: payload.t === undefined ? undefined : `${payload.t}`,
    price: payload.L ?? "0",
    qty: payload.l ?? "0",
    fee,
    realizedPnl: payload.rp,
    maker: payload.m,
    positionSide: normalizePositionSide(payload.ps),
  };
}

function mapMarginExecutionReport(
  catalog: BinanceMarketCatalog,
  message: BinanceMarginExecutionReportMessage,
  receivedAt: number,
): RawOrderUpdate | undefined {
  const status = normalizeOrderStatus(message.X);
  const orderType = normalizeOrderType(message.o);
  if (!message.s || !status) {
    return undefined;
  }

  const symbol = catalog.toUnified(
    BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY,
    message.s,
  );
  if (!symbol) {
    return undefined;
  }

  return {
    orderId: message.i === undefined ? undefined : `${message.i}`,
    clientOrderId: message.c,
    symbol,
    side: normalizeOrderSide(message.S),
    ...orderType,
    status,
    price: message.p,
    amount: message.q ?? "0",
    filled: message.z ?? "0",
    exchangeTs: message.T ?? message.E,
    receivedAt,
    trade: mapMarginOrderTrade(message),
  };
}

function mapMarginOrderTrade(
  message: BinanceMarginExecutionReportMessage,
): RawOrderUpdate["trade"] {
  if (message.x !== "TRADE" || !(Number(message.l) > 0)) {
    return undefined;
  }

  const fee =
    message.n !== undefined && message.N !== undefined
      ? {
          cost: message.n,
          asset: message.N,
        }
      : undefined;

  return {
    tradeId: message.t === undefined ? undefined : `${message.t}`,
    price: message.L ?? "0",
    qty: message.l ?? "0",
    fee,
    maker: message.m,
  };
}

function mapMarginOutboundAccountPosition(
  message: BinanceMarginOutboundAccountPositionMessage,
  receivedAt: number,
): RawAccountUpdate {
  const exchangeTs = message.u ?? message.E;
  return {
    balances: message.B?.flatMap((balance) => {
      if (!balance.a) {
        return [];
      }

      const free = balance.f ?? "0";
      const used = balance.l ?? "0";
      return [
        {
          asset: balance.a,
          free,
          used,
          total: new BigNumber(free).plus(used).toString(10),
          exchangeTs,
          receivedAt,
        },
      ];
    }),
    exchangeTs,
    receivedAt,
  };
}

function mapMarginLiabilityChange(
  message: BinanceMarginLiabilityChangeMessage,
  receivedAt: number,
): RawAccountUpdate | undefined {
  if (!message.a) {
    return undefined;
  }

  const exchangeTs = message.T ?? message.E;
  const borrowed = canonicalString(message.l);
  const interest = canonicalString(message.i);
  return {
    balances: [
      {
        asset: message.a,
        lending: {
          borrowed,
          interest,
        },
        exchangeTs,
        receivedAt,
      },
    ],
    exchangeTs,
    receivedAt,
  };
}

function mapCommissionRate(
  response: BinancePapiUmCommissionRate,
  symbol: string,
  receivedAt: number,
): RawSymbolFeeRate {
  if (!response.makerCommissionRate || !response.takerCommissionRate) {
    throw new Error("Binance PAPI commissionRate response is missing rates");
  }

  return {
    symbol,
    maker: response.makerCommissionRate,
    taker: response.takerCommissionRate,
    receivedAt,
  };
}

function mapRiskLimitTier(
  input: BinancePapiUmLeverageBracketItem,
): RawSymbolRiskLimit["tiers"][number] | undefined {
  if (input.bracket === undefined || input.initialLeverage === undefined) {
    return undefined;
  }

  return {
    tier: input.bracket,
    initialLeverage: `${input.initialLeverage}`,
    notionalFloor: canonicalString(input.notionalFloor),
    notionalCap: canonicalString(input.notionalCap),
    maintenanceMarginRatio: canonicalString(input.maintMarginRatio),
    cumulativeMaintenanceAmount: canonicalString(input.cum),
  };
}

function mapRiskLimitBracket(
  catalog: BinanceMarketCatalog,
  input: BinancePapiUmLeverageBracket,
  receivedAt: number,
): RawSymbolRiskLimit | undefined {
  if (!input.symbol || !Array.isArray(input.brackets)) {
    return undefined;
  }

  const symbol = catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, input.symbol);
  if (!symbol) {
    return undefined;
  }

  return {
    symbol,
    tiers: input.brackets.flatMap((bracket) => {
      const mapped = mapRiskLimitTier(bracket);
      return mapped ? [mapped] : [];
    }),
    notionalCoefficient: canonicalString(input.notionalCoef),
    receivedAt,
  };
}

function normalizeRiskLimitBracketsResponse(
  response: BinancePapiUmLeverageBracket | BinancePapiUmLeverageBracket[],
): BinancePapiUmLeverageBracket[] {
  return Array.isArray(response) ? response : [response];
}

function mapLeverageUpdate(
  catalog: BinanceMarketCatalog,
  response: BinancePapiUmLeverageUpdate,
  fallbackSymbol: string,
  receivedAt: number,
): RawSymbolLeverageUpdate {
  const symbol = response.symbol
    ? (catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, response.symbol) ??
      fallbackSymbol)
    : fallbackSymbol;
  if (response.leverage === undefined) {
    throw new Error("Binance PAPI leverage response is missing leverage");
  }

  return {
    symbol,
    leverage: `${response.leverage}`,
    maxNotionalValue: canonicalString(response.maxNotionalValue),
    receivedAt,
  };
}

function missingUmPositionVenueIds(
  catalog: BinanceMarketCatalog,
  positions: BinancePapiUmPosition[],
): string[] {
  return uniqueStrings(
    positions.flatMap((position) =>
      position.symbol &&
      !catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, position.symbol)
        ? [position.symbol]
        : [],
    ),
  );
}

function missingOpenOrderVenueIds(
  catalog: BinanceMarketCatalog,
  family: BinancePrivateOrderRoute["family"],
  orders: BinancePapiOpenOrder[],
): string[] {
  return uniqueStrings(
    orders.flatMap((order) =>
      order.symbol && !catalog.toUnified(family, order.symbol)
        ? [order.symbol]
        : [],
    ),
  );
}

function missingRiskLimitVenueIds(
  catalog: BinanceMarketCatalog,
  brackets: BinancePapiUmLeverageBracket[],
): string[] {
  return uniqueStrings(
    brackets.flatMap((entry) =>
      entry.symbol &&
      !catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, entry.symbol)
        ? [entry.symbol]
        : [],
    ),
  );
}

function missingAccountUpdateVenueIds(
  catalog: BinanceMarketCatalog,
  message: BinanceAccountUpdateMessage,
): string[] {
  return uniqueStrings(
    (message.a?.P ?? []).flatMap((position) =>
      position.s &&
      !catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, position.s)
        ? [position.s]
        : [],
    ),
  );
}

function firstMissingAccountUpdateVenueId(
  catalog: BinanceMarketCatalog,
  message: BinanceAccountUpdateMessage,
): string | undefined {
  for (const position of message.a?.P ?? []) {
    if (
      position.s &&
      !catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, position.s)
    ) {
      return position.s;
    }
  }

  return undefined;
}

function missingAccountConfigUpdateVenueId(
  catalog: BinanceMarketCatalog,
  message: BinanceAccountConfigUpdateMessage,
): SymbolMappingMiss | undefined {
  const venueId = message.ac?.s;
  if (venueId && !catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, venueId)) {
    return { family: BINANCE_PRIVATE_SYMBOL_FAMILY, venueId };
  }

  return undefined;
}

function missingOrderUpdateVenueId(
  catalog: BinanceMarketCatalog,
  message: BinanceOrderTradeUpdateMessage,
): SymbolMappingMiss | undefined {
  const venueId = message.o?.s;
  if (venueId && !catalog.toUnified(BINANCE_PRIVATE_SYMBOL_FAMILY, venueId)) {
    return { family: BINANCE_PRIVATE_SYMBOL_FAMILY, venueId };
  }

  return undefined;
}

function missingMarginExecutionReportVenueId(
  catalog: BinanceMarketCatalog,
  message: BinanceMarginExecutionReportMessage,
): SymbolMappingMiss | undefined {
  const venueId = message.s;
  if (
    venueId &&
    !catalog.toUnified(BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY, venueId)
  ) {
    return { family: BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY, venueId };
  }

  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueSymbolMappingMisses(
  misses: readonly SymbolMappingMiss[],
): SymbolMappingMiss[] {
  const seen = new Set<string>();
  const unique: SymbolMappingMiss[] = [];
  for (const miss of misses) {
    const key = `${miss.family}:${miss.venueId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(miss);
  }
  return unique;
}

function groupMissesByFamily(
  misses: readonly SymbolMappingMiss[],
): Map<BinanceMarketFamily, string[]> {
  const grouped = new Map<BinanceMarketFamily, string[]>();
  for (const miss of uniqueSymbolMappingMisses(misses)) {
    const venueIds = grouped.get(miss.family) ?? [];
    venueIds.push(miss.venueId);
    grouped.set(miss.family, venueIds);
  }
  return grouped;
}

function isBinanceOrderNotFound(error: unknown): boolean {
  if (!isTransportError(error) || error.kind !== "http") {
    return false;
  }

  if (error.status !== 400 && error.status !== 404) {
    return false;
  }

  return (
    normalizeBinanceErrorReasonFromRawBody(error.rawBody) === "order_not_found"
  );
}

function normalizeBinanceErrorReasonFromRawBody(
  rawBody: string | undefined,
): ReturnType<typeof normalizeBinanceErrorCode> | undefined {
  if (!rawBody) {
    return undefined;
  }

  try {
    return normalizeBinanceErrorReasonFromPayload(JSON.parse(rawBody));
  } catch {
    return undefined;
  }
}

function normalizeBinanceErrorReasonFromPayload(
  payload: unknown,
): ReturnType<typeof normalizeBinanceErrorCode> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const code = (payload as Record<string, unknown>).code;
  if (typeof code !== "string" && typeof code !== "number") {
    return undefined;
  }

  return normalizeBinanceErrorCode(`${code}`);
}

function requestSigningClockResyncIfTimestampOutOfSync(
  signingClock: TimeProvider | undefined,
  reason: ReturnType<typeof normalizeBinanceErrorCode> | undefined,
): void {
  if (reason !== "timestamp_out_of_sync") {
    return;
  }

  signingClock?.requestResync?.();
}

export class BinancePrivateAdapter implements PrivateUserDataAdapter {
  readonly venue = "binance" as const;
  readonly readOnly = false;
  readonly notes = [
    "Capabilities describe the current SDK runtime, not Binance's full exchange API surface.",
    "Funding rate support depends on the market type.",
    "Order commands route Binance PAPI UM and PAPI margin by symbol; venue-level order.supported does not mean every Binance market type is orderable.",
  ];
  readonly accountCapabilities: VenueAccountCapabilities = {
    register: "supported",
    snapshot: "supported",
    updates: "websocket",
    balances: "supported",
    positions: "supported",
    risk: "supported",
    lending: "supported",
    credentialsRequired: true,
  };
  readonly orderCapabilities: VenueOrderCapabilities = {
    supported: true,
    openOrders: "supported",
    updates: "websocket",
    fees: "supported",
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
  private readonly marketCatalog: BinanceMarketCatalog;

  constructor(
    private readonly options: {
      readonly fetchFn?: FetchLike;
      readonly httpTimeoutMs?: number;
      readonly signingClock?: TimeProvider;
      readonly rateLimiter?: RateLimiter;
      readonly marketCatalog?: BinanceMarketCatalog;
    } = {},
  ) {
    this.marketCatalog =
      options.marketCatalog ??
      new BinanceMarketCatalog({
        fetchFn: options.fetchFn,
        rateLimiter: this.options.rateLimiter,
      });
    registerBinanceRateLimitTopology(this.options.rateLimiter);
  }

  normalizeVenueErrorCode(code: string) {
    return normalizeBinanceErrorCode(code);
  }

  async bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap> {
    await this.ensureUsdmCatalog();
    const receivedAt = Date.now();
    const [balances, account, positions] = await Promise.all([
      this.signedRequest<BinancePapiBalance[]>(
        "GET",
        "/papi/v1/balance",
        credentials,
        accountOptions,
        undefined,
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      ),
      this.signedRequest<BinancePapiAccount>(
        "GET",
        "/papi/v1/account",
        credentials,
        accountOptions,
        undefined,
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      ),
      this.signedRequest<BinancePapiUmPosition[]>(
        "GET",
        "/papi/v1/um/positionRisk",
        credentials,
        accountOptions,
        undefined,
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      ),
    ]);

    return await this.mapAccountBootstrapWithCatalogRefresh(
      balances,
      account,
      positions,
      receivedAt,
    );
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
    await this.ensureUsdmCatalog();
    const receivedAt = Date.now();
    const [account, positions] = await Promise.all([
      this.signedRequest<BinancePapiAccount>(
        "GET",
        "/papi/v1/account",
        credentials,
        accountOptions,
        undefined,
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      ),
      this.signedRequest<BinancePapiUmPosition[]>(
        "GET",
        "/papi/v1/um/positionRisk",
        credentials,
        accountOptions,
        undefined,
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      ),
    ]);

    return await this.mapAccountRefreshWithCatalogRefresh(
      account,
      positions,
      receivedAt,
    );
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
    await Promise.all([this.ensureUsdmCatalog(), this.ensureSpotCatalog()]);
    const receivedAt = Date.now();
    const [umOrders, marginOrders] = await Promise.all([
      this.signedRequest<BinancePapiOpenOrder[]>(
        "GET",
        "/papi/v1/um/openOrders",
        credentials,
        accountOptions,
        undefined,
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      ),
      this.signedRequest<BinancePapiOpenOrder[]>(
        "GET",
        "/papi/v1/margin/openOrders",
        credentials,
        accountOptions,
        undefined,
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      ),
    ]);

    return {
      orders: [
        ...(await this.mapOpenOrdersWithCatalogRefresh(
          BINANCE_PRIVATE_SYMBOL_FAMILY,
          umOrders,
          receivedAt,
        )),
        ...(await this.mapOpenOrdersWithCatalogRefresh(
          BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY,
          marginOrders,
          receivedAt,
        )),
      ],
      snapshotReceivedAt: receivedAt,
    };
  }

  async fetchOrder(
    credentials: AccountCredentials,
    request: FetchOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate | undefined> {
    const receivedAt = Date.now();
    const route = await this.resolvePrivateOrderRoute(request.symbol);
    try {
      const response = await this.signedRequest<BinancePapiOpenOrder>(
        "GET",
        `/papi/v1/${route.product}/order`,
        credentials,
        accountOptions,
        {
          symbol: route.venueId,
          orderId: request.orderId,
          origClientOrderId: request.clientOrderId,
        },
        SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      );

      return await this.mapOpenOrderWithCatalogRefresh(
        route.family,
        response,
        receivedAt,
      );
    } catch (error) {
      if (isBinanceOrderNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async fetchSymbolFeeRate(
    credentials: AccountCredentials,
    request: FetchSymbolFeeRateRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolFeeRate> {
    const symbol = await this.toUsdmVenueIdForCommand(request.symbol);
    const response = await this.signedRequest<BinancePapiUmCommissionRate>(
      "GET",
      "/papi/v1/um/commissionRate",
      credentials,
      accountOptions,
      {
        symbol,
      },
      SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
    );
    const receivedAt = Date.now();

    return mapCommissionRate(response, request.symbol, receivedAt);
  }

  async fetchSymbolRiskLimit(
    credentials: AccountCredentials,
    request: FetchSymbolRiskLimitRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolRiskLimit> {
    const symbol = await this.toUsdmVenueIdForCommand(request.symbol);
    const response = await this.signedRequest<
      BinancePapiUmLeverageBracket | BinancePapiUmLeverageBracket[]
    >(
      "GET",
      "/papi/v1/um/leverageBracket",
      credentials,
      accountOptions,
      {
        symbol,
      },
      SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
    );
    const receivedAt = Date.now();
    const mapped = await this.mapRiskLimitBracketsWithCatalogRefresh(
      normalizeRiskLimitBracketsResponse(response),
      receivedAt,
    );
    const riskLimit = mapped.find((entry) => entry.symbol === request.symbol);
    if (!riskLimit) {
      throw new Error(
        "Binance PAPI leverageBracket response did not contain the requested symbol",
      );
    }

    return riskLimit;
  }

  async fetchRiskLimits(
    credentials: AccountCredentials,
    _request: FetchRiskLimitsRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolRiskLimit[]> {
    await this.ensureUsdmCatalog();
    const response = await this.signedRequest<BinancePapiUmLeverageBracket[]>(
      "GET",
      "/papi/v1/um/leverageBracket",
      credentials,
      accountOptions,
      undefined,
      SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
    );
    const receivedAt = Date.now();

    return await this.mapRiskLimitBracketsWithCatalogRefresh(
      response,
      receivedAt,
    );
  }

  async setSymbolLeverage(
    credentials: AccountCredentials,
    request: SetSymbolLeverageRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolLeverageUpdate> {
    const symbol = await this.toUsdmVenueIdForCommand(request.symbol);
    const response = await this.signedRequest<BinancePapiUmLeverageUpdate>(
      "POST",
      "/papi/v1/um/leverage",
      credentials,
      accountOptions,
      {
        symbol,
        leverage: request.leverage,
      },
      NO_RETRY_POLICY,
      "risk",
    );
    const receivedAt = Date.now();

    return mapLeverageUpdate(
      this.marketCatalog,
      response,
      request.symbol,
      receivedAt,
    );
  }

  async createOrder(
    credentials: AccountCredentials,
    request: CreateOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate> {
    const receivedAt = Date.now();
    const route = await this.resolvePrivateOrderRoute(request.symbol);
    this.assertCreateOrderProductOptions(route, request);
    const queryParams =
      route.product === "um"
        ? {
            symbol: route.venueId,
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
              request.um?.reduceOnly === undefined
                ? undefined
                : `${request.um.reduceOnly}`,
            positionSide: encodePositionSide(request.um?.positionSide),
          }
        : {
            symbol: route.venueId,
            side: encodeOrderSide(request.side),
            type: encodeOrderType(request.type),
            quantity: request.amount,
            price: request.price,
            timeInForce: request.type === "limit" ? "GTC" : undefined,
            newClientOrderId: request.clientOrderId,
            sideEffectType: encodeMarginSideEffectType(
              request.margin?.sideEffectType,
            ),
            autoRepayAtCancel:
              request.margin?.autoRepayAtCancel === undefined
                ? undefined
                : `${request.margin.autoRepayAtCancel}`,
          };
    const response = await this.signedRequest<BinancePapiOpenOrder>(
      "POST",
      `/papi/v1/${route.product}/order`,
      credentials,
      accountOptions,
      queryParams,
      NO_RETRY_POLICY,
    );

    const mapped = await this.mapOpenOrderWithCatalogRefresh(
      route.family,
      response,
      receivedAt,
    );
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
    const route = await this.resolvePrivateOrderRoute(request.symbol);
    const response = await this.signedRequest<BinancePapiOpenOrder>(
      "DELETE",
      `/papi/v1/${route.product}/order`,
      credentials,
      accountOptions,
      {
        symbol: route.venueId,
        orderId: request.orderId,
        origClientOrderId: request.clientOrderId,
      },
      NO_RETRY_POLICY,
      "cancel",
    );

    const mapped = await this.mapOpenOrderWithCatalogRefresh(
      route.family,
      response,
      receivedAt,
    );
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
    const route = await this.resolvePrivateOrderRoute(request.symbol);
    const openOrders = await this.signedRequest<BinancePapiOpenOrder[]>(
      "GET",
      `/papi/v1/${route.product}/openOrders`,
      credentials,
      accountOptions,
      {
        symbol: route.venueId,
      },
      SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
      "cancel",
    );

    // Venue responds {code,msg}; returned updates are synthesized from the
    // pre-fetch. Orders that fill between fetch and cancel are corrected by
    // the WS terminal event / reconcile.
    const response = await this.signedRequest<BinancePapiCancelAllResponse>(
      "DELETE",
      `/papi/v1/${route.product}/allOpenOrders`,
      credentials,
      accountOptions,
      {
        symbol: route.venueId,
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
    const mappedOrders = await this.mapOpenOrdersWithCatalogRefresh(
      route.family,
      openOrders,
      receivedAt,
    );
    return mappedOrders.map((order) => ({
      ...order,
      status: "canceled",
      exchangeTs: undefined,
      receivedAt,
    }));
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
    let symbolMappingRefreshInFlight: Promise<void> | undefined;
    let symbolMappingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const symbolMappingQuarantine: QuarantinedPrivateMessage[] = [];
    let openedOnce = false;

    const clearRecoveryRetry = () => {
      if (recoveryRetryTimer) {
        clearTimeout(recoveryRetryTimer);
        recoveryRetryTimer = undefined;
      }
    };

    const clearSymbolMappingRefreshTimer = () => {
      if (symbolMappingRefreshTimer) {
        clearTimeout(symbolMappingRefreshTimer);
        symbolMappingRefreshTimer = undefined;
      }
    };

    /**
     * Returns `true` when a replayed message had to be dropped because its
     * symbol is still unmapped after the catalog refresh.
     */
    const dispatchPrivateMessage = (
      message: BinancePrivateMessage,
      receivedAt: number,
      replaying: boolean,
    ): boolean => {
      if (isListenKeyExpiredMessage(message)) {
        recoverPrivateStream("listen_key_expired");
        return false;
      }

      if (isRiskLevelChangeMessage(message)) {
        callbacks.onRiskLevelChange(mapRiskLevelChange(message, receivedAt));
        return false;
      }

      if (isAccountConfigUpdateMessage(message)) {
        const missing = missingAccountConfigUpdateVenueId(
          this.marketCatalog,
          message,
        );
        if (missing) {
          if (replaying) {
            this.reportSymbolMappingMisses([missing]);
            return true;
          }
          quarantineSymbolMappingMiss(message, receivedAt, [missing]);
          return false;
        }

        const accountUpdate = mapAccountConfigUpdate(
          this.marketCatalog,
          message,
          receivedAt,
        );
        if (accountUpdate) {
          callbacks.onAccountUpdate(accountUpdate);
        }
        return false;
      }

      if (isAccountUpdateMessage(message)) {
        const firstMissing = firstMissingAccountUpdateVenueId(
          this.marketCatalog,
          message,
        );
        if (firstMissing) {
          const misses = missingAccountUpdateVenueIds(
            this.marketCatalog,
            message,
          ).map((venueId) => ({
            family: BINANCE_PRIVATE_SYMBOL_FAMILY,
            venueId,
          }));
          if (replaying) {
            this.reportSymbolMappingMisses(misses);
            return true;
          }
          quarantineSymbolMappingMiss(message, receivedAt, misses);
          return false;
        }

        callbacks.onAccountUpdate(
          mapAccountUpdate(this.marketCatalog, message, receivedAt),
        );
        return false;
      }

      if (isMarginOutboundAccountPositionMessage(message)) {
        callbacks.onAccountUpdate(
          mapMarginOutboundAccountPosition(message, receivedAt),
        );
        return false;
      }

      if (isMarginBalanceUpdateMessage(message)) {
        return false;
      }

      if (isMarginLiabilityChangeMessage(message)) {
        const accountUpdate = mapMarginLiabilityChange(message, receivedAt);
        if (accountUpdate) {
          callbacks.onAccountUpdate(accountUpdate);
        }
        return false;
      }

      if (isMarginOpenOrderLossMessage(message)) {
        callbacks.requestReconcile?.("margin_open_order_loss");
        return false;
      }

      if (isMarginExecutionReportMessage(message)) {
        const missing = missingMarginExecutionReportVenueId(
          this.marketCatalog,
          message,
        );
        if (missing) {
          if (replaying) {
            this.reportSymbolMappingMisses([missing]);
            return true;
          }
          quarantineSymbolMappingMiss(message, receivedAt, [missing]);
          return false;
        }

        const orderUpdate = mapMarginExecutionReport(
          this.marketCatalog,
          message,
          receivedAt,
        );
        if (orderUpdate) {
          callbacks.onOrderUpdate(orderUpdate);
        }
        return false;
      }

      if (!isOrderTradeUpdateMessage(message)) {
        return false;
      }

      const missing = missingOrderUpdateVenueId(this.marketCatalog, message);
      if (missing) {
        if (replaying) {
          this.reportSymbolMappingMisses([missing]);
          return true;
        }
        quarantineSymbolMappingMiss(message, receivedAt, [missing]);
        return false;
      }

      const orderUpdate = mapOrderUpdate(
        this.marketCatalog,
        message,
        receivedAt,
      );
      if (orderUpdate) {
        callbacks.onOrderUpdate(orderUpdate);
      }
      return false;
    };

    const quarantinedMisses = () =>
      uniqueSymbolMappingMisses(
        symbolMappingQuarantine.flatMap((entry) => entry.misses),
      );

    const requestReconcileForSymbolMappingMiss = () => {
      if (closed) {
        return;
      }

      callbacks.requestReconcile?.("symbol_mapping_miss");
    };

    const drainSymbolMappingQuarantine = async (): Promise<void> => {
      const misses = quarantinedMisses();
      if (misses.length === 0) {
        return;
      }

      const refreshResult = await this.refreshCatalogsAfterMiss(misses);
      if (closed || !refreshResult) {
        return;
      }

      // Per order-execution.md §3.3.1 the immediate reconcile compensates for
      // dropped events only; a fully replayed quarantine must not flip the
      // account/order runtime status.
      const replay = symbolMappingQuarantine.splice(0);
      let droppedAfterReplay = false;
      for (const entry of replay) {
        if (closed) {
          return;
        }

        droppedAfterReplay =
          dispatchPrivateMessage(entry.message, entry.receivedAt, true) ||
          droppedAfterReplay;
      }

      if (droppedAfterReplay) {
        requestReconcileForSymbolMappingMiss();
      }
    };

    const scheduleSymbolMappingRefresh = (delayMs = 0) => {
      if (closed || symbolMappingRefreshInFlight) {
        return;
      }

      if (symbolMappingRefreshTimer) {
        if (delayMs > 0) {
          return;
        }

        clearSymbolMappingRefreshTimer();
      }

      if (delayMs > 0) {
        symbolMappingRefreshTimer = setTimeout(() => {
          symbolMappingRefreshTimer = undefined;
          scheduleSymbolMappingRefresh();
        }, delayMs);
        return;
      }

      symbolMappingRefreshInFlight = drainSymbolMappingQuarantine().finally(
        () => {
          symbolMappingRefreshInFlight = undefined;
          if (!closed && symbolMappingQuarantine.length > 0) {
            scheduleSymbolMappingRefresh(
              this.getMissRefreshDelayMs(quarantinedMisses()),
            );
          }
        },
      );
    };

    const quarantineSymbolMappingMiss = (
      message: BinancePrivateMessage,
      receivedAt: number,
      misses: SymbolMappingMiss[],
    ) => {
      if (symbolMappingQuarantine.length >= MAX_SYMBOL_MAPPING_QUARANTINE) {
        const dropped = symbolMappingQuarantine.shift();
        if (dropped) {
          this.reportSymbolMappingMisses(dropped.misses);
          requestReconcileForSymbolMappingMiss();
        }
      }

      symbolMappingQuarantine.push({
        message,
        receivedAt,
        misses,
      });
      scheduleSymbolMappingRefresh();
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

          dispatchPrivateMessage(message, receivedAt, false);
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
      await this.ensureUsdmCatalog();
      if (closed) {
        return;
      }

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
        clearSymbolMappingRefreshTimer();
        symbolMappingQuarantine.length = 0;
        closeSession(activeSession, true);
        activeSession = undefined;
      },
    };
  }

  private async ensureUsdmCatalog(): Promise<void> {
    await this.marketCatalog.ensureLoaded(BINANCE_PRIVATE_SYMBOL_FAMILY);
  }

  private async ensureSpotCatalog(): Promise<void> {
    await this.marketCatalog.ensureLoaded(BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY);
  }

  private async ensureUsdmCatalogForCommand(symbol: string): Promise<void> {
    try {
      await this.ensureUsdmCatalog();
    } catch (error) {
      throw this.createCatalogUnavailableError(symbol, error);
    }
  }

  private async toUsdmVenueIdForCommand(symbol: string): Promise<string> {
    await this.ensureUsdmCatalogForCommand(symbol);

    try {
      return this.marketCatalog.toVenueId(
        BINANCE_PRIVATE_SYMBOL_FAMILY,
        symbol,
      );
    } catch (error) {
      if (!isSymbolMappingError(error)) {
        throw error;
      }
    }

    try {
      await this.marketCatalog.refreshFamilyAfterMiss(
        BINANCE_PRIVATE_SYMBOL_FAMILY,
        [symbol],
      );
    } catch (error) {
      throw this.createCatalogUnavailableError(symbol, error);
    }

    return this.marketCatalog.toVenueId(BINANCE_PRIVATE_SYMBOL_FAMILY, symbol);
  }

  private createCatalogUnavailableError(
    symbol: string | undefined,
    cause: unknown,
    family: BinanceMarketFamily = BINANCE_PRIVATE_SYMBOL_FAMILY,
  ): CatalogUnavailableError {
    return new CatalogUnavailableError({
      venue: "binance",
      family,
      symbol,
      cause,
    });
  }

  private async resolvePrivateOrderRoute(
    symbol: string,
  ): Promise<BinancePrivateOrderRoute> {
    const [usdm, spot] = await Promise.allSettled([
      this.lookupPrivateOrderRouteFamily(BINANCE_PRIVATE_SYMBOL_FAMILY, symbol),
      this.lookupPrivateOrderRouteFamily(
        BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY,
        symbol,
      ),
    ]);

    const usdmResult =
      usdm.status === "fulfilled" ? usdm.value : { unavailable: usdm.reason };
    const spotResult =
      spot.status === "fulfilled" ? spot.value : { unavailable: spot.reason };

    if ("route" in usdmResult && usdmResult.route) {
      return usdmResult.route;
    }
    if ("route" in spotResult && spotResult.route) {
      return spotResult.route;
    }

    const unsupported = await this.lookupUnsupportedCoinmOrderRoute(symbol);
    if (unsupported) {
      throw unsupported;
    }

    if ("unavailable" in usdmResult) {
      throw this.createCatalogUnavailableError(
        symbol,
        usdmResult.unavailable,
        BINANCE_PRIVATE_SYMBOL_FAMILY,
      );
    }
    if ("unavailable" in spotResult) {
      throw this.createCatalogUnavailableError(
        symbol,
        spotResult.unavailable,
        BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY,
      );
    }

    throw new SymbolMappingError({
      venue: "binance",
      family: "spot/usdm",
      symbol,
      direction: "to_venue",
    });
  }

  private async lookupPrivateOrderRouteFamily(
    family: typeof BINANCE_PRIVATE_SYMBOL_FAMILY,
    symbol: string,
  ): Promise<{ route?: BinancePrivateOrderRoute }>;
  private async lookupPrivateOrderRouteFamily(
    family: typeof BINANCE_PRIVATE_MARGIN_SYMBOL_FAMILY,
    symbol: string,
  ): Promise<{ route?: BinancePrivateOrderRoute }>;
  private async lookupPrivateOrderRouteFamily(
    family: BinancePrivateOrderRoute["family"],
    symbol: string,
  ): Promise<{ route?: BinancePrivateOrderRoute }> {
    await this.marketCatalog.ensureLoaded(family);
    let definition = this.marketCatalog.getDefinition(family, symbol);
    if (!definition) {
      await this.marketCatalog.refreshFamilyAfterMiss(family, [symbol]);
      definition = this.marketCatalog.getDefinition(family, symbol);
    }

    if (!definition) {
      return {};
    }

    const product = getPrivateOrderProduct(definition);
    if (!product) {
      return {};
    }

    return {
      route: {
        product,
        family,
        venueId: definition.id,
      } as BinancePrivateOrderRoute,
    };
  }

  private async lookupUnsupportedCoinmOrderRoute(
    symbol: string,
  ): Promise<UnsupportedSymbolProductError | undefined> {
    try {
      await this.marketCatalog.ensureLoaded("coinm");
      let definition = this.marketCatalog.getDefinition("coinm", symbol);
      if (!definition) {
        await this.marketCatalog.refreshFamilyAfterMiss("coinm", [symbol]);
        definition = this.marketCatalog.getDefinition("coinm", symbol);
      }

      return definition
        ? new UnsupportedSymbolProductError({
            venue: "binance",
            family: definition.family,
            symbol,
          })
        : undefined;
    } catch {
      return undefined;
    }
  }

  private assertCreateOrderProductOptions(
    route: BinancePrivateOrderRoute,
    request: CreateOrderRequest,
  ): void {
    if (request.um !== undefined && request.margin !== undefined) {
      throw new OrderInputValidationError(
        "Binance createOrder cannot include both um and margin options",
      );
    }

    if (route.product === "um" && request.margin !== undefined) {
      throw new OrderInputValidationError(
        "Binance UM orders do not accept margin order options",
      );
    }

    if (route.product === "margin" && request.um !== undefined) {
      throw new OrderInputValidationError(
        "Binance margin orders do not accept UM order options",
      );
    }

    if (route.product === "margin" && request.postOnly === true) {
      throw new OrderInputValidationError(
        "Binance margin orders do not support postOnly in this SDK version",
      );
    }
  }

  private async refreshUsdmCatalogAfterMiss(
    venueIds: readonly string[],
  ): Promise<"refreshed" | "cooldown" | "failed"> {
    return this.refreshCatalogAfterMiss(
      BINANCE_PRIVATE_SYMBOL_FAMILY,
      venueIds,
    );
  }

  private async refreshCatalogAfterMiss(
    family: BinanceMarketFamily,
    venueIds: readonly string[],
  ): Promise<"refreshed" | "cooldown" | "failed"> {
    try {
      return await this.marketCatalog.refreshFamilyAfterMiss(family, venueIds);
    } catch {
      // The catalog keeps the previous atomic snapshot and reports the failure
      // through the injected runtime error publisher. The caller keeps
      // quarantined messages and retries after the miss cooldown.
      return "failed";
    }
  }

  private async refreshCatalogsAfterMiss(
    misses: readonly SymbolMappingMiss[],
  ): Promise<boolean> {
    const byFamily = new Map<BinanceMarketFamily, string[]>();
    for (const miss of uniqueSymbolMappingMisses(misses)) {
      const familyMisses = byFamily.get(miss.family) ?? [];
      familyMisses.push(miss.venueId);
      byFamily.set(miss.family, familyMisses);
    }

    const results = await Promise.all(
      [...byFamily.entries()].map(([family, venueIds]) =>
        this.refreshCatalogAfterMiss(family, venueIds),
      ),
    );
    return results.includes("refreshed");
  }

  private getMissRefreshDelayMs(misses: readonly SymbolMappingMiss[]): number {
    const delays = [...groupMissesByFamily(misses).entries()].map(
      ([family, venueIds]) =>
        this.marketCatalog.getMissRefreshDelayMs(family, venueIds),
    );
    return delays.length === 0 ? 0 : Math.min(...delays);
  }

  private reportSymbolMappingMisses(
    misses: readonly SymbolMappingMiss[],
  ): void {
    for (const miss of uniqueSymbolMappingMisses(misses)) {
      this.marketCatalog.reportSymbolMappingMiss(miss.family, miss.venueId);
    }
  }

  private async mapAccountBootstrapWithCatalogRefresh(
    balances: BinancePapiBalance[],
    account: BinancePapiAccount,
    positions: BinancePapiUmPosition[],
    receivedAt: number,
  ): Promise<RawAccountBootstrap> {
    let missing = missingUmPositionVenueIds(this.marketCatalog, positions);
    if (missing.length > 0) {
      await this.refreshUsdmCatalogAfterMiss(missing);
      missing = missingUmPositionVenueIds(this.marketCatalog, positions);
      this.reportSymbolMappingMisses(
        missing.map((venueId) => ({
          family: BINANCE_PRIVATE_SYMBOL_FAMILY,
          venueId,
        })),
      );
    }

    return mapAccountBootstrap(
      this.marketCatalog,
      balances,
      account,
      positions,
      receivedAt,
    );
  }

  private async mapAccountRefreshWithCatalogRefresh(
    account: BinancePapiAccount,
    positions: BinancePapiUmPosition[],
    receivedAt: number,
  ): Promise<RawAccountUpdate> {
    let missing = missingUmPositionVenueIds(this.marketCatalog, positions);
    if (missing.length > 0) {
      await this.refreshUsdmCatalogAfterMiss(missing);
      missing = missingUmPositionVenueIds(this.marketCatalog, positions);
      this.reportSymbolMappingMisses(
        missing.map((venueId) => ({
          family: BINANCE_PRIVATE_SYMBOL_FAMILY,
          venueId,
        })),
      );
    }

    return mapAccountRefresh(
      this.marketCatalog,
      account,
      positions,
      receivedAt,
    );
  }

  private async mapOpenOrdersWithCatalogRefresh(
    family: BinancePrivateOrderRoute["family"],
    orders: BinancePapiOpenOrder[],
    receivedAt: number,
  ): Promise<RawOrderUpdate[]> {
    let missing = missingOpenOrderVenueIds(this.marketCatalog, family, orders);
    if (missing.length > 0) {
      await this.refreshCatalogAfterMiss(family, missing);
      missing = missingOpenOrderVenueIds(this.marketCatalog, family, orders);
      this.reportSymbolMappingMisses(
        missing.map((venueId) => ({ family, venueId })),
      );
    }

    return orders.flatMap((order) => {
      const mapped = mapOpenOrder(
        this.marketCatalog,
        family,
        order,
        receivedAt,
      );
      return mapped ? [mapped] : [];
    });
  }

  private async mapOpenOrderWithCatalogRefresh(
    family: BinancePrivateOrderRoute["family"],
    order: BinancePapiOpenOrder,
    receivedAt: number,
  ): Promise<RawOrderUpdate | undefined> {
    const mapped = await this.mapOpenOrdersWithCatalogRefresh(
      family,
      [order],
      receivedAt,
    );
    return mapped[0];
  }

  private async mapRiskLimitBracketsWithCatalogRefresh(
    brackets: BinancePapiUmLeverageBracket[],
    receivedAt: number,
  ): Promise<RawSymbolRiskLimit[]> {
    let missing = missingRiskLimitVenueIds(this.marketCatalog, brackets);
    if (missing.length > 0) {
      await this.refreshUsdmCatalogAfterMiss(missing);
      missing = missingRiskLimitVenueIds(this.marketCatalog, brackets);
      this.reportSymbolMappingMisses(
        missing.map((venueId) => ({
          family: BINANCE_PRIVATE_SYMBOL_FAMILY,
          venueId,
        })),
      );
    }

    return brackets.flatMap((bracket) => {
      const mapped = mapRiskLimitBracket(
        this.marketCatalog,
        bracket,
        receivedAt,
      );
      return mapped ? [mapped] : [];
    });
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
      requestSigningClockResyncIfTimestampOutOfSync(
        this.options.signingClock,
        normalizeBinanceErrorReasonFromPayload(response.body),
      );

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
        requestSigningClockResyncIfTimestampOutOfSync(
          this.options.signingClock,
          normalizeBinanceErrorReasonFromRawBody(error.rawBody),
        );
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
      SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
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
