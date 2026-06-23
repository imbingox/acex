import type { VenueErrorReason } from "../errors.ts";
import type {
  AccountCredentials,
  CreateOrderType,
  MarginOrderOptions,
  MarketDefinition,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  RiskAlertLevel,
  RiskLevel,
  UmOrderOptions,
  Venue,
  VenueAccountCapabilities,
  VenueMarketCapabilities,
  VenueOrderCapabilities,
  VenueServerTime,
} from "../types/index.ts";

export type SymbolMappingDirection = "to_unified" | "to_venue";

export class SymbolMappingError extends Error {
  readonly isAcexOrderPreflightError = true;
  readonly venue: Venue;
  readonly family: string;
  readonly symbol: string;
  readonly direction: SymbolMappingDirection;

  constructor(input: {
    readonly venue: Venue;
    readonly family: string;
    readonly symbol: string;
    readonly direction: SymbolMappingDirection;
  }) {
    super(
      `Unable to map ${input.venue} ${input.family} symbol (${input.direction}): ${input.symbol}`,
    );
    this.name = "SymbolMappingError";
    this.venue = input.venue;
    this.family = input.family;
    this.symbol = input.symbol;
    this.direction = input.direction;
  }
}

export class CatalogUnavailableError extends Error {
  readonly isAcexOrderPreflightError = true;
  readonly venue: Venue;
  readonly family: string;
  readonly symbol?: string;
  override readonly cause?: unknown;

  constructor(input: {
    readonly venue: Venue;
    readonly family: string;
    readonly symbol?: string;
    readonly cause?: unknown;
  }) {
    super(
      `Unable to load ${input.venue} ${input.family} market catalog${
        input.symbol ? ` for symbol: ${input.symbol}` : ""
      }`,
      { cause: input.cause },
    );
    this.name = "CatalogUnavailableError";
    this.venue = input.venue;
    this.family = input.family;
    this.symbol = input.symbol;
    this.cause = input.cause;
  }
}

export class OrderInputValidationError extends Error {
  readonly isAcexOrderInputValidationError = true;
  readonly isAcexOrderPreflightError = true;

  constructor(message: string) {
    super(message);
    this.name = "OrderInputValidationError";
  }
}

export class UnsupportedSymbolProductError extends Error {
  readonly isAcexOrderPreflightError = true;
  readonly venue: Venue;
  readonly family: string;
  readonly symbol: string;

  constructor(input: {
    readonly venue: Venue;
    readonly family: string;
    readonly symbol: string;
  }) {
    super(
      `${input.venue} private orders do not support product line ${input.family}: ${input.symbol}`,
    );
    this.name = "UnsupportedSymbolProductError";
    this.venue = input.venue;
    this.family = input.family;
    this.symbol = input.symbol;
  }
}

export function isSymbolMappingError(
  error: unknown,
): error is SymbolMappingError {
  return (
    error instanceof SymbolMappingError ||
    (isRecord(error) &&
      error.name === "SymbolMappingError" &&
      error.isAcexOrderPreflightError === true)
  );
}

export function isCatalogUnavailableError(
  error: unknown,
): error is CatalogUnavailableError {
  return (
    error instanceof CatalogUnavailableError ||
    (isRecord(error) &&
      error.name === "CatalogUnavailableError" &&
      error.isAcexOrderPreflightError === true)
  );
}

export function isOrderInputValidationError(
  error: unknown,
): error is OrderInputValidationError {
  return (
    error instanceof OrderInputValidationError ||
    (isRecord(error) &&
      error.name === "OrderInputValidationError" &&
      error.isAcexOrderInputValidationError === true)
  );
}

export function isUnsupportedSymbolProductError(
  error: unknown,
): error is UnsupportedSymbolProductError {
  return (
    error instanceof UnsupportedSymbolProductError ||
    (isRecord(error) &&
      error.name === "UnsupportedSymbolProductError" &&
      error.isAcexOrderPreflightError === true)
  );
}

export function isOrderPreflightError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      isSymbolMappingError(current) ||
      isCatalogUnavailableError(current) ||
      isOrderInputValidationError(current) ||
      isUnsupportedSymbolProductError(current)
    ) {
      return true;
    }

    if (!isRecord(current) || !("cause" in current)) {
      return false;
    }

    current = current.cause;
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export interface StreamHandle {
  readonly ready: Promise<void>;
  close(): void;
}

export interface RawL1BookUpdate {
  bidPrice: string | null;
  bidSize: string | null;
  askPrice: string | null;
  askSize: string | null;
  exchangeTs?: number;
  receivedAt: number;
}

export interface RawFundingRateUpdate {
  fundingRate: string;
  nextFundingTime?: number;
  markPrice?: string;
  indexPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface FetchPublicRawTradesRequest {
  startTs: number;
  endTs?: number;
  limit?: number;
}

export interface FetchPublicTradesRequest {
  startTs: number;
  endTs?: number;
  limit?: number;
}

export interface FetchFundingRateHistoryRequest {
  startTs?: number;
  endTs?: number;
  limit?: number;
}

export interface RawPublicTrade {
  id: string;
  price: string;
  amount: string;
  cost?: string;
  side?: OrderSide;
  exchangeTs: number;
  receivedAt: number;
  raw: Record<string, unknown>;
}

export interface RawPublicTradesResult {
  trades: RawPublicTrade[];
  truncated: boolean;
  nextFromId?: string;
}

export interface RawFundingRateHistoryEntry {
  fundingRate: string;
  fundingTime: number;
  markPrice?: string;
  receivedAt: number;
  raw: Record<string, unknown>;
}

export interface RawFundingRateHistoryResult {
  rates: RawFundingRateHistoryEntry[];
  truncated: boolean;
}

export interface L1BookStreamCallbacks {
  onUpdate(update: RawL1BookUpdate): void;
  onFreshnessChange(
    freshness: "fresh" | "stale",
    reason?: "heartbeat_timeout",
  ): void;
  onDisconnected(): void;
  onError(error: Error): void;
}

export interface L1BookStreamOptions {
  initialMessageTimeoutMs: number;
  staleAfterMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  now?: () => number;
}

export interface FundingRateStreamCallbacks {
  onUpdate(update: RawFundingRateUpdate): void;
  onFreshnessChange(
    freshness: "fresh" | "stale",
    reason?: "heartbeat_timeout",
  ): void;
  onDisconnected(): void;
  onError(error: Error): void;
}

export interface FundingRateStreamOptions {
  initialMessageTimeoutMs: number;
  staleAfterMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  now?: () => number;
}

export interface MarketAdapter {
  readonly venue: Venue;
  readonly readOnly?: boolean;
  readonly notes?: string[];
  readonly marketCapabilities: VenueMarketCapabilities;
  loadMarkets(): Promise<MarketDefinition[]>;
  fetchServerTime?(): Promise<VenueServerTime>;
  fetchPublicTrades?(
    market: MarketDefinition,
    request: FetchPublicTradesRequest,
  ): Promise<RawPublicTradesResult>;
  fetchPublicRawTrades?(
    market: MarketDefinition,
    request: FetchPublicRawTradesRequest,
  ): Promise<RawPublicTradesResult>;
  assertPublicRawTradesConfigured?(): void;
  fetchFundingRateHistory?(
    market: MarketDefinition,
    request: FetchFundingRateHistoryRequest,
  ): Promise<RawFundingRateHistoryResult>;
  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle;
  createFundingRateStream(
    market: MarketDefinition,
    callbacks: FundingRateStreamCallbacks,
    options: FundingRateStreamOptions,
  ): StreamHandle;
}

export interface RawBalanceUpdate {
  asset: string;
  free?: string;
  used?: string;
  total?: string;
  exchangeTs?: number;
  receivedAt: number;
  lending?: RawLendingBalanceUpdate;
}

export interface RawLendingBalanceUpdate {
  supplied?: string;
  borrowed?: string;
  interest?: string;
  netAsset?: string;
  supplyAPY?: string;
  borrowAPY?: string;
}

export interface RawPositionUpdate {
  symbol: string;
  side: PositionSide;
  size?: string;
  entryPrice?: string;
  markPrice?: string;
  unrealizedPnl?: string;
  leverage?: string;
  liquidationPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface RawRiskUpdate {
  riskLevel?: RiskLevel;
  netEquity?: string;
  riskEquity?: string;
  riskRatio?: string;
  riskLeverage?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
  lending?: RawLendingRiskUpdate;
}

export interface RawRiskLevelChange {
  riskLevel: RiskAlertLevel;
  riskRatio?: string;
  netEquity?: string;
  riskEquity?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface FetchFundingFeeHistoryRequest {
  symbol?: string;
  startTs?: number;
  endTs?: number;
  page: number;
  limit: number;
}

export interface RawFundingFeeHistoryEntry {
  symbol: string;
  asset: string;
  amount: string;
  fundingTime: number;
  receivedAt: number;
  venueTransactionId?: string;
  tradeId?: string;
  positionSide?: PositionSide;
  raw: Record<string, unknown>;
}

export interface RawFundingFeeHistoryResult {
  fees: RawFundingFeeHistoryEntry[];
  truncated: boolean;
}

export interface RawLendingRiskUpdate {
  marginLevel?: string;
  healthFactor?: string;
  ltv?: string;
  liquidationThreshold?: string;
  totalCollateralUSD?: string;
  totalDebtUSD?: string;
}

export interface RawAccountBootstrap {
  balances: RawBalanceUpdate[];
  positions: RawPositionUpdate[];
  risk?: RawRiskUpdate;
  exchangeTs?: number;
  receivedAt: number;
}

export interface RawAccountUpdate {
  balances?: RawBalanceUpdate[];
  positions?: RawPositionUpdate[];
  risk?: RawRiskUpdate;
  exchangeTs?: number;
  receivedAt: number;
}

export interface RawOrderTrade {
  tradeId?: string;
  price: string;
  qty: string;
  fee?: {
    cost: string;
    asset: string;
  };
  realizedPnl?: string;
  maker?: boolean;
  positionSide?: PositionSide;
}

export interface RawOrderUpdate {
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  rawType?: string;
  status: OrderStatus;
  price?: string;
  triggerPrice?: string;
  amount: string;
  filled: string;
  remaining?: string;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
  avgFillPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  trade?: RawOrderTrade;
}

export interface RawOpenOrdersSnapshot {
  orders: RawOrderUpdate[];
  snapshotReceivedAt: number;
  snapshotExchangeTs?: number;
}

export type FetchOrderRequest =
  | { symbol: string; orderId: string; clientOrderId?: string }
  | { symbol: string; clientOrderId: string; orderId?: string };

export interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;
  type: CreateOrderType;
  amount: string;
  price?: string;
  postOnly?: boolean;
  clientOrderId?: string;
  um?: UmOrderOptions;
  margin?: MarginOrderOptions;
}

export interface CancelOrderRequest {
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}

export interface CancelAllOrdersRequest {
  symbol: string;
}

export interface FetchSymbolFeeRateRequest {
  symbol: string;
}

export interface RawSymbolFeeRate {
  symbol: string;
  maker: string;
  taker: string;
  receivedAt: number;
}

export interface FetchSymbolRiskLimitRequest {
  symbol: string;
}

export type FetchRiskLimitsRequest = Record<never, never>;

export interface SetSymbolLeverageRequest {
  symbol: string;
  leverage: string;
}

export interface RawRiskLimitTier {
  tier: number;
  initialLeverage: string;
  notionalFloor?: string;
  notionalCap?: string;
  maintenanceMarginRatio?: string;
  cumulativeMaintenanceAmount?: string;
}

export interface RawSymbolRiskLimit {
  symbol: string;
  tiers: RawRiskLimitTier[];
  notionalCoefficient?: string;
  receivedAt: number;
}

export interface RawSymbolLeverageUpdate {
  symbol: string;
  leverage: string;
  maxNotionalValue?: string;
  receivedAt: number;
}

export type PrivateReconcileReason =
  | "symbol_mapping_miss"
  | "margin_balance_delta"
  | "margin_liability_change"
  | "margin_open_order_loss";

export interface PrivateStreamCallbacks {
  onAccountSnapshot(snapshot: RawAccountBootstrap): void;
  onAccountUpdate(update: RawAccountUpdate): void;
  onRiskLevelChange(event: RawRiskLevelChange): void;
  onOrderUpdate(update: RawOrderUpdate): void;
  onFreshnessChange(freshness: "stale", reason: "heartbeat_timeout"): void;
  onDisconnected(): void;
  onReconnected(): void;
  requestReconcile?(reason: PrivateReconcileReason): void;
  onError(error: Error): void;
}

export interface PrivateStreamOptions {
  openTimeoutMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  listenKeyKeepAliveMs: number;
  staleAfterMs: number;
  now?: () => number;
}

export interface PrivateUserDataAdapter {
  readonly venue: Venue;
  readonly readOnly: boolean;
  readonly notes: string[];
  readonly accountCapabilities: VenueAccountCapabilities;
  readonly orderCapabilities: VenueOrderCapabilities;
  normalizeVenueErrorCode?(code: string): VenueErrorReason;
  bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap>;
  refreshAccount?(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountUpdate>;
  reconcileAccount?(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap>;
  bootstrapOpenOrders(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]>;
  fetchOpenOrders?(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOpenOrdersSnapshot>;
  fetchOrder?(
    credentials: AccountCredentials,
    request: FetchOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate | undefined>;
  fetchSymbolFeeRate?(
    credentials: AccountCredentials,
    request: FetchSymbolFeeRateRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolFeeRate>;
  fetchFundingFeeHistory?(
    credentials: AccountCredentials,
    request: FetchFundingFeeHistoryRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawFundingFeeHistoryResult>;
  fetchSymbolRiskLimit?(
    credentials: AccountCredentials,
    request: FetchSymbolRiskLimitRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolRiskLimit>;
  fetchRiskLimits?(
    credentials: AccountCredentials,
    request: FetchRiskLimitsRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolRiskLimit[]>;
  setSymbolLeverage?(
    credentials: AccountCredentials,
    request: SetSymbolLeverageRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolLeverageUpdate>;
  createOrder(
    credentials: AccountCredentials,
    request: CreateOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate>;
  cancelOrder(
    credentials: AccountCredentials,
    request: CancelOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate>;
  cancelAllOrders(
    credentials: AccountCredentials,
    request: CancelAllOrdersRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]>;
  createPrivateStream(
    credentials: AccountCredentials,
    callbacks: PrivateStreamCallbacks,
    options: PrivateStreamOptions,
    accountOptions?: Record<string, unknown>,
  ): StreamHandle;
}
