export const SUPPORTED_VENUES = [
  "binance",
  "okx",
  "bybit",
  "gate",
  "juplend",
] as const;

export type Venue = (typeof SUPPORTED_VENUES)[number];

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

export interface TimeProvider {
  /** Millisecond timestamp used for outbound request/signing timestamps. */
  now(): number;
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

export type RateLimitPriority = "normal" | "cancel" | "risk" | (string & {});

export type RateLimitBucketKind = "request_weight" | "orders" | (string & {});

export type RateLimitScopeDimension = "venue" | "account" | "endpoint";

export interface RateLimitBucketDescriptor {
  id: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  scope: readonly RateLimitScopeDimension[];
  utilizationTarget?: number;
}

export interface RateLimitCost {
  bucketId: string;
  cost: number;
}

export interface RateLimitPlan {
  id: string;
  costs: readonly RateLimitCost[];
  priority?: RateLimitPriority;
}

export interface RateLimitTopology {
  id: string;
  buckets: readonly RateLimitBucketDescriptor[];
  plans: readonly RateLimitPlan[];
}

export interface RateLimitReservation {
  readonly __opaqueRateLimitReservation?: never;
}

export interface RateLimitTopologyRegistry {
  registerRateLimitTopology(topology: RateLimitTopology): void;
}

// biome-ignore lint/suspicious/noConfusingVoidType: Existing custom limiters return void; the SPI must keep that source-compatible.
export type RateLimitNoReservation = void;

export type RateLimitBeforeRequestResult =
  | Promise<RateLimitReservation | RateLimitNoReservation>
  | RateLimitReservation
  | RateLimitNoReservation;

export interface RateLimitBucketSnapshot {
  bucketId: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  utilizationTarget?: number;
  used?: number;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: "ok" | "rate_limited" | "banned";
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
}

export interface AccountRuntimeOptions {
  streamOpenTimeoutMs?: number;
  streamReconnectDelayMs?: number;
  streamReconnectMaxDelayMs?: number;
  listenKeyKeepAliveMs?: number;
  binance?: {
    riskPollIntervalMs?: number;
    privateReconcileIntervalMs?: number;
    privateStreamStaleAfterMs?: number;
  };
  juplend?: {
    pollIntervalMs?: number;
    rpcUrl?: string;
    jupApiKey?: string;
  };
}

export interface OrderRuntimeOptions {
  maxClosedOrdersPerSymbol?: number;
  missingOrderEvictionThreshold?: number;
  pendingClaimTtlMs?: number;
}

export interface CreateClientOptions {
  sandbox?: boolean;
  /** Request/signing clock; local receivedAt/freshness clocks stay independent. */
  clock?: TimeProvider;
  rateLimiter?: RateLimiter;
  rateLimit?: RateLimitOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  market?: MarketRuntimeOptions;
  account?: AccountRuntimeOptions;
  order?: OrderRuntimeOptions;
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

export type JuplendAccountOptions =
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
  source: "client" | "market" | "account" | "order" | "adapter" | "runtime";
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
