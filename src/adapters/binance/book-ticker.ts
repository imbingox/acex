import { createManagedWebSocket } from "../../internal/managed-websocket.ts";
import type { BinanceMarketDefinition } from "./market-catalog.ts";

export interface BinanceL1BookUpdate {
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface BinanceBookTickerSubscription {
  readonly ready: Promise<void>;
  close(): void;
}

export interface BinanceBookTickerCallbacks {
  onBookTicker(update: BinanceL1BookUpdate): void;
  onFreshnessChange(
    freshness: "fresh" | "stale",
    reason?: "heartbeat_timeout",
  ): void;
  onDisconnected(): void;
  onError?(error: Error): void;
}

export interface BinanceBookTickerOptions {
  initialMessageTimeoutMs: number;
  staleAfterMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  now?: () => number;
}

interface BinanceBookTickerMessage {
  b?: string;
  B?: string;
  a?: string;
  A?: string;
  T?: number;
}

const BINANCE_SPOT_WS_BASE_URL = "wss://stream.binance.com:9443/ws";
const BINANCE_USDM_WS_BASE_URL = "wss://fstream.binance.com/ws";
const BINANCE_COINM_WS_BASE_URL = "wss://dstream.binance.com/ws";

function getWsBaseUrl(market: BinanceMarketDefinition): string {
  switch (market.family) {
    case "spot":
      return BINANCE_SPOT_WS_BASE_URL;
    case "usdm":
      return BINANCE_USDM_WS_BASE_URL;
    case "coinm":
      return BINANCE_COINM_WS_BASE_URL;
  }
}

function buildBookTickerUrl(market: BinanceMarketDefinition): string {
  return `${getWsBaseUrl(market)}/${market.id.toLowerCase()}@bookTicker`;
}

function parseBookTickerMessage(
  data: string,
): BinanceBookTickerMessage | undefined {
  const parsed = JSON.parse(data) as BinanceBookTickerMessage;
  if (!parsed.b || !parsed.B || !parsed.a || !parsed.A) {
    return undefined;
  }

  return parsed;
}

export function subscribeBinanceBookTicker(
  market: BinanceMarketDefinition,
  callbacks: BinanceBookTickerCallbacks,
  options: BinanceBookTickerOptions,
): BinanceBookTickerSubscription {
  const session = createManagedWebSocket<BinanceBookTickerMessage>({
    url: buildBookTickerUrl(market),
    initialMessageTimeoutMs: options.initialMessageTimeoutMs,
    now: options.now,
    messageWatchdog: {
      staleAfterMs: options.staleAfterMs,
      onStale() {
        callbacks.onFreshnessChange("stale", "heartbeat_timeout");
      },
    },
    reconnect: {
      initialDelayMs: options.reconnectDelayMs,
      maxDelayMs: options.reconnectMaxDelayMs,
    },
    parseMessage: parseBookTickerMessage,
    onMessage(message, receivedAt) {
      if (!message.b || !message.B || !message.a || !message.A) {
        return;
      }

      callbacks.onBookTicker({
        bidPrice: message.b,
        bidSize: message.B,
        askPrice: message.a,
        askSize: message.A,
        exchangeTs: message.T,
        receivedAt,
      });
      callbacks.onFreshnessChange("fresh");
    },
    onUnexpectedClose() {
      callbacks.onDisconnected();
    },
    onError() {
      callbacks.onError?.(new Error(`WebSocket error for ${market.symbol}`));
    },
  });

  return {
    ready: session.ready,
    close() {
      session.close();
    },
  };
}
