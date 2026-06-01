import { SubscriptionMultiplexer } from "../../internal/subscription-multiplexer.ts";
import type {
  MarketDefinition,
  VenueMarketCapabilities,
} from "../../types/index.ts";
import type {
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  StreamHandle,
} from "../types.ts";
import {
  type BinanceMarketDefinition,
  loadBinanceMarkets,
} from "./market-catalog.ts";
import {
  type BinanceStreamDescriptor,
  type BinanceStreamMessage,
  type BinanceStreamPayload,
  BinanceStreamProtocol,
} from "./stream-protocol.ts";

const BINANCE_CONTROL_FRAME_MAX_PER_SEC = 5;
// Binance allows up to 1024 streams per connection; keep a conservative pool cap.
const BINANCE_MAX_SUBSCRIPTIONS_PER_CONNECTION = 200;

type BinanceMarketMultiplexer = SubscriptionMultiplexer<
  BinanceStreamMessage,
  BinanceStreamDescriptor,
  BinanceStreamPayload
>;

export class BinanceMarketAdapter implements MarketAdapter {
  readonly venue = "binance" as const;
  readonly marketCapabilities: VenueMarketCapabilities = {
    catalog: "supported",
    l1Book: "supported",
    fundingRate: "market_dependent",
    marketTypes: ["spot", "swap", "future"],
  };

  private readonly definitions = new Map<string, BinanceMarketDefinition>();
  private multiplexer: BinanceMarketMultiplexer | undefined;

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

    const handle = this.getMultiplexer(options).subscribe(
      {
        channel: "l1book",
        market: binanceMarket,
      },
      {
        onPayload(payload, receivedAt) {
          if (payload.channel !== "l1book") {
            return;
          }

          callbacks.onUpdate({
            bidPrice: payload.bidPrice,
            bidSize: payload.bidSize,
            askPrice: payload.askPrice,
            askSize: payload.askSize,
            exchangeTs: payload.exchangeTs,
            receivedAt,
          });
        },
        onFreshnessChange: callbacks.onFreshnessChange,
        onDisconnected: callbacks.onDisconnected,
        onError: callbacks.onError,
      },
    );

    return {
      ready: handle.ready,
      close(): void {
        handle.close();
      },
    };
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

    const handle = this.getMultiplexer(options).subscribe(
      {
        channel: "fundingRate",
        market: binanceMarket,
      },
      {
        onPayload(payload, receivedAt) {
          if (payload.channel !== "fundingRate") {
            return;
          }

          callbacks.onUpdate({
            fundingRate: payload.fundingRate,
            nextFundingTime: payload.nextFundingTime,
            markPrice: payload.markPrice,
            indexPrice: payload.indexPrice,
            exchangeTs: payload.exchangeTs,
            receivedAt,
          });
        },
        onFreshnessChange: callbacks.onFreshnessChange,
        onDisconnected: callbacks.onDisconnected,
        onError: callbacks.onError,
      },
    );

    return {
      ready: handle.ready,
      close(): void {
        handle.close();
      },
    };
  }

  private getMultiplexer(
    options: L1BookStreamOptions | FundingRateStreamOptions,
  ): BinanceMarketMultiplexer {
    if (!this.multiplexer) {
      // First stream options win; MarketManager passes matching L1/funding timing values.
      this.multiplexer = new SubscriptionMultiplexer(
        new BinanceStreamProtocol(),
        {
          initialMessageTimeoutMs: options.initialMessageTimeoutMs,
          staleAfterMs: options.staleAfterMs,
          reconnectDelayMs: options.reconnectDelayMs,
          reconnectMaxDelayMs: options.reconnectMaxDelayMs,
          controlFrameMaxPerSec: BINANCE_CONTROL_FRAME_MAX_PER_SEC,
          maxSubscriptionsPerConnection:
            BINANCE_MAX_SUBSCRIPTIONS_PER_CONNECTION,
          now: options.now,
        },
      );
    }

    return this.multiplexer;
  }
}
