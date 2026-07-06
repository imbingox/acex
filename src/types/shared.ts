export const SUPPORTED_VENUES = [
  "binance",
  "deribit",
  "okx",
  "bybit",
  "gate",
  "juplend",
] as const;

export type Venue = (typeof SUPPORTED_VENUES)[number];

export type MarketType = "spot" | "swap" | "future" | "option";

export type ClientStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

export type MetricType = "counter" | "gauge" | "timing";

export type OnMetric = (
  name: string,
  value: number,
  type: MetricType,
  tags?: Record<string, string>,
) => void;

export const METRIC_NAMES = {
  orderCommandRtt: "order.command.rtt",
  wsMessageLatency: "ws.message.latency",
  wsReconnect: "ws.reconnect",
  eventBufferOverflow: "event.buffer.overflow",
} as const;

export interface TimeProvider {
  /** Millisecond timestamp used for outbound request/signing timestamps. */
  now(): number;
  /** Optional signal that a venue rejected the timestamp and the clock should resync. */
  requestResync?(): void;
}

export interface RateLimitScope {
  venue: Venue;
  accountId?: string;
  endpointKey: string;
}

export interface RateLimitUsage {
  /** Exchange request-weight usage by interval key, e.g. "1m". */
  weight?: Record<string, number>;
  /** Exchange order-count usage by interval key, separate from request weight. */
  orderCount?: Record<string, number>;
}

/**
 * Request priority used by rate-limit plans and per-request contexts.
 *
 * `"normal"` is the default path. `"cancel"` is intended for cancellation or
 * other unwind traffic that may use reserved bucket headroom. `"risk"` is for
 * risk/account maintenance traffic. Custom strings are allowed so venue
 * adapters can add narrower priorities without changing the public union.
 */
export type RateLimitPriority = "normal" | "cancel" | "risk" | (string & {});

/**
 * Logical bucket family reported by an exchange.
 *
 * `"request_weight"` tracks REST weight-style budgets. `"orders"` tracks order
 * count budgets separately. Custom strings are allowed for venue-specific
 * bucket families.
 */
export type RateLimitBucketKind = "request_weight" | "orders" | (string & {});

/**
 * Scope dimensions that define how a bucket state is keyed.
 *
 * `"venue"` shares one bucket per venue, `"account"` adds accountId isolation,
 * and `"endpoint"` adds endpointKey isolation.
 */
export type RateLimitScopeDimension = "venue" | "account" | "endpoint";

/** Priority-specific bucket headroom held back from other priorities. */
export interface RateLimitBucketReserve {
  /** Priority that may consume the full published bucket limit. */
  priority: RateLimitPriority;
  /** Number of bucket units reserved from non-matching priorities. */
  units: number;
}

/** Fixed-window budget bucket owned by a venue topology. */
export interface RateLimitBucketDescriptor {
  /** Stable bucket id referenced by RateLimitCost.bucketId. */
  id: string;
  /** Exchange budget family, such as request weight or order count. */
  kind: RateLimitBucketKind;
  /** Published bucket capacity in the same units as RateLimitCost.cost. */
  limit: number;
  /** Fixed-window interval length in milliseconds. */
  intervalMs: number;
  /** Dimensions included when deriving the bucket state key. */
  scope: readonly RateLimitScopeDimension[];
  /**
   * Fraction of limit the default limiter should normally target before
   * reserve handling. Omitted means the limiter-wide default.
   */
  utilizationTarget?: number;
  /**
   * Optional priority reserve. Non-matching priorities use the target limit
   * minus reserve.units, clamped to zero; the matching priority may use limit.
   */
  reserve?: RateLimitBucketReserve;
}

/** Cost of one plan against one bucket. */
export interface RateLimitCost {
  /** Bucket id declared in the same topology. */
  bucketId: string;
  /** Units consumed in that bucket when this plan is admitted. */
  cost: number;
}

/** Request admission plan selected by an adapter for a semantic operation. */
export interface RateLimitPlan {
  /** Stable semantic plan id, not necessarily identical to endpointKey. */
  id: string;
  /** Bucket costs that must all be admitted atomically. */
  costs: readonly RateLimitCost[];
  /** Default priority for requests using this plan. */
  priority?: RateLimitPriority;
}

/**
 * Venue-owned rate-limit topology.
 *
 * Buckets describe fixed-window budgets. Plans map adapter operations to the
 * bucket costs consumed by one request.
 */
export interface RateLimitTopology {
  /** Stable topology id, typically venue-scoped. */
  id: string;
  /** Bucket descriptors referenced by plans. */
  buckets: readonly RateLimitBucketDescriptor[];
  /** Operation plans that map requests to bucket costs. */
  plans: readonly RateLimitPlan[];
}

/**
 * Opaque admission token returned by RateLimiter.beforeRequest().
 *
 * Adapters must not inspect or construct this token. They pass it back through
 * RateLimitResponseContext.reservation or RateLimitTransportErrorContext.
 */
export interface RateLimitReservation {
  readonly __opaqueRateLimitReservation?: never;
}

export interface RateLimitTopologyRegistry {
  /**
   * Registers a venue topology with the limiter.
   *
   * Re-registering an identical descriptor is idempotent. A conflicting bucket
   * or plan descriptor should be rejected instead of overwritten.
   */
  registerRateLimitTopology(topology: RateLimitTopology): void;
}

/** Explicit no-token result for custom limiters that only wait or observe. */
// biome-ignore lint/suspicious/noConfusingVoidType: Existing custom limiters return void; the SPI must keep that source-compatible.
export type RateLimitNoReservation = void;

/**
 * Return type for RateLimiter.beforeRequest().
 *
 * Return void/Promise<void> when no token is needed. Return a reservation when
 * later response/error hooks need to reconcile the admitted request.
 */
export type RateLimitBeforeRequestResult =
  | Promise<RateLimitReservation | RateLimitNoReservation>
  | RateLimitReservation
  | RateLimitNoReservation;

/** Diagnostic snapshot for one registered bucket at the current scope. */
export interface RateLimitBucketSnapshot {
  /** Bucket id from the registered descriptor. */
  bucketId: string;
  /** Bucket family from the registered descriptor. */
  kind: RateLimitBucketKind;
  /** Published bucket capacity. */
  limit: number;
  /** Fixed-window interval length in milliseconds. */
  intervalMs: number;
  /** Effective utilization target used for normal admission. */
  utilizationTarget?: number;
  /** Priority reserve copied from the descriptor, when configured. */
  reserve?: RateLimitBucketReserve;
  /** Units observed or pre-reserved in the active window. */
  used?: number;
  /** Active fixed-window start time as epoch milliseconds. */
  windowStartMs?: number;
  /** Active fixed-window end time as epoch milliseconds. */
  windowEndMs?: number;
  /** Epoch milliseconds until which this bucket is blocked. */
  blockedUntil?: number;
  /** Most recent Retry-After duration in milliseconds, when available. */
  retryAfterMs?: number;
  /** `"ok"` admits normally, `"rate_limited"` waits, `"banned"` is a ban. */
  state: "ok" | "rate_limited" | "banned";
  /** Last update time as epoch milliseconds. */
  updatedAt?: number;
}

export interface RateLimitOptions {
  utilizationTarget?: number;
}

export interface RateLimitRequestContext {
  scope: RateLimitScope;
  planId?: string;
  priority?: RateLimitPriority;
}

export interface RateLimitResponseContext {
  status: number;
  headers?: Headers;
  usage?: RateLimitUsage;
  reservation?: RateLimitReservation;
}

export interface RateLimitTransportErrorContext {
  status?: number;
  headers?: Headers;
  retryAfterMs?: number;
  usage?: RateLimitUsage;
  reservation?: RateLimitReservation;
  requestNotSent?: boolean;
}

export interface RateLimitSnapshot {
  scope: RateLimitScope;
  usage?: RateLimitUsage;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: "ok" | "rate_limited" | "banned";
  updatedAt?: number;
  buckets?: RateLimitBucketSnapshot[];
}

export interface RateLimiter {
  /**
   * Waits for request admission and optionally returns an opaque reservation.
   *
   * @example
   * ```ts
   * const reservations = new WeakMap<RateLimitReservation, { cost: number }>();
   *
   * const limiter: RateLimiter = {
   *   async beforeRequest() {
   *     const reservation: RateLimitReservation = {};
   *     reservations.set(reservation, { cost: 1 });
   *     return reservation;
   *   },
   *   afterResponse(_ctx, response) {
   *     if (response.reservation) reservations.delete(response.reservation);
   *   },
   *   onTransportError(_ctx, error) {
   *     if (error.reservation && error.requestNotSent) {
   *       reservations.delete(error.reservation);
   *     }
   *   },
   *   getSnapshot(scope) {
   *     return { scope, state: "ok" };
   *   },
   * };
   * ```
   */
  beforeRequest(ctx: RateLimitRequestContext): RateLimitBeforeRequestResult;
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

export interface MarketRuntimeOptions {
  l1InitialMessageTimeoutMs?: number;
  l1StaleAfterMs?: number;
  l1ReconnectDelayMs?: number;
  l1ReconnectMaxDelayMs?: number;
  venues?: {
    binance?: BinanceMarketRuntimeOptions;
    deribit?: DeribitMarketRuntimeOptions;
  };
}

export interface BinanceMarketRuntimeOptions {
  /** Market-data API key for Binance public raw historical trades. */
  apiKey?: string;
}

export interface DeribitMarketRuntimeOptions {
  /** Deribit option underlyings mapped to public/get_instruments currency. */
  underlyings?: string[];
}

export interface BinanceAccountRuntimeOptions {
  riskPollIntervalMs?: number;
  privateReconcileIntervalMs?: number;
  privateStreamStaleAfterMs?: number;
  listenKeyKeepAliveMs?: number;
}

export interface JuplendAccountRuntimeOptions {
  pollIntervalMs?: number;
  jupApiKey?: string;
}

export interface AccountRuntimeOptions {
  streamOpenTimeoutMs?: number;
  streamReconnectDelayMs?: number;
  streamReconnectMaxDelayMs?: number;
  venues?: {
    binance?: BinanceAccountRuntimeOptions;
    juplend?: JuplendAccountRuntimeOptions;
  };
}

export interface OrderRuntimeOptions {
  maxClosedOrdersPerSymbol?: number;
  missingOrderEvictionThreshold?: number;
  pendingClaimTtlMs?: number;
}

export interface FeeRatePair {
  maker: string;
  taker: string;
}

export interface FeeRuntimeOptions {
  refreshIntervalMs?: number;
  defaultRates?: Partial<
    Record<Venue, Partial<Record<MarketType, FeeRatePair>>>
  >;
}

export interface RiskLimitRuntimeOptions {
  refreshIntervalMs?: number;
}

export interface CreateClientOptions {
  /** Runtime venues to register. Omit to enable all SDK runtime-supported venues. */
  venues?: Venue[];
  sandbox?: boolean;
  /** Request/signing clock override; local receivedAt/freshness clocks stay independent. */
  clock?: TimeProvider;
  rateLimiter?: RateLimiter;
  rateLimit?: RateLimitOptions;
  onMetric?: OnMetric;
  logger?: Logger;
  logLevel?: LogLevel;
  market?: MarketRuntimeOptions;
  account?: AccountRuntimeOptions;
  order?: OrderRuntimeOptions;
  fee?: FeeRuntimeOptions;
  riskLimit?: RiskLimitRuntimeOptions;
}

export interface AccountCredentials {
  apiKey?: string;
  secret?: string;
  password?: string;
  extra?: Record<string, string>;
}

export interface BinanceAccountOptions {
  timestamp?: number;
  recvWindow?: number;
}

export interface JuplendAccountOptions {
  walletAddress: string;
  vaultId?: string;
  positionId?: string;
}

export interface RegisterCexAccountInput {
  accountId: string;
  venue: Exclude<Venue, "juplend">;
  credentials?: AccountCredentials;
  options?: BinanceAccountOptions;
}

export interface RegisterJuplendAccountInput {
  accountId: string;
  venue: "juplend";
  credentials?: AccountCredentials;
  options: JuplendAccountOptions;
}

export type RegisterAccountInput =
  | RegisterCexAccountInput
  | RegisterJuplendAccountInput;

export interface RegisterAccountResult {
  accountId: string;
  venue: Venue;
}

export interface StopOptions {
  graceful?: boolean;
  timeoutMs?: number;
}

export type EventStreamMode = "buffer" | "conflate";

export interface EventStreamOptions {
  mode?: EventStreamMode;
  maxBuffer?: number;
}

export interface BufferedEventStreamOptions {
  maxBuffer?: number;
}

export interface AcexInternalError {
  source:
    | "client"
    | "market"
    | "account"
    | "order"
    | "fee"
    | "adapter"
    | "runtime";
  venue?: Venue;
  accountId?: string;
  symbol?: string;
  stream?: string;
  maxBuffer?: number;
  error: Error;
  ts: number;
}

export type SubscriptionActivity = "active" | "inactive";

export type MarketFreshness = "fresh" | "stale" | "reconciling";

export type PrivateRuntimeStatus =
  | "bootstrap_pending"
  | "healthy"
  | "degraded"
  | "reconnecting"
  | "reconciling"
  | "stopped";

export type PrivateRuntimeReason =
  | "credentials_missing"
  | "auth_failed"
  | "http_failed"
  | "rate_limited"
  | "ws_disconnected"
  | "heartbeat_timeout"
  | "reconciling";
