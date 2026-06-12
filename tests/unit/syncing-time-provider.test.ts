import { expect, test } from "bun:test";
import { createClient } from "../../src/client/create-client.ts";
import { SyncingTimeProvider } from "../../src/internal/syncing-time-provider.ts";
import type { VenueServerTime } from "../../src/types/index.ts";
import {
  BINANCE_USDM_WS_BASE_URL,
  installBinanceMarketInfra,
  waitForBinanceControlFrame,
} from "../support/exchanges/binance.ts";
import { jsonResponse, waitForSocket } from "../support/test-utils.ts";

const BINANCE_USDM_SERVER_TIME_URL = "https://fapi.binance.com/fapi/v1/time";

function serverTimeSample(estimatedOffsetMs: number): VenueServerTime {
  return {
    serverTime: 0,
    requestSentAt: 0,
    responseReceivedAt: 0,
    roundTripMs: 0,
    estimatedOffsetMs,
  };
}

async function waitForValue<T>(
  read: () => T | undefined,
  timeoutMs = 250,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== undefined) {
      return value;
    }

    await Bun.sleep(1);
  }

  throw new Error("Timed out waiting for value");
}

async function flushPromises(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

class ManualTimers {
  private currentTimeMs = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    {
      readonly dueAtMs: number;
      readonly handler: Parameters<typeof setTimeout>[0];
      readonly args: unknown[];
    }
  >();

  readonly setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, {
      dueAtMs: this.currentTimeMs + (Number(timeout) || 0),
      handler,
      args,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  readonly clearTimeout = ((
    handle: Parameters<typeof clearTimeout>[0],
  ): void => {
    this.timers.delete(handle as unknown as number);
  }) as typeof clearTimeout;

  advanceBy(ms: number): void {
    this.currentTimeMs += ms;

    while (true) {
      const dueTimer = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAtMs <= this.currentTimeMs)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAtMs - right.dueAtMs || leftId - rightId,
        )[0];

      if (!dueTimer) {
        return;
      }

      const [id, timer] = dueTimer;
      this.timers.delete(id);
      if (typeof timer.handler === "function") {
        timer.handler(...timer.args);
      }
    }
  }
}

test("SyncingTimeProvider startup samples converge to the median offset", async () => {
  const offsets = [1_200, 500, 900, 500, 20_000];
  const provider = new SyncingTimeProvider({
    sample: async () => serverTimeSample(offsets.shift() ?? 0),
    now: () => 10_000,
    resyncIntervalMs: 60_000,
  });

  try {
    await provider.start();

    expect(provider.now()).toBe(10_900);
  } finally {
    provider.stop();
  }
});

test("SyncingTimeProvider now rounds fractional offsets to integer milliseconds", async () => {
  const provider = new SyncingTimeProvider({
    sample: async () => serverTimeSample(1_000.5),
    now: () => 10_000,
    startupSamples: 1,
    resyncIntervalMs: 60_000,
  });

  try {
    await provider.start();

    expect(Number.isInteger(provider.now())).toBe(true);
    expect(provider.now()).toBe(11_001);
  } finally {
    provider.stop();
  }
});

test("SyncingTimeProvider requestResync resamples immediately and debounces duplicate signals", async () => {
  let sampleCalls = 0;
  const provider = new SyncingTimeProvider({
    sample: async () => {
      sampleCalls += 1;
      return serverTimeSample(sampleCalls === 1 ? 0 : 1_500);
    },
    now: () => 10_000,
    startupSamples: 1,
    resyncIntervalMs: 60_000,
  });

  try {
    await provider.start();

    provider.requestResync();
    provider.requestResync();
    provider.requestResync();

    await waitForValue(() => (sampleCalls === 2 ? true : undefined));
    await Bun.sleep(25);

    expect(sampleCalls).toBe(2);
    expect(provider.now()).toBe(11_500);
  } finally {
    provider.stop();
  }
});

test("SyncingTimeProvider requestResync pushes the next periodic resync by a full interval", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new ManualTimers();
  let sampleCalls = 0;

  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: timers.setTimeout,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: timers.clearTimeout,
  });

  const provider = new SyncingTimeProvider({
    sample: async () => {
      sampleCalls += 1;
      return serverTimeSample(0);
    },
    now: () => 10_000,
    startupSamples: 1,
    resyncIntervalMs: 100,
  });

  try {
    await provider.start();
    expect(sampleCalls).toBe(1);

    timers.advanceBy(90);
    provider.requestResync();
    await flushPromises();

    expect(sampleCalls).toBe(2);

    timers.advanceBy(10);
    await flushPromises();

    expect(sampleCalls).toBe(2);

    timers.advanceBy(90);
    await flushPromises();

    expect(sampleCalls).toBe(3);
  } finally {
    provider.stop();
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: originalSetTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: originalClearTimeout,
    });
  }
});

test("SyncingTimeProvider keeps the previous offset when requested resync sampling fails", async () => {
  const failures: unknown[] = [];
  let failNextSample = false;
  const provider = new SyncingTimeProvider({
    sample: async () => {
      if (failNextSample) {
        throw new Error("server-time unavailable");
      }

      return serverTimeSample(1_000);
    },
    now: () => 10_000,
    startupSamples: 1,
    resyncIntervalMs: 60_000,
    onSampleFailed: (event) => failures.push(event),
  });

  try {
    await provider.start();
    expect(provider.now()).toBe(11_000);

    failNextSample = true;
    provider.requestResync();

    await waitForValue(() => (failures.length === 1 ? true : undefined));

    expect(provider.now()).toBe(11_000);
    expect(failures).toHaveLength(1);
  } finally {
    provider.stop();
  }
});

test("SyncingTimeProvider warns on large drift and still adopts the requested offset", async () => {
  const offsets = [0, 3_000];
  const warnings: unknown[] = [];
  const provider = new SyncingTimeProvider({
    sample: async () => serverTimeSample(offsets.shift() ?? 0),
    now: () => 10_000,
    startupSamples: 1,
    resyncIntervalMs: 60_000,
    recvWindowMs: 5_000,
    onDriftWarning: (event) => warnings.push(event),
  });

  try {
    await provider.start();

    provider.requestResync();

    await waitForValue(() => (warnings.length === 1 ? true : undefined));

    expect(provider.now()).toBe(13_000);
    expect(warnings).toHaveLength(1);
  } finally {
    provider.stop();
  }
});

test("AcexClientImpl skips automatic signing clock sync when options.clock is injected", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let fetchCalls = 0;
  let timerCalls = 0;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      fetchCalls += 1;
      return jsonResponse({ serverTime: Date.now() });
    },
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: ((...args: Parameters<typeof setTimeout>) => {
      timerCalls += 1;
      return originalSetTimeout(...args);
    }) as typeof setTimeout,
  });

  try {
    const client = createClient({
      clock: {
        now: () => 123,
      },
    });

    await client.start();
    await client.stop();

    expect(fetchCalls).toBe(0);
    expect(timerCalls).toBe(0);
  } finally {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: originalSetTimeout,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

test("signing clock offset does not change market freshness receivedAt", async () => {
  installBinanceMarketInfra();
  const installedFetch = globalThis.fetch;
  let serverTimeCalls = 0;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === BINANCE_USDM_SERVER_TIME_URL) {
        serverTimeCalls += 1;
        return jsonResponse({ serverTime: Date.now() + 10_000 });
      }

      return await installedFetch(input, init);
    },
  });

  const client = createClient();

  try {
    await client.start();
    await waitForValue(() => (serverTimeCalls >= 5 ? true : undefined));

    const beforeSubscribe = Date.now();
    const subscribePromise = client.market.subscribeL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    });

    const socket = await waitForSocket(BINANCE_USDM_WS_BASE_URL, 0);
    await waitForBinanceControlFrame(socket, "SUBSCRIBE", [
      "btcusdt@bookTicker",
    ]);
    socket.emitJson({
      s: "BTCUSDT",
      b: "102000.10",
      B: "1.500",
      a: "102000.20",
      A: "2.500",
      T: 1710000000000,
    });

    await subscribePromise;
    const afterSubscribe = Date.now();
    const book = client.market.getL1Book({
      venue: "binance",
      symbol: "BTC/USDT:USDT",
    });

    expect(book).toBeDefined();
    if (!book) {
      throw new Error("Expected l1 book snapshot");
    }

    expect(book.receivedAt).toBeGreaterThanOrEqual(beforeSubscribe);
    expect(book.receivedAt).toBeLessThanOrEqual(afterSubscribe);
  } finally {
    await client.stop();
  }
});
