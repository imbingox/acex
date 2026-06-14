import type {
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawFundingRateUpdate,
  RawL1BookUpdate,
  StreamHandle,
} from "../../../src/adapters/types.ts";
import { toCanonical } from "../../../src/internal/decimal.ts";
import type {
  MarketDefinition,
  Venue,
  VenueMarketCapabilities,
} from "../../../src/types/index.ts";

class DeferredReady {
  readonly promise: Promise<void>;
  private resolvePromise!: () => void;
  private rejectPromise!: (error: Error) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(): void {
    this.resolvePromise();
  }

  reject(error: Error): void {
    this.rejectPromise(error);
  }
}

export class FakeOkxL1BookStream implements StreamHandle {
  readonly ready: Promise<void>;
  closeCalls = 0;
  private readonly readyBarrier = new DeferredReady();

  constructor(private readonly callbacks: L1BookStreamCallbacks) {
    this.ready = this.readyBarrier.promise;
  }

  emitUpdate(update: RawL1BookUpdate): void {
    this.callbacks.onUpdate(update);
    this.readyBarrier.resolve();
  }

  rejectReady(error = new Error("fake okx l1 ready failed")): void {
    this.readyBarrier.reject(error);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

export class FakeOkxFundingRateStream implements StreamHandle {
  readonly ready: Promise<void>;
  closeCalls = 0;
  private readonly readyBarrier = new DeferredReady();

  constructor(private readonly callbacks: FundingRateStreamCallbacks) {
    this.ready = this.readyBarrier.promise;
  }

  emitUpdate(update: RawFundingRateUpdate): void {
    this.callbacks.onUpdate(update);
    this.readyBarrier.resolve();
  }

  rejectReady(error = new Error("fake okx funding ready failed")): void {
    this.readyBarrier.reject(error);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

export interface FakeOkxMarketAdapterOptions {
  readonly venue?: Venue;
  readonly markets?: MarketDefinition[];
  readonly failLoadMarkets?: boolean;
  readonly loadMarketsResults?: Array<MarketDefinition[] | Error>;
}

export class FakeOkxMarketAdapter implements MarketAdapter {
  readonly venue: Venue;
  readonly marketCapabilities: VenueMarketCapabilities = {
    catalog: "supported",
    serverTime: "unsupported",
    publicTrades: "unsupported",
    publicRawTrades: "unsupported",
    fundingRateHistory: "unsupported",
    l1Book: "supported",
    fundingRate: "market_dependent",
    marketTypes: ["spot", "swap"],
  };

  loadMarketsCalls = 0;
  readonly l1BookStreamMarkets: MarketDefinition[] = [];
  readonly fundingRateStreamMarkets: MarketDefinition[] = [];
  readonly l1BookStreams: FakeOkxL1BookStream[] = [];
  readonly fundingRateStreams: FakeOkxFundingRateStream[] = [];
  private readonly markets: MarketDefinition[];
  private readonly failLoadMarkets: boolean;
  private readonly loadMarketsResults: Array<MarketDefinition[] | Error>;

  constructor(options: FakeOkxMarketAdapterOptions = {}) {
    this.venue = options.venue ?? "okx";
    this.markets = options.markets ?? [createFakeOkxSwapMarket(this.venue)];
    this.failLoadMarkets = options.failLoadMarkets ?? false;
    this.loadMarketsResults = [...(options.loadMarketsResults ?? [])];
  }

  loadMarkets(): Promise<MarketDefinition[]> {
    this.loadMarketsCalls += 1;
    const nextResult = this.loadMarketsResults.shift();
    if (nextResult instanceof Error) {
      return Promise.reject(nextResult);
    }
    if (nextResult) {
      return Promise.resolve(nextResult);
    }

    if (this.failLoadMarkets) {
      return Promise.reject(new Error(`${this.venue} catalog failed`));
    }

    return Promise.resolve(this.markets);
  }

  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    _options: L1BookStreamOptions,
  ): StreamHandle {
    const stream = new FakeOkxL1BookStream(callbacks);
    this.l1BookStreamMarkets.push(market);
    this.l1BookStreams.push(stream);
    return stream;
  }

  createFundingRateStream(
    market: MarketDefinition,
    callbacks: FundingRateStreamCallbacks,
    _options: FundingRateStreamOptions,
  ): StreamHandle {
    const stream = new FakeOkxFundingRateStream(callbacks);
    this.fundingRateStreamMarkets.push(market);
    this.fundingRateStreams.push(stream);
    return stream;
  }
}

export function createFakeOkxSpotMarket(
  venue: Venue = "okx",
): MarketDefinition {
  return {
    venue,
    symbol: "BTC/USDT",
    id: "BTC-USDT",
    type: "spot",
    base: "BTC",
    quote: "USDT",
    active: true,
    contract: false,
    pricePrecision: 2,
    amountPrecision: 6,
    priceStep: toCanonical("0.01"),
    amountStep: toCanonical("0.000001"),
    minAmount: toCanonical("0.00001"),
    minNotional: toCanonical("5"),
    raw: { source: "fake-okx" },
  };
}

export function createFakeOkxSwapMarket(
  venue: Venue = "okx",
): MarketDefinition {
  return {
    venue,
    symbol: "BTC/USDT:USDT",
    id: "BTC-USDT-SWAP",
    type: "swap",
    base: "BTC",
    quote: "USDT",
    settle: "USDT",
    active: true,
    contract: true,
    linear: true,
    contractSize: toCanonical("1"),
    pricePrecision: 1,
    amountPrecision: 3,
    priceStep: toCanonical("0.1"),
    amountStep: toCanonical("0.001"),
    minAmount: toCanonical("0.001"),
    minNotional: toCanonical("5"),
    raw: { source: "fake-okx" },
  };
}
