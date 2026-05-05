import type { MarketDefinition } from "../../types/index.ts";
import type {
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  StreamHandle,
} from "../types.ts";
import { subscribeBinanceBookTicker } from "./book-ticker.ts";
import { subscribeBinanceMarkPrice } from "./mark-price.ts";
import {
  type BinanceMarketDefinition,
  loadBinanceMarkets,
} from "./market-catalog.ts";

export class BinanceMarketAdapter implements MarketAdapter {
  readonly venue = "binance" as const;

  private readonly definitions = new Map<string, BinanceMarketDefinition>();

  async loadMarkets(): Promise<MarketDefinition[]> {
    const markets = await loadBinanceMarkets();
    this.definitions.clear();

    for (const market of markets) {
      this.definitions.set(market.symbol, market);
    }

    return markets;
  }

  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle {
    const binanceMarket = this.definitions.get(market.symbol);
    if (!binanceMarket) {
      throw new Error(`Unknown Binance market: ${market.symbol}`);
    }

    return subscribeBinanceBookTicker(
      binanceMarket,
      {
        onBookTicker(update) {
          callbacks.onUpdate(update);
        },
        onFreshnessChange: callbacks.onFreshnessChange,
        onDisconnected: callbacks.onDisconnected,
        onError: callbacks.onError,
      },
      options,
    );
  }

  createFundingRateStream(
    market: MarketDefinition,
    callbacks: FundingRateStreamCallbacks,
    options: FundingRateStreamOptions,
  ): StreamHandle {
    const binanceMarket = this.definitions.get(market.symbol);
    if (!binanceMarket) {
      throw new Error(`Unknown Binance market: ${market.symbol}`);
    }

    return subscribeBinanceMarkPrice(
      binanceMarket,
      {
        onFundingRate(update) {
          callbacks.onUpdate(update);
        },
        onFreshnessChange: callbacks.onFreshnessChange,
        onDisconnected: callbacks.onDisconnected,
        onError: callbacks.onError,
      },
      options,
    );
  }
}
