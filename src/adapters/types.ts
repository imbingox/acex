import type { VenueErrorReason } from "../errors.ts";
import type {
  AccountCredentials,
  CreateOrderType,
  MarketDefinition,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  RiskAlertLevel,
  RiskLevel,
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

export function isOrderPreflightError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (isSymbolMappingError(current) || isCatalogUnavailableError(current)) {
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
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
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
  readonly marketCapabilities: VenueMarketCapabilities;
  loadMarkets(): Promise<MarketDefinition[]>;
  fetchServerTime?(): Promise<VenueServerTime>;
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
  supplied: string;
  borrowed: string;
  interest: string;
  netAsset: string;
  supplyAPY?: string;
  borrowAPY?: string;
}

export interface RawPositionUpdate {
  symbol: string;
  side: PositionSide;
  size: string;
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
  reduceOnly?: boolean;
  positionSide?: PositionSide;
}

export interface CancelOrderRequest {
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}

export interface CancelAllOrdersRequest {
  symbol: string;
}

export interface PrivateStreamCallbacks {
  onAccountSnapshot(snapshot: RawAccountBootstrap): void;
  onAccountUpdate(update: RawAccountUpdate): void;
  onRiskLevelChange(event: RawRiskLevelChange): void;
  onOrderUpdate(update: RawOrderUpdate): void;
  onFreshnessChange(freshness: "stale", reason: "heartbeat_timeout"): void;
  onDisconnected(): void;
  onReconnected(): void;
  requestReconcile?(reason: "symbol_mapping_miss"): void;
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
