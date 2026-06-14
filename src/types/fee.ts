import type { MarketType, Venue } from "./shared.ts";

export interface SubscribeFeeRatesInput {
  accountId: string;
  symbols: string[];
}

export interface UnsubscribeFeeRatesInput {
  accountId: string;
  symbols?: string[];
}

export interface GetSymbolFeeRateInput {
  accountId: string;
  symbol: string;
}

export interface SymbolFeeRate {
  accountId: string;
  venue: Venue;
  symbol: string;
  marketType: MarketType;
  maker: string;
  taker: string;
  source: "default" | "venue";
  receivedAt: number;
}

export interface FeeManager {
  subscribe(input: SubscribeFeeRatesInput): Promise<void>;
  unsubscribe(input: UnsubscribeFeeRatesInput): Promise<void>;
  getSymbolFeeRate(input: GetSymbolFeeRateInput): SymbolFeeRate;
  getSymbolFeeRates(accountId?: string): SymbolFeeRate[];
  fetchSymbolFeeRate(input: GetSymbolFeeRateInput): Promise<SymbolFeeRate>;
}
