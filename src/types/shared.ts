export const SUPPORTED_EXCHANGES = ["binance", "okx", "bybit", "gate"] as const;

export type Exchange = (typeof SUPPORTED_EXCHANGES)[number];

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

export interface CreateClientOptions {
  sandbox?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  market?: MarketRuntimeOptions;
}

export interface AccountCredentials {
  apiKey?: string;
  secret?: string;
  password?: string;
  extra?: Record<string, string>;
}

export interface RegisterAccountInput {
  accountId: string;
  exchange: Exchange;
  credentials?: AccountCredentials;
  options?: Record<string, unknown>;
}

export interface RegisterAccountResult {
  accountId: string;
  exchange: Exchange;
}

export interface StopOptions {
  graceful?: boolean;
  timeoutMs?: number;
}

export interface AcexInternalError {
  source: "client" | "market" | "account" | "order" | "adapter" | "runtime";
  exchange?: Exchange;
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
