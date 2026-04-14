import type { Exchange, MarketDefinition } from "../types/index.ts";

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

export interface MarketAdapter {
  readonly exchange: Exchange;
  loadMarkets(): Promise<MarketDefinition[]>;
  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle;
}
