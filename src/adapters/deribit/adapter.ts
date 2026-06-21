import { SubscriptionMultiplexer } from "../../internal/subscription-multiplexer.ts";
import type {
  MarketDefinition,
  RateLimiter,
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
  DeribitMarketCatalog,
  type DeribitMarketCatalogOptions,
} from "./market-catalog.ts";
import {
  type DeribitStreamDescriptor,
  type DeribitStreamMessage,
  type DeribitStreamPayload,
  DeribitStreamProtocol,
  type DeribitStreamStatusPayload,
} from "./stream-protocol.ts";

const DERIBIT_CONTROL_FRAME_MAX_PER_SEC = 5;
const DERIBIT_MAX_SUBSCRIPTIONS_PER_CONNECTION = 200;

type DeribitMarketMultiplexer = SubscriptionMultiplexer<
  DeribitStreamMessage,
  DeribitStreamDescriptor,
  DeribitStreamPayload,
  DeribitStreamStatusPayload
>;

interface DeribitMultiplexerConfig {
  readonly initialMessageTimeoutMs: number;
  readonly staleAfterMs: number;
  readonly reconnectDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly now?: () => number;
}

export interface DeribitMarketAdapterOptions
  extends DeribitMarketCatalogOptions {
  readonly marketCatalog?: DeribitMarketCatalog;
  readonly rateLimiter?: RateLimiter;
}

export class DeribitMarketAdapter implements MarketAdapter {
  readonly venue = "deribit" as const;
  readonly readOnly = true;
  readonly notes = [
    "Deribit runtime currently supports public option market data only.",
  ];
  readonly marketCapabilities: VenueMarketCapabilities = {
    catalog: "supported",
    serverTime: "unsupported",
    publicTrades: "unsupported",
    publicRawTrades: "unsupported",
    fundingRateHistory: "unsupported",
    l1Book: "supported",
    fundingRate: "unsupported",
    marketTypes: ["option"],
  };

  private readonly catalog: DeribitMarketCatalog;
  private multiplexer: DeribitMarketMultiplexer | undefined;
  private multiplexerConfig: DeribitMultiplexerConfig | undefined;

  constructor(options: DeribitMarketAdapterOptions = {}) {
    this.catalog =
      options.marketCatalog ??
      new DeribitMarketCatalog({
        fetchFn: options.fetchFn,
        rateLimiter: options.rateLimiter,
        underlyings: options.underlyings,
      });
  }

  async loadMarkets(): Promise<MarketDefinition[]> {
    return await this.catalog.loadAll();
  }

  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle {
    const deribitMarket = this.getDeribitMarket(market);
    if (!deribitMarket) {
      throw new Error(`Unknown Deribit option market: ${market.symbol}`);
    }

    const handle = this.getMultiplexer(options).subscribe(
      {
        channel: "l1book",
        market: deribitMarket,
      },
      {
        onPayload(payload, receivedAt) {
          callbacks.onUpdate({
            bidPrice: payload.bidPrice,
            bidSize: payload.bidSize,
            askPrice: payload.askPrice,
            askSize: payload.askSize,
            exchangeTs: payload.exchangeTs,
            receivedAt,
          });
        },
        onStatus(payload, receivedAt) {
          if (payload.reason !== "no_quote") {
            return;
          }

          callbacks.onNoQuote?.({
            exchangeTs: payload.exchangeTs,
            receivedAt,
            raw: payload.raw,
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
    _callbacks: FundingRateStreamCallbacks,
    _options: FundingRateStreamOptions,
  ): StreamHandle {
    throw new Error(
      `Deribit funding rate stream is unsupported: ${market.symbol}`,
    );
  }

  private getMultiplexer(
    options: L1BookStreamOptions,
  ): DeribitMarketMultiplexer {
    const config: DeribitMultiplexerConfig = {
      initialMessageTimeoutMs: options.initialMessageTimeoutMs,
      staleAfterMs: options.staleAfterMs,
      reconnectDelayMs: options.reconnectDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      now: options.now,
    };

    if (!this.multiplexer) {
      this.multiplexer = new SubscriptionMultiplexer<
        DeribitStreamMessage,
        DeribitStreamDescriptor,
        DeribitStreamPayload,
        DeribitStreamStatusPayload
      >(new DeribitStreamProtocol(), {
        initialMessageTimeoutMs: config.initialMessageTimeoutMs,
        staleAfterMs: config.staleAfterMs,
        reconnectDelayMs: config.reconnectDelayMs,
        reconnectMaxDelayMs: config.reconnectMaxDelayMs,
        controlFrameMaxPerSec: DERIBIT_CONTROL_FRAME_MAX_PER_SEC,
        maxSubscriptionsPerConnection: DERIBIT_MAX_SUBSCRIPTIONS_PER_CONNECTION,
        now: config.now,
      });
      this.multiplexerConfig = config;
      return this.multiplexer;
    }

    if (
      !this.multiplexerConfig ||
      !sameMultiplexerConfig(config, this.multiplexerConfig)
    ) {
      throw new Error(
        "Deribit market stream options differ from the active multiplexer; create a new adapter instance for different stream timing options",
      );
    }

    return this.multiplexer;
  }

  private getDeribitMarket(
    market: MarketDefinition,
  ): ReturnType<DeribitMarketCatalog["getDefinition"]> | undefined {
    if (market.type !== "option") {
      return undefined;
    }

    return this.catalog.getDefinition(market.symbol);
  }
}

function sameMultiplexerConfig(
  left: DeribitMultiplexerConfig,
  right: DeribitMultiplexerConfig,
): boolean {
  return (
    left.initialMessageTimeoutMs === right.initialMessageTimeoutMs &&
    left.staleAfterMs === right.staleAfterMs &&
    left.reconnectDelayMs === right.reconnectDelayMs &&
    left.reconnectMaxDelayMs === right.reconnectMaxDelayMs &&
    left.now === right.now
  );
}
