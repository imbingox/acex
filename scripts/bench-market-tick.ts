import type {
  FundingRateStreamCallbacks,
  FundingRateStreamOptions,
  L1BookStreamCallbacks,
  L1BookStreamOptions,
  MarketAdapter,
  RawOrderUpdate,
  RawSymbolFeeRate,
  StreamHandle,
} from "../src/adapters/types.ts";
import type { ClientContext } from "../src/client/context.ts";
import type { VenueErrorReason } from "../src/errors.ts";
import { MarketManagerImpl } from "../src/managers/market-manager.ts";
import type {
  CancelAllOrdersInput,
  CancelOrderInput,
  CreateOrderInput,
  GetSymbolFeeRateInput,
  HealthEvent,
  MarketDefinition,
  Venue,
  VenueOrderCapabilities,
} from "../src/types/index.ts";

const TICKS = Number(process.argv[2] ?? "200000");
const SYMBOL = "BTC/USDT:USDT";

const MARKET = {
  venue: "binance",
  symbol: SYMBOL,
  id: "BTCUSDT",
  type: "swap",
  base: "BTC",
  quote: "USDT",
  settle: "USDT",
  active: true,
  contract: true,
  linear: true,
  contractSize: "1",
  pricePrecision: 1,
  amountPrecision: 3,
  priceStep: "0.1",
  amountStep: "0.001",
  minAmount: "0.001",
  minNotional: "5",
  raw: {},
} satisfies MarketDefinition;

class BenchMarketAdapter implements MarketAdapter {
  readonly venue = "binance" as const;
  readonly marketCapabilities = {
    catalog: "supported",
    serverTime: "unsupported",
    l1Book: "supported",
    fundingRate: "unsupported",
    marketTypes: ["swap"],
  } satisfies MarketAdapter["marketCapabilities"];

  l1Callbacks: L1BookStreamCallbacks | undefined;

  async loadMarkets(): Promise<MarketDefinition[]> {
    return [MARKET];
  }

  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle {
    void market;
    void options;
    this.l1Callbacks = callbacks;
    return {
      ready: Promise.resolve(),
      close() {},
    };
  }

  createFundingRateStream(
    market: MarketDefinition,
    callbacks: FundingRateStreamCallbacks,
    options: FundingRateStreamOptions,
  ): StreamHandle {
    void market;
    void callbacks;
    void options;
    throw new Error("funding rate stream is not used by this benchmark");
  }
}

function notUsed(name: string): never {
  throw new Error(`${name} is not used by this benchmark`);
}

function createContext(nowRef: { value: number }): ClientContext {
  return {
    metricsEnabled: false,
    now(): number {
      return nowRef.value;
    },
    assertStarted(): void {},
    getRegisteredAccount() {
      return notUsed("getRegisteredAccount");
    },
    getPrivateOrderCapabilities(
      venue: Venue,
    ): VenueOrderCapabilities | undefined {
      void venue;
      return undefined;
    },
    normalizeVenueErrorCode(
      venue: Venue,
      code: string,
    ): VenueErrorReason | undefined {
      void venue;
      void code;
      return undefined;
    },
    ensurePrivateCredentials(accountId: string): void {
      void accountId;
    },
    async subscribePrivateAccountFeed(accountId: string): Promise<void> {
      void accountId;
    },
    unsubscribePrivateAccountFeed(accountId: string): void {
      void accountId;
    },
    async subscribePrivateOrderFeed(accountId: string): Promise<void> {
      void accountId;
    },
    unsubscribePrivateOrderFeed(accountId: string): void {
      void accountId;
    },
    async createOrder(input: CreateOrderInput): Promise<RawOrderUpdate> {
      void input;
      return notUsed("createOrder");
    },
    async cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate> {
      void input;
      return notUsed("cancelOrder");
    },
    async cancelAllOrders(
      input: CancelAllOrdersInput,
    ): Promise<RawOrderUpdate[]> {
      void input;
      return notUsed("cancelAllOrders");
    },
    async fetchSymbolFeeRate(
      input: GetSymbolFeeRateInput,
    ): Promise<RawSymbolFeeRate> {
      void input;
      return notUsed("fetchSymbolFeeRate");
    },
    publishRuntimeError(): void {},
    publishHealthEvent(event: HealthEvent): void {
      void event;
    },
    emitMetric(): void {},
  };
}

function maybeGc(): void {
  // Guard the `Bun` global itself: `typeof Bun.gc` would evaluate `Bun` first
  // and throw ReferenceError under non-Bun runtimes (Node, etc.). This bench is
  // Bun-only, but the guard keeps it a safe no-op anywhere.
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true);
  }
}

function decimal(base: number, index: number): string {
  return `${base + (index % 1_000)}.${(index % 9) + 1}`;
}

async function main(): Promise<void> {
  const nowRef = { value: 0 };
  const adapter = new BenchMarketAdapter();
  const manager = new MarketManagerImpl(
    createContext(nowRef),
    new Map<Venue, MarketAdapter>([["binance", adapter]]),
  );

  await manager.subscribeL1Book({ venue: "binance", symbol: SYMBOL });
  const callbacks = adapter.l1Callbacks;
  if (!callbacks) {
    throw new Error("L1 callbacks were not registered");
  }

  maybeGc();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  for (let index = 0; index < TICKS; index += 1) {
    nowRef.value = index + 1;
    callbacks.onUpdate({
      bidPrice: decimal(60_000, index),
      bidSize: `0.${(index % 9) + 1}`,
      askPrice: decimal(60_001, index),
      askSize: `0.${((index + 3) % 9) + 1}`,
      exchangeTs: nowRef.value,
      receivedAt: nowRef.value,
    });

    const snapshot = manager.getL1Book({ venue: "binance", symbol: SYMBOL });
    if (!snapshot || snapshot.version !== index + 1) {
      throw new Error(`unexpected snapshot version at tick ${index}`);
    }
  }

  const durationMs = performance.now() - startedAt;
  const heapAfter = process.memoryUsage().heapUsed;
  maybeGc();
  const heapAfterGc = process.memoryUsage().heapUsed;
  const heapDeltaBytes = heapAfter - heapBefore;
  const retainedHeapDeltaBytes = heapAfterGc - heapBefore;

  process.stdout.write(
    `${JSON.stringify(
      {
        ticks: TICKS,
        durationMs: Number(durationMs.toFixed(2)),
        opsPerSec: Math.round((TICKS / durationMs) * 1_000),
        heapDeltaBytes,
        bytesPerTick: Number((heapDeltaBytes / TICKS).toFixed(2)),
        retainedHeapDeltaBytes,
        retainedBytesPerTick: Number(
          (retainedHeapDeltaBytes / TICKS).toFixed(2),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

await main();
