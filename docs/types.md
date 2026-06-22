# 数据类型速查

以下类型均从 `@imbingox/acex` 根入口导出；以 package public types 为准。这里列常用形状，完整字段可由 TypeScript 自动补全。

```ts
type Venue = "binance" | "deribit" | "okx" | "bybit" | "gate" | "juplend";
type ClientStatus = "idle" | "starting" | "running" | "stopping" | "stopped";
type MarketType = "spot" | "swap" | "future" | "option";
type PositionSide = "long" | "short" | "net";
type CreateOrderType = "limit" | "market";
type OrderType =
  | CreateOrderType
  | "stop"
  | "stop_market"
  | "take_profit"
  | "take_profit_market"
  | "trailing_stop_market"
  | "unknown";
type OrderSide = "buy" | "sell";
type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown";

type PrivateRuntimeReason =
  | "credentials_missing"
  | "auth_failed"
  | "http_failed"
  | "rate_limited"
  | "ws_disconnected"
  | "heartbeat_timeout"
  | "reconciling";

type SubscriptionActivity = "active" | "inactive";
type MarketFreshness = "fresh" | "stale" | "reconciling";
type PrivateRuntimeStatus =
  | "bootstrap_pending"
  | "healthy"
  | "degraded"
  | "reconnecting"
  | "reconciling"
  | "stopped";
```

```ts
interface VenueCapabilities {
  venue: Venue;
  runtimeStatus: "available" | "type_only" | "reserved";
  readOnly: boolean;
  notes: string[];
  market: {
    catalog: "supported" | "unsupported";
    serverTime: "supported" | "unsupported";
    publicTrades: "supported" | "unsupported";
    publicRawTrades: "supported" | "unsupported";
    fundingRateHistory: "supported" | "unsupported";
    l1Book: "supported" | "unsupported";
    fundingRate: "supported" | "unsupported" | "market_dependent";
    marketTypes: MarketType[];
  };
  account: {
    register: "supported" | "unsupported";
    snapshot: "supported" | "unsupported";
    updates: "websocket" | "polling" | "unsupported";
    balances: "supported" | "unsupported";
    positions: "supported" | "unsupported";
    risk: "supported" | "unsupported";
    lending: "supported" | "unsupported";
    fundingFeeHistory: "supported" | "unsupported";
    credentialsRequired: boolean;
  };
  order: {
    supported: boolean;
    openOrders: "supported" | "unsupported";
    updates: "websocket" | "polling" | "unsupported";
    fees: "supported" | "unsupported";
    create: "supported" | "unsupported";
    cancel: "supported" | "unsupported";
    cancelAll: "symbol" | "account" | "unsupported";
    orderTypes: CreateOrderType[];
    timeInForce: Array<"gtc" | "post_only">;
    postOnly: boolean;
    reduceOnly: boolean;
    positionSide: "optional" | "required_for_hedge" | "unsupported";
    clientOrderId: boolean;
    reason?:
      | "not_implemented"
      | "read_only"
      | "market_type_unsupported"
      | "sdk_reserved";
  };
}
```

```ts
interface CreateClientOptions {
  venues?: Venue[];
  sandbox?: boolean;
  clock?: {
    now(): number;
    requestResync?(): void;
  };
  rateLimiter?: RateLimiter;
  rateLimit?: {
    utilizationTarget?: number;
  };
  onMetric?: OnMetric;
  logger?: Logger;
  logLevel?: "debug" | "info" | "warn" | "error";
  market?: {
    l1InitialMessageTimeoutMs?: number;
    l1StaleAfterMs?: number;
    l1ReconnectDelayMs?: number;
    l1ReconnectMaxDelayMs?: number;
    venues?: {
      binance?: {
        /** Used by fetchPublicRawTrades(); secret/signature not required. */
        apiKey?: string;
      };
      deribit?: {
        /** Option underlyings mapped to Deribit get_instruments currency. */
        underlyings?: string[];
      };
    };
  };
  account?: {
    streamOpenTimeoutMs?: number;
    streamReconnectDelayMs?: number;
    streamReconnectMaxDelayMs?: number;
    venues?: {
      binance?: {
        riskPollIntervalMs?: number;
        privateReconcileIntervalMs?: number;
        privateStreamStaleAfterMs?: number;
        listenKeyKeepAliveMs?: number;
      };
      juplend?: {
        pollIntervalMs?: number;
        rpcUrl?: string;
        jupApiKey?: string;
      };
    };
  };
  order?: {
    maxClosedOrdersPerSymbol?: number;
    missingOrderEvictionThreshold?: number;
    pendingClaimTtlMs?: number;
  };
  fee?: {
    /** ms; defaults to 24h */
    refreshIntervalMs?: number;
    /**
     * Defaults keyed by Venue + MarketType.
     * Binance built-ins: spot 0.001/0.001, swap 0.0002/0.0005,
     * future 0.0001/0.0005, option 0.0003/0.0003.
     */
    defaultRates?: Partial<
      Record<
        Venue,
        Partial<Record<MarketType, { maker: string; taker: string }>>
      >
    >;
  };
  riskLimit?: {
    /** ms; defaults to 5 minutes */
    refreshIntervalMs?: number;
  };
}

interface RateLimitScope {
  venue: Venue;
  accountId?: string;
  endpointKey: string;
}

interface RateLimitUsage {
  weight?: Record<string, number>;
  orderCount?: Record<string, number>;
}

type RateLimitPriority = "normal" | "cancel" | "risk" | (string & {});
type RateLimitBucketKind = "request_weight" | "orders" | (string & {});
type RateLimitScopeDimension = "venue" | "account" | "endpoint";
type MetricType = "counter" | "gauge" | "timing";

type OnMetric = (
  name: string,
  value: number,
  type: MetricType,
  tags?: Record<string, string>,
) => void;

const METRIC_NAMES = {
  orderCommandRtt: "order.command.rtt",
  wsMessageLatency: "ws.message.latency",
  wsReconnect: "ws.reconnect",
  eventBufferOverflow: "event.buffer.overflow",
} as const;

interface RateLimitBucketReserve {
  priority: RateLimitPriority;
  units: number;
}

interface RateLimitBucketDescriptor {
  id: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  scope: readonly RateLimitScopeDimension[];
  utilizationTarget?: number;
  reserve?: RateLimitBucketReserve;
}

interface RateLimitCost {
  bucketId: string;
  cost: number;
}

interface RateLimitPlan {
  id: string;
  costs: readonly RateLimitCost[];
  priority?: RateLimitPriority;
}

interface RateLimitTopology {
  id: string;
  buckets: readonly RateLimitBucketDescriptor[];
  plans: readonly RateLimitPlan[];
}

interface RateLimitReservation {
  readonly __opaqueRateLimitReservation?: never;
}

interface RateLimitTopologyRegistry {
  registerRateLimitTopology(topology: RateLimitTopology): void;
}

interface RateLimitBucketSnapshot {
  bucketId: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  utilizationTarget?: number;
  reserve?: RateLimitBucketReserve;
  used?: number;
  windowStartMs?: number;
  windowEndMs?: number;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: "ok" | "rate_limited" | "banned";
  updatedAt?: number;
}

interface RateLimitRequestContext {
  scope: RateLimitScope;
  planId?: string;
  priority?: RateLimitPriority;
}

interface RateLimitResponseContext {
  status: number;
  headers?: Headers;
  usage?: RateLimitUsage;
  reservation?: RateLimitReservation;
}

interface RateLimitTransportErrorContext {
  status?: number;
  headers?: Headers;
  retryAfterMs?: number;
  usage?: RateLimitUsage;
  reservation?: RateLimitReservation;
  requestNotSent?: boolean;
}

interface RateLimitSnapshot {
  scope: RateLimitScope;
  usage?: RateLimitUsage;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: "ok" | "rate_limited" | "banned";
  updatedAt?: number;
  buckets?: RateLimitBucketSnapshot[];
}

interface RateLimiter {
  beforeRequest(
    ctx: RateLimitRequestContext,
  ): Promise<RateLimitReservation | void> | RateLimitReservation | void;
  afterResponse(
    ctx: RateLimitRequestContext,
    response: RateLimitResponseContext,
  ): Promise<void> | void;
  onTransportError(
    ctx: RateLimitRequestContext,
    error: RateLimitTransportErrorContext,
  ): Promise<void> | void;
  getSnapshot(scope: RateLimitScope): RateLimitSnapshot | undefined;
}

interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

type RegisterAccountInput =
  | {
      accountId: string;
      venue: "binance" | "okx" | "bybit" | "gate";
      credentials?: AccountCredentials;
      options?: {
        timestamp?: number;
        recvWindow?: number;
      };
    }
  | {
      accountId: string;
      venue: "juplend";
      credentials?: AccountCredentials;
      options:
        | {
            walletAddress: string;
            vaultId?: string;
            positionId?: string;
          }
        | {
            walletAddress?: string;
            vaultId: string;
            positionId: string;
          };
    };

interface AccountCredentials {
  apiKey?: string;
  secret?: string;
  password?: string;
  extra?: Record<string, string>;
}
```

`clock` 只用于私有签名请求的 `timestamp`，不参与 `receivedAt`、WebSocket freshness 或本地状态时间。默认不传 `clock` 时，runtime 会为 Binance 签名请求启用 venue 级 server-time 自动校准；当交易所返回 `timestamp_out_of_sync` 时，SDK 会触发一次去抖后的重校。显式传入 `clock` 表示调用方完全接管签名时间，SDK 不会创建默认 server-time sampler 或同步 timer。

```ts
interface BaseMarketDefinition {
  venue: Venue;
  symbol: string;
  id: string;
  type: MarketType;
  base: string;
  quote: string;
  settle?: string;
  active: boolean;
  contract: boolean;
  linear?: boolean;
  inverse?: boolean;
  contractSize?: string;
  pricePrecision: number;
  amountPrecision: number;
  priceStep: string;
  amountStep: string;
  minAmount?: string;
  minNotional?: string;
  expiry?: number;
  raw: Record<string, unknown>;
}

interface StandardMarketDefinition extends BaseMarketDefinition {
  type: "spot" | "swap" | "future";
}

interface OptionMarketDefinition extends BaseMarketDefinition {
  type: "option";
  underlying: string;
  expiry: number;
  strike: string;
  strikeCurrency: string;
  optionType: "call" | "put";
  premiumCurrency: string;
  settle: string;
  contract: true;
  contractSize: string;
}

type MarketDefinition = StandardMarketDefinition | OptionMarketDefinition;

interface OptionPair {
  venue: Venue;
  underlying: string;
  strikeCurrency: string;
  premiumCurrency: string;
  settle: string;
  expiry: number;
  strike: string;
  call: OptionMarketDefinition;
  put: OptionMarketDefinition;
}

interface VenueServerTime {
  serverTime: number;
  requestSentAt: number;
  responseReceivedAt: number;
  roundTripMs: number;
  estimatedOffsetMs: number;
}

interface PublicTrade {
  venue: Venue;
  symbol: string;
  id: string;
  price: string;
  amount: string;
  cost?: string;
  side?: "buy" | "sell";
  exchangeTs: number;
  receivedAt: number;
  raw: Record<string, unknown>;
}

interface FetchPublicTradesInput {
  venue: Venue;
  symbol: string;
  startTs: number;
  endTs?: number;
  limit?: number;
}

interface FetchPublicTradesResult {
  trades: PublicTrade[];
  startTs: number;
  endTs?: number;
  limit?: number;
  truncated: boolean;
}

interface FetchPublicRawTradesInput {
  venue: Venue;
  symbol: string;
  startTs: number;
  endTs?: number;
  limit?: number;
}

interface FetchPublicRawTradesResult {
  trades: PublicTrade[];
  startTs: number;
  endTs?: number;
  limit?: number;
  truncated: boolean;
}

interface FundingRateHistoryEntry {
  venue: Venue;
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice?: string;
  receivedAt: number;
  raw: Record<string, unknown>;
}

interface FetchFundingRateHistoryInput {
  venue: Venue;
  symbol: string;
  startTs?: number;
  endTs?: number;
  limit?: number;
}

interface FetchFundingRateHistoryResult {
  rates: FundingRateHistoryEntry[];
  startTs?: number;
  endTs?: number;
  limit?: number;
  truncated: boolean;
}

interface FetchFundingFeeHistoryInput {
  accountId: string;
  symbols?: string[];
  startTs?: number;
  endTs?: number;
  page?: number;
  limit?: number;
}

interface FundingFeeHistoryEntry {
  accountId: string;
  venue: Venue;
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

interface FetchFundingFeeHistoryResult {
  fees: FundingFeeHistoryEntry[];
  startTs?: number;
  endTs?: number;
  page: number;
  limit: number;
  truncated: boolean;
  nextPage?: number;
}

interface L1Book {
  venue: Venue;
  symbol: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
  status: MarketDataStreamStatus;
}

interface MarketDataStreamStatus {
  activity: SubscriptionActivity;
  ready: boolean;
  freshness?: MarketFreshness;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: "ws_disconnected" | "heartbeat_timeout" | "reconciling" | "no_quote";
}

interface MarketDataStatus extends MarketDataStreamStatus {
  venue: Venue;
  symbol: string;
}

interface FundingRateSnapshot {
  venue: Venue;
  symbol: string;
  fundingRate: string;
  nextFundingTime?: number;
  markPrice?: string;
  indexPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
  status: MarketDataStreamStatus;
}

interface BalanceSnapshot {
  accountId: string;
  venue: Venue;
  asset: string;
  free: string;
  used: string;
  total: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: {
    supplied: string;
    borrowed: string;
    interest: string;
    netAsset: string;
    supplyAPY?: string;
    borrowAPY?: string;
  };
}

interface PositionSnapshot {
  accountId: string;
  venue: Venue;
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
  updatedAt: number;
  seq: number;
}

type RiskLevel =
  | "normal"
  | "margin_call"
  | "reduce_only"
  | "force_liquidation";

type RiskAlertLevel = Exclude<RiskLevel, "normal">;

interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  riskLevel?: RiskLevel;
  netEquity?: string;
  riskEquity?: string;
  riskRatio?: string;
  riskLeverage?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: {
    marginLevel?: string;
    healthFactor?: string;
    ltv?: string;
    liquidationThreshold?: string;
    totalCollateralUSD?: string;
    totalDebtUSD?: string;
  };
}

interface AccountSnapshot {
  accountId: string;
  venue: Venue;
  balances: Record<string, BalanceSnapshot>;
  positions: PositionSnapshot[];
  risk?: RiskSnapshot;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}

interface AccountDataStatus {
  accountId: string;
  venue: Venue;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: PrivateRuntimeReason;
}
```

```ts
type BinanceMarginSideEffectType =
  | "no_side_effect"
  | "margin_buy"
  | "auto_repay"
  | "auto_borrow_repay";

interface UmOrderOptions {
  reduceOnly?: boolean;
  positionSide?: PositionSide;
}

interface MarginOrderOptions {
  sideEffectType?: BinanceMarginSideEffectType;
  autoRepayAtCancel?: boolean;
}

type CreateOrderInput =
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "limit";
      price: string;
      amount: string;
      postOnly?: boolean;
      clientOrderId?: string;
      um?: UmOrderOptions;
      margin?: never;
    }
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "market";
      amount: string;
      clientOrderId?: string;
      um?: UmOrderOptions;
      margin?: never;
    }
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "limit";
      price: string;
      amount: string;
      postOnly?: boolean;
      clientOrderId?: string;
      margin?: MarginOrderOptions;
      um?: never;
    }
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "market";
      amount: string;
      clientOrderId?: string;
      margin?: MarginOrderOptions;
      um?: never;
    };

interface CancelOrderInput {
  accountId: string;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}

interface CancelAllOrdersInput {
  accountId: string;
  symbol: string;
}

interface SubscribeFeeRatesInput {
  accountId: string;
  symbols: string[];
}

interface UnsubscribeFeeRatesInput {
  accountId: string;
  symbols?: string[];
}

interface GetSymbolFeeRateInput {
  accountId: string;
  symbol: string;
}

interface SymbolFeeRate {
  accountId: string;
  venue: Venue;
  symbol: string;
  marketType: MarketType;
  maker: string;
  taker: string;
  source: "default" | "venue";
  receivedAt: number;
}

interface GetSymbolRiskLimitInput {
  accountId: string;
  symbol: string;
}

interface FetchRiskLimitsInput {
  accountId: string;
}

interface SetSymbolLeverageInput {
  accountId: string;
  symbol: string;
  leverage: string;
}

interface RiskLimitTier {
  tier: number;
  initialLeverage: string;
  notionalFloor?: string;
  notionalCap?: string;
  maintenanceMarginRatio?: string;
  cumulativeMaintenanceAmount?: string;
}

interface SymbolLeverageUpdate {
  accountId: string;
  venue: Venue;
  symbol: string;
  leverage: string;
  maxNotionalValue?: string;
  receivedAt: number;
}

interface SymbolRiskLimitSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  tiers: {
    source: "missing" | "venue";
    stale: boolean;
    receivedAt?: number;
    items: RiskLimitTier[];
    maxInitialLeverage?: string;
    notionalCoefficient?: string;
  };
  leverage: {
    lastSet?: SymbolLeverageUpdate;
  };
  updatedAt: number;
}

interface OrderSnapshot {
  accountId: string;
  venue: Venue;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  rawType?: string;
  status: OrderStatus;
  price?: string;
  amount: string;
  filled: string;
  remaining?: string;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
  triggerPrice?: string;
  avgFillPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

interface OrderDataStatus {
  accountId: string;
  venue: Venue;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: PrivateRuntimeReason;
}

interface OrderTrade {
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
  exchangeTs?: number;
  receivedAt: number;
}

```

```ts
type MarketEvent =
  | { type: "l1_book.updated"; venue: Venue; symbol: string; snapshot: L1Book; ts: number }
  | { type: "funding_rate.updated"; venue: Venue; symbol: string; snapshot: FundingRateSnapshot; ts: number }
  | { type: "market.status_changed"; venue: Venue; symbol: string; status: MarketDataStatus; ts: number };

type AccountEvent =
  | { type: "balance.updated"; accountId: string; venue: Venue; asset: string; snapshot: BalanceSnapshot; ts: number }
  | { type: "position.updated"; accountId: string; venue: Venue; symbol: string; snapshot: PositionSnapshot; ts: number }
  | { type: "risk.updated"; accountId: string; venue: Venue; snapshot: RiskSnapshot; ts: number }
  | { type: "account.risk_level_change"; accountId: string; venue: Venue; riskLevel: RiskAlertLevel; riskRatio?: string; netEquity?: string; riskEquity?: string; riskLeverage?: string; maintenanceMargin?: string; exchangeTs?: number; receivedAt: number; ts: number }
  | { type: "account.snapshot_replaced"; accountId: string; venue: Venue; snapshot: AccountSnapshot; ts: number };

type OrderEvent =
  | { type: "order.updated"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.filled"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.canceled"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.rejected"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.snapshot_replaced"; accountId: string; venue: Venue; snapshot: OrderSnapshot[]; ts: number };

type OrderTradeEvent = {
  type: "order.trade";
  accountId: string;
  venue: Venue;
  symbol: string;
  side: OrderSide;
  orderId?: string;
  clientOrderId?: string;
  trade: OrderTrade;
  seq: number;
  orderSeq?: number;
  ts: number;
};
```
