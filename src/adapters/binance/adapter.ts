import { SubscriptionMultiplexer } from "../../internal/subscription-multiplexer.ts";
import type {
  MarketDefinition,
  RateLimiter,
  VenueMarketCapabilities,
  VenueServerTime,
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
import { registerBinanceRateLimitTopology } from "./rate-limit-topology.ts";
import { fetchBinanceServerTime } from "./server-time.ts";
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

interface BinanceMultiplexerConfig {
  readonly initialMessageTimeoutMs: number;
  readonly staleAfterMs: number;
  readonly reconnectDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly now?: () => number;
}

export class BinanceMarketAdapter implements MarketAdapter {
  readonly venue = "binance" as const;
  readonly marketCapabilities: VenueMarketCapabilities = {
    catalog: "supported",
    serverTime: "supported",
    l1Book: "supported",
    fundingRate: "market_dependent",
    marketTypes: ["spot", "swap", "future"],
  };

  private readonly definitions = new Map<string, BinanceMarketDefinition>();
  private multiplexer: BinanceMarketMultiplexer | undefined;
  private multiplexerConfig: BinanceMultiplexerConfig | undefined;

  constructor(
    private readonly options: {
      readonly rateLimiter?: RateLimiter;
    } = {},
  ) {
    registerBinanceRateLimitTopology(this.options.rateLimiter);
  }

  async loadMarkets(): Promise<MarketDefinition[]> {
    const markets = await loadBinanceMarkets(fetch, {
      rateLimiter: this.options.rateLimiter,
    });
    this.definitions.clear();

    for (const market of markets) {
      this.definitions.set(market.symbol, market);
    }

    return markets;
  }

  async fetchServerTime(): Promise<VenueServerTime> {
    return await fetchBinanceServerTime({
      rateLimiter: this.options.rateLimiter,
    });
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
    const config: BinanceMultiplexerConfig = {
      initialMessageTimeoutMs: options.initialMessageTimeoutMs,
      staleAfterMs: options.staleAfterMs,
      reconnectDelayMs: options.reconnectDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      now: options.now,
    };

    if (!this.multiplexer) {
      this.multiplexer = new SubscriptionMultiplexer(
        new BinanceStreamProtocol(),
        {
          initialMessageTimeoutMs: config.initialMessageTimeoutMs,
          staleAfterMs: config.staleAfterMs,
          reconnectDelayMs: config.reconnectDelayMs,
          reconnectMaxDelayMs: config.reconnectMaxDelayMs,
          controlFrameMaxPerSec: BINANCE_CONTROL_FRAME_MAX_PER_SEC,
          maxSubscriptionsPerConnection:
            BINANCE_MAX_SUBSCRIPTIONS_PER_CONNECTION,
          now: config.now,
        },
      );
      this.multiplexerConfig = config;
      return this.multiplexer;
    }

    if (
      !this.multiplexerConfig ||
      !sameMultiplexerConfig(config, this.multiplexerConfig)
    ) {
      throw new Error(
        "Binance market stream options differ from the active multiplexer; create a new adapter instance for different stream timing options",
      );
    }

    return this.multiplexer;
  }
}

function sameMultiplexerConfig(
  left: BinanceMultiplexerConfig,
  right: BinanceMultiplexerConfig,
): boolean {
  return (
    left.initialMessageTimeoutMs === right.initialMessageTimeoutMs &&
    left.staleAfterMs === right.staleAfterMs &&
    left.reconnectDelayMs === right.reconnectDelayMs &&
    left.reconnectMaxDelayMs === right.reconnectMaxDelayMs &&
    left.now === right.now
  );
}
