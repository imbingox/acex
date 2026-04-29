import { createManagedWebSocket } from "../../internal/managed-websocket.ts";
import type { BinanceMarketDefinition } from "./market-catalog.ts";

export interface BinanceFundingRateUpdate {
  fundingRate: string;
  nextFundingTime?: number;
  markPrice?: string;
  indexPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface BinanceMarkPriceSubscription {
  readonly ready: Promise<void>;
  close(): void;
}

export interface BinanceMarkPriceCallbacks {
  onFundingRate(update: BinanceFundingRateUpdate): void;
  onFreshnessChange(
    freshness: "fresh" | "stale",
    reason?: "heartbeat_timeout",
  ): void;
  onDisconnected(): void;
  onError?(error: Error): void;
}

export interface BinanceMarkPriceOptions {
  initialMessageTimeoutMs: number;
  staleAfterMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  now?: () => number;
}

interface BinanceMarkPriceMessage {
  e?: string;
  E?: number;
  s?: string;
  p?: string;
  i?: string;
  r?: string;
  T?: number;
}

const BINANCE_USDM_MARKET_WS_BASE_URL = "wss://fstream.binance.com/market/ws";
const BINANCE_COINM_WS_BASE_URL = "wss://dstream.binance.com/ws";

function getWsBaseUrl(market: BinanceMarketDefinition): string {
  switch (market.family) {
    case "usdm":
      return BINANCE_USDM_MARKET_WS_BASE_URL;
    case "coinm":
      return BINANCE_COINM_WS_BASE_URL;
    case "spot":
      throw new Error(
        `Funding rate is not supported for spot market: ${market.symbol}`,
      );
  }
}

function buildMarkPriceUrl(market: BinanceMarketDefinition): string {
  return `${getWsBaseUrl(market)}/${market.id.toLowerCase()}@markPrice`;
}

function parseMarkPriceMessage(
  data: string,
): BinanceMarkPriceMessage | undefined {
  const parsed = JSON.parse(data) as BinanceMarkPriceMessage;
  if (!parsed.r) {
    return undefined;
  }

  return parsed;
}

export function subscribeBinanceMarkPrice(
  market: BinanceMarketDefinition,
  callbacks: BinanceMarkPriceCallbacks,
  options: BinanceMarkPriceOptions,
): BinanceMarkPriceSubscription {
  const session = createManagedWebSocket<BinanceMarkPriceMessage>({
    url: buildMarkPriceUrl(market),
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
    parseMessage: parseMarkPriceMessage,
    onMessage(message, receivedAt) {
      if (!message.r) {
        return;
      }

      callbacks.onFundingRate({
        fundingRate: message.r,
        nextFundingTime: message.T,
        markPrice: message.p,
        indexPrice: message.i,
        exchangeTs: message.E,
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
