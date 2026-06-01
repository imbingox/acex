import type BigNumber from "bignumber.js";
import type { MarketFreshness, SubscriptionActivity, Venue } from "./shared.ts";

export type MarketType = "spot" | "swap" | "future";

export interface MarketDefinition {
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

export interface MarketDataStatus {
  venue: Venue;
  symbol: string;
  activity: SubscriptionActivity;
  ready: boolean;
  freshness?: MarketFreshness;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: "ws_disconnected" | "heartbeat_timeout" | "reconciling";
}

export interface MarketDataStreamStatus {
  activity: SubscriptionActivity;
  ready: boolean;
  freshness?: MarketFreshness;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: MarketDataStatus["reason"];
}

export interface MarketKeyInput {
  venue: Venue;
  symbol: string;
}

export type DecimalInput = string | number | BigNumber;

export type NormalizeOrderInputRejectReason =
  | "price_not_positive"
  | "amount_not_positive"
  | "amount_below_min"
  | "notional_below_min";

export interface NormalizeOrderInputInput extends MarketKeyInput {
  price: DecimalInput;
  amount: DecimalInput;
}

export interface NormalizedOrderInput {
  price: string;
  amount: string;
  rawPrice: string;
  rawAmount: string;
  adjusted: boolean;
  accepted: boolean;
  rejectReason?: NormalizeOrderInputRejectReason;
  priceStep: string;
  amountStep: string;
  minAmount?: string;
  minNotional?: string;
}

export interface SubscribeL1BookInput extends MarketKeyInput {}

export interface SubscribeFundingRateInput extends MarketKeyInput {}

export interface MarketEventFilter {
  venue?: Venue;
  symbol?: string;
}

export interface L1Book {
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

export interface FundingRateSnapshot {
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

export interface MarketStatusChangedEvent {
  type: "market.status_changed";
  venue: Venue;
  symbol: string;
  status: MarketDataStatus;
  ts: number;
}

export interface L1BookUpdatedEvent {
  type: "l1_book.updated";
  venue: Venue;
  symbol: string;
  snapshot: L1Book;
  ts: number;
}

export interface FundingRateUpdatedEvent {
  type: "funding_rate.updated";
  venue: Venue;
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

  getMarket(venue: Venue, symbol: string): MarketDefinition | undefined;
  getMarkets(symbol: string): MarketDefinition[];
  listMarkets(venue?: Venue): MarketDefinition[];
  normalizeOrderInput(input: NormalizeOrderInputInput): NormalizedOrderInput;
  getL1Book(key: MarketKeyInput): L1Book | undefined;
  getL1Books(symbol: string): L1Book[];
  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined;
  getFundingRates(symbol: string): FundingRateSnapshot[];
  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined;
}
