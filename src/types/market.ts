import type {
  Exchange,
  MarketFreshness,
  SubscriptionActivity,
} from "./shared.ts";

export type MarketType = "spot" | "swap" | "future";

export interface MarketDefinition {
  exchange: Exchange;
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

export interface MarketDataStatus {
  exchange: Exchange;
  symbol: string;
  activity: SubscriptionActivity;
  ready: boolean;
  freshness?: MarketFreshness;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: "ws_disconnected" | "heartbeat_timeout" | "reconciling";
}

export interface MarketKeyInput {
  exchange: Exchange;
  symbol: string;
}

export interface SubscribeL1BookInput extends MarketKeyInput {}

export interface SubscribeFundingRateInput extends MarketKeyInput {}

export interface MarketEventFilter {
  exchange?: Exchange;
  symbol?: string;
}

export interface L1Book {
  exchange: Exchange;
  symbol: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
}

export interface FundingRateSnapshot {
  exchange: Exchange;
  symbol: string;
  fundingRate: string;
  nextFundingTime?: number;
  markPrice?: string;
  indexPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
}

export interface MarketStatusChangedEvent {
  type: "market.status_changed";
  exchange: Exchange;
  symbol: string;
  status: MarketDataStatus;
  ts: number;
}

export interface L1BookUpdatedEvent {
  type: "l1_book.updated";
  exchange: Exchange;
  symbol: string;
  snapshot: L1Book;
  ts: number;
}

export interface FundingRateUpdatedEvent {
  type: "funding_rate.updated";
  exchange: Exchange;
  symbol: string;
  snapshot: FundingRateSnapshot;
  ts: number;
}

export type MarketEvent =
  | L1BookUpdatedEvent
  | FundingRateUpdatedEvent
  | MarketStatusChangedEvent;

export interface MarketEventStreams {
  l1BookUpdates(filter?: MarketEventFilter): AsyncIterable<L1BookUpdatedEvent>;
  fundingRateUpdates(
    filter?: MarketEventFilter,
  ): AsyncIterable<FundingRateUpdatedEvent>;
  status(filter?: MarketEventFilter): AsyncIterable<MarketStatusChangedEvent>;
  all(filter?: MarketEventFilter): AsyncIterable<MarketEvent>;
}

export interface MarketManager {
  readonly events: MarketEventStreams;

  loadMarkets(): Promise<void>;
  subscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  unsubscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;
  unsubscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;

  getMarket(symbol: string): MarketDefinition | undefined;
  listMarkets(): MarketDefinition[];
  getL1Book(key: MarketKeyInput): L1Book | undefined;
  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined;
  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined;
}
