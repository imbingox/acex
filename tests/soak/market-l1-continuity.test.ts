import { expect, test } from "bun:test";
import { createClient } from "../../index.ts";
import {
  BINANCE_USDM_WS_BASE_URL,
  installBinanceMarketInfra,
  waitForBinanceControlFrame,
} from "../support/exchanges/binance.ts";
import {
  type FakeWebSocket,
  nextEvent,
  waitForSocket,
} from "../support/test-utils.ts";

interface ContinuousBookTickerFeed {
  readonly done: Promise<number>;
  readonly totalTicks: number;
  stop(): void;
}

function startContinuousBookTickerFeed(
  socket: FakeWebSocket,
  options: {
    durationMs: number;
    intervalMs: number;
    startPrice: number;
  },
): ContinuousBookTickerFeed {
  const totalTicks = Math.floor(options.durationMs / options.intervalMs) + 1;
  let ticks = 0;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let resolveDone: ((ticks: number) => void) | undefined;

  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const stop = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }

    resolveDone?.(ticks);
    resolveDone = undefined;
  };

  const emit = () => {
    if (stopped) {
      return;
    }

    ticks += 1;
    const price = options.startPrice + ticks;
    socket.emitJson({
      s: "BTCUSDT",
      b: `${price}.10`,
      B: `1.${`${ticks}`.padStart(3, "0")}`,
      a: `${price}.20`,
      A: `2.${`${ticks}`.padStart(3, "0")}`,
      T: 1710000000000 + ticks * options.intervalMs,
    });

    if (ticks >= totalTicks) {
      stop();
    }
  };

  emit();
  interval = setInterval(emit, options.intervalMs);

  return {
    done,
    totalTicks,
    stop,
  };
}

test("caller can observe l1 book keep changing for one minute", async () => {
  installBinanceMarketInfra();
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 1_000,
      l1StaleAfterMs: 5_000,
    },
  });
  const iterator = client.market.events
    .l1BookUpdates({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    })
    [Symbol.asyncIterator]();

  await client.start();
  const subscribePromise = client.market.subscribeL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0, 1_000);
  await waitForBinanceControlFrame(socket, "SUBSCRIBE", ["btcusdt@bookTicker"]);
  const feed = startContinuousBookTickerFeed(socket, {
    durationMs: 60_000,
    intervalMs: 1_000,
    startPrice: 102000,
  });

  try {
    await subscribePromise;

    let eventCount = 0;
    let firstBidPrice: string | undefined;
    let lastBidPrice: string | undefined;
    let previousVersion = 0;

    while (eventCount < feed.totalTicks) {
      const event = await nextEvent(iterator, 5_000);
      eventCount += 1;

      if (eventCount === 1) {
        firstBidPrice = event.snapshot.bidPrice;
        expect(event.snapshot.version).toBe(1);
      } else {
        expect(event.snapshot.version).toBe(previousVersion + 1);
      }

      previousVersion = event.snapshot.version;
      lastBidPrice = event.snapshot.bidPrice;
    }

    const emittedTicks = await feed.done;
    const finalBook = client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    });
    const finalStatus = client.market.getMarketStatus({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    });

    expect(emittedTicks).toBe(feed.totalTicks);
    expect(eventCount).toBe(feed.totalTicks);
    expect(previousVersion).toBe(feed.totalTicks);
    expect(firstBidPrice).not.toBe(lastBidPrice);
    expect(finalBook).toMatchObject({
      version: feed.totalTicks,
      bidPrice: lastBidPrice,
    });
    expect(finalStatus).toMatchObject({
      ready: true,
      activity: "active",
      freshness: "fresh",
    });
  } finally {
    feed.stop();
    await feed.done;
    await iterator.return?.();
  }
}, 75_000);
