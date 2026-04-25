import type {
  AccountCredentials,
  CreateOrderType,
  Exchange,
  MarketDefinition,
  OrderSide,
  OrderStatus,
  PositionSide,
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
  readonly exchange: Exchange;
  loadMarkets(): Promise<MarketDefinition[]>;
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
  equity?: string;
  marginRatio?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
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

export interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;
  type: CreateOrderType;
  amount: string;
  price?: string;
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
  onAccountUpdate(update: RawAccountUpdate): void;
  onOrderUpdate(update: RawOrderUpdate): void;
  onDisconnected(): void;
  onReconnected(): void;
  onError(error: Error): void;
}

export interface PrivateStreamOptions {
  openTimeoutMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  listenKeyKeepAliveMs: number;
  now?: () => number;
}

export interface PrivateUserDataAdapter {
  readonly exchange: Exchange;
  bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap>;
  bootstrapOpenOrders(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]>;
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
