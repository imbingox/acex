import type {
  AccountCredentials,
  CreateOrderType,
  MarketDefinition,
  OrderSide,
  OrderStatus,
  PositionSide,
  Venue,
  VenueAccountCapabilities,
  VenueMarketCapabilities,
  VenueOrderCapabilities,
  VenueServerTime,
} from "../types/index.ts";

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

export interface RawOrderUpdate {
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: string;
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
  onOrderUpdate(update: RawOrderUpdate): void;
  onFreshnessChange(freshness: "stale", reason: "heartbeat_timeout"): void;
  onDisconnected(): void;
  onReconnected(): void;
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
