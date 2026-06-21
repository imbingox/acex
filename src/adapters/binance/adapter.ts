import { SubscriptionMultiplexer } from "../../internal/subscription-multiplexer.ts";
import type {
  MarketDefinition,
  RateLimiter,
  VenueMarketCapabilities,
  VenueServerTime,
} from "../../types/index.ts";
import { METRIC_NAMES, type OnMetric } from "../../types/index.ts";
import type {
  FetchFundingRateHistoryRequest,
  FetchPublicRawTradesRequest,
  FetchPublicTradesRequest,
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawFundingRateHistoryResult,
  RawPublicTradesResult,
  StreamHandle,
} from "../types.ts";
import { fetchBinanceFundingRateHistory } from "./funding-history.ts";
import {
  BinanceMarketCatalog,
  type BinanceMarketDefinition,
  type BinanceMarketFamily,
} from "./market-catalog.ts";
import {
  fetchBinancePublicRawTrades,
  fetchBinancePublicTrades,
} from "./public-trades.ts";
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
    publicTrades: "supported",
    publicRawTrades: "supported",
    fundingRateHistory: "supported",
    l1Book: "supported",
    fundingRate: "market_dependent",
    marketTypes: ["spot", "swap", "future"],
  };

  private readonly catalog: BinanceMarketCatalog;
  private multiplexer: BinanceMarketMultiplexer | undefined;
  private multiplexerConfig: BinanceMultiplexerConfig | undefined;

  constructor(
    private readonly options: {
      readonly rateLimiter?: RateLimiter;
      readonly marketCatalog?: BinanceMarketCatalog;
      readonly emitMetric?: OnMetric;
      readonly marketDataApiKey?: string;
    } = {},
  ) {
    this.catalog =
      options.marketCatalog ??
      new BinanceMarketCatalog({ rateLimiter: this.options.rateLimiter });
    registerBinanceRateLimitTopology(this.options.rateLimiter);
  }

  async loadMarkets(): Promise<MarketDefinition[]> {
    return await this.catalog.loadAll();
  }

  async fetchServerTime(): Promise<VenueServerTime> {
    return await fetchBinanceServerTime({
      rateLimiter: this.options.rateLimiter,
    });
  }

  async fetchPublicTrades(
    market: MarketDefinition,
    request: FetchPublicTradesRequest,
  ): Promise<RawPublicTradesResult> {
    const binanceMarket = this.getBinanceMarket(market);
    if (!binanceMarket) {
      throw new Error(`Unknown Binance market: ${market.symbol}`);
    }

    return await fetchBinancePublicTrades(binanceMarket, request, {
      rateLimiter: this.options.rateLimiter,
    });
  }

  async fetchPublicRawTrades(
    market: MarketDefinition,
    request: FetchPublicRawTradesRequest,
  ): Promise<RawPublicTradesResult> {
    const binanceMarket = this.getBinanceMarket(market);
    if (!binanceMarket) {
      throw new Error(`Unknown Binance market: ${market.symbol}`);
    }

    return await fetchBinancePublicRawTrades(binanceMarket, request, {
      apiKey: this.options.marketDataApiKey,
      rateLimiter: this.options.rateLimiter,
    });
  }

  assertPublicRawTradesConfigured(): void {
    if (this.options.marketDataApiKey?.trim()) {
      return;
    }

    throw new Error(
      "Binance public raw trades require a market API key; set CreateClientOptions.market.venues.binance.apiKey or BINANCE_MARKET_API_KEY",
    );
  }

  async fetchFundingRateHistory(
    market: MarketDefinition,
    request: FetchFundingRateHistoryRequest,
  ): Promise<RawFundingRateHistoryResult> {
    const binanceMarket = this.getBinanceMarket(market);
    if (!binanceMarket) {
      throw new Error(`Unknown Binance market: ${market.symbol}`);
    }

    return await fetchBinanceFundingRateHistory(binanceMarket, request, {
      rateLimiter: this.options.rateLimiter,
    });
  }

  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle {
    const binanceMarket = this.getBinanceMarket(market);
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
    const binanceMarket = this.getBinanceMarket(market);
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
      this.multiplexer = new SubscriptionMultiplexer<
        BinanceStreamMessage,
        BinanceStreamDescriptor,
        BinanceStreamPayload
      >(new BinanceStreamProtocol(), {
        initialMessageTimeoutMs: config.initialMessageTimeoutMs,
        staleAfterMs: config.staleAfterMs,
        reconnectDelayMs: config.reconnectDelayMs,
        reconnectMaxDelayMs: config.reconnectMaxDelayMs,
        controlFrameMaxPerSec: BINANCE_CONTROL_FRAME_MAX_PER_SEC,
        maxSubscriptionsPerConnection: BINANCE_MAX_SUBSCRIPTIONS_PER_CONNECTION,
        now: config.now,
        onReconnect: ({ descriptors }) => {
          this.emitReconnectMetric(descriptors);
        },
      });
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

  private getBinanceMarket(
    market: MarketDefinition,
  ): BinanceMarketDefinition | undefined {
    return this.catalog.getDefinition(
      inferBinanceMarketFamily(market),
      market.symbol,
    );
  }

  private emitReconnectMetric(
    descriptors: readonly BinanceStreamDescriptor[],
  ): void {
    const emitMetric = this.options.emitMetric;
    if (!emitMetric) {
      return;
    }

    const channels = new Set(
      descriptors.map((descriptor) => descriptor.channel),
    );
    for (const channel of channels) {
      emitMetric(METRIC_NAMES.wsReconnect, 1, "counter", {
        venue: this.venue,
        channel,
      });
    }
  }
}

function inferBinanceMarketFamily(
  market: Pick<MarketDefinition, "contract" | "inverse" | "linear" | "type">,
): BinanceMarketFamily {
  if (!market.contract || market.type === "spot") {
    return "spot";
  }

  return market.inverse ? "coinm" : "usdm";
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
