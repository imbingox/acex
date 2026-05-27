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
  };
  juplend?: {
    pollIntervalMs?: number;
    rpcUrl?: string;
    jupApiKey?: string;
  };
}

export interface CreateClientOptions {
  sandbox?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  market?: MarketRuntimeOptions;
  account?: AccountRuntimeOptions;
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

export interface AcexInternalError {
  source: "client" | "market" | "account" | "order" | "adapter" | "runtime";
  venue?: Venue;
  accountId?: string;
  symbol?: string;
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
