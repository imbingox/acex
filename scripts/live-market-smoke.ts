import {
  type AcexInternalError,
  createClient,
  type FundingRateUpdatedEvent,
  type L1BookUpdatedEvent,
} from "../index.ts";

interface CliOptions {
  spotSymbol?: string;
  perpSymbol?: string;
  durationSec: number;
  disconnectAfterSec?: number;
  disconnectTarget: "spot" | "perp" | "funding";
  reconnectWaitSec: number;
}

interface ErrorSummary {
  source: AcexInternalError["source"];
  venue?: string;
  symbol?: string;
  accountId?: string;
  message: string;
  ts: number;
}

interface ReconnectSummary {
  forcedDisconnectAt: string;
  versionBeforeDisconnect: number;
  staleStatus: Record<string, unknown>;
  reconnectedSocketUrl: string;
  recoveredStatus: Record<string, unknown>;
  recoveredVersion: number;
}

interface SmokeResult {
  symbol: string;
  subscribeLatencyMs: number;
  socketUrl: string;
  initialBook: Record<string, unknown>;
  firstEvent: Record<string, unknown>;
  updateCountAfterFirstEvent: number;
  ignoredOutdatedEvents: number;
  lastObservedVersion: number;
  statusAfterSubscribe: Record<string, unknown>;
  statusAfterUnsubscribe: Record<string, unknown>;
  reconnect?: ReconnectSummary;
}

interface FundingSmokeResult {
  symbol: string;
  subscribeLatencyMs: number;
  socketUrl: string;
  initialFundingRate: Record<string, unknown>;
  firstEvent: Record<string, unknown>;
  updateCountAfterFirstEvent: number;
  ignoredOutdatedEvents: number;
  lastObservedVersion: number;
  statusAfterSubscribe: Record<string, unknown>;
  statusAfterUnsubscribe: Record<string, unknown>;
  reconnect?: ReconnectSummary;
}

const DEFAULT_SPOT_SYMBOL = "BTC/USDT";
const DEFAULT_PERP_SYMBOL = "BTC/USDT:USDT";
const DEFAULT_DURATION_SEC = 10;
const DEFAULT_RECONNECT_WAIT_SEC = 10;
const FUNDING_SUBSCRIBE_ATTEMPTS = 3;
const SOCKET_POLL_INTERVAL_MS = 25;
const STATE_POLL_INTERVAL_MS = 50;
const originalWebSocket = globalThis.WebSocket;
const NativeWebSocket = originalWebSocket;

function printHelp(): void {
  writeStdout(`Usage:
  bun run test:live:market -- [options]

Options:
  --spot-symbol <symbol>         Spot symbol to test (default: ${DEFAULT_SPOT_SYMBOL})
  --perp-symbol <symbol>         Perp symbol to test (default: ${DEFAULT_PERP_SYMBOL})
  --duration <seconds>           Total soak duration per symbol (default: ${DEFAULT_DURATION_SEC})
  --disconnect-after <seconds>   Force-close one websocket after N seconds and verify reconnect
  --disconnect-target <spot|perp|funding>
                                 Which symbol run should trigger the forced disconnect (default: perp)
  --reconnect-wait <seconds>     Max reconnect recovery wait (default: ${DEFAULT_RECONNECT_WAIT_SEC})
  --help                         Show this help

Example:
  bun run test:live:market -- --duration 60 --disconnect-after 5 --disconnect-target perp`);
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    spotSymbol: DEFAULT_SPOT_SYMBOL,
    perpSymbol: DEFAULT_PERP_SYMBOL,
    durationSec: DEFAULT_DURATION_SEC,
    disconnectTarget: "perp",
    reconnectWaitSec: DEFAULT_RECONNECT_WAIT_SEC,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "--spot-symbol":
        options.spotSymbol = argv[++index];
        break;
      case "--perp-symbol":
        options.perpSymbol = argv[++index];
        break;
      case "--duration":
        options.durationSec = parseNumber(argv[++index] ?? "", "--duration");
        break;
      case "--disconnect-after":
        options.disconnectAfterSec = parseNumber(
          argv[++index] ?? "",
          "--disconnect-after",
        );
        break;
      case "--disconnect-target": {
        const target = argv[++index];
        if (target !== "spot" && target !== "perp" && target !== "funding") {
          throw new Error(
            `Invalid value for --disconnect-target: ${target ?? ""}`,
          );
        }
        options.disconnectTarget = target;
        break;
      }
      case "--reconnect-wait":
        options.reconnectWaitSec = parseNumber(
          argv[++index] ?? "",
          "--reconnect-wait",
        );
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const result = (await Promise.race([
    iterator.next(),
    sleep(timeoutMs).then(() => {
      throw new Error(label);
    }),
  ])) as IteratorResult<T>;

  if (result.done) {
    throw new Error(`${label}: stream closed`);
  }

  return result.value;
}

async function waitForCondition<T>(
  check: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const current = check();
    if (current !== undefined) {
      return current;
    }

    await sleep(STATE_POLL_INTERVAL_MS);
  }

  throw new Error(label);
}

class TrackedWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static readonly instances: TrackedWebSocket[] = [];

  readonly url: string;
  readonly createdAt = Date.now();
  messageCount = 0;
  lastMessageAt?: number;
  lastMessagePreview?: string;

  private readonly socket: WebSocket;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.socket =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    TrackedWebSocket.instances.push(this);

    this.socket.addEventListener("open", () => {
      this.dispatchEvent(new Event("open"));
    });

    this.socket.addEventListener("message", (event) => {
      this.messageCount += 1;
      this.lastMessageAt = Date.now();
      this.lastMessagePreview = String(event.data).slice(0, 240);
      this.dispatchEvent(
        new MessageEvent("message", {
          data: event.data,
        }),
      );
    });

    this.socket.addEventListener("error", () => {
      this.dispatchEvent(new Event("error"));
    });

    this.socket.addEventListener("close", (event) => {
      this.dispatchEvent(
        new CloseEvent("close", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        }),
      );
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(
    data: string | ArrayBufferLike | Bun.ArrayBufferView<ArrayBufferLike>,
  ): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  forceClose(reason = "script disconnect"): void {
    this.socket.close(1000, reason);
  }
}

function summarizeSocket(socket: TrackedWebSocket): Record<string, unknown> {
  return {
    url: socket.url,
    readyState: socket.readyState,
    createdAt: socket.createdAt,
    messageCount: socket.messageCount,
    lastMessageAt: socket.lastMessageAt,
    lastMessagePreview: socket.lastMessagePreview,
  };
}

function summarizeError(error: AcexInternalError): ErrorSummary {
  return {
    source: error.source,
    venue: error.venue,
    symbol: error.symbol,
    accountId: error.accountId,
    message: error.error.message,
    ts: error.ts,
  };
}

function cloneStatus(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? { ...(value as Record<string, unknown>) }
    : {};
}

async function waitForTrackedSocket(
  index: number,
  timeoutMs: number,
  label: string,
): Promise<TrackedWebSocket> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const socket = TrackedWebSocket.instances[index];
    if (socket) {
      return socket;
    }

    await sleep(SOCKET_POLL_INTERVAL_MS);
  }

  throw new Error(label);
}

async function collectEventsUntil(
  iterator: AsyncIterator<L1BookUpdatedEvent>,
  deadlineMs: number,
  startingVersion: number,
): Promise<{ count: number; ignoredCount: number; lastVersion: number }> {
  return collectVersionedEventsUntil(
    iterator,
    deadlineMs,
    startingVersion,
    "L1 update stream closed unexpectedly",
  );
}

async function collectFundingEventsUntil(
  iterator: AsyncIterator<FundingRateUpdatedEvent>,
  deadlineMs: number,
  startingVersion: number,
): Promise<{ count: number; ignoredCount: number; lastVersion: number }> {
  return collectVersionedEventsUntil(
    iterator,
    deadlineMs,
    startingVersion,
    "Funding update stream closed unexpectedly",
  );
}

async function collectVersionedEventsUntil<
  TEvent extends { snapshot: { version: number } },
>(
  iterator: AsyncIterator<TEvent>,
  deadlineMs: number,
  startingVersion: number,
  closedMessage: string,
): Promise<{ count: number; ignoredCount: number; lastVersion: number }> {
  let count = 0;
  let ignoredCount = 0;
  let lastVersion = startingVersion;

  while (Date.now() < deadlineMs) {
    const remainingMs = Math.max(deadlineMs - Date.now(), 0);
    const result = await Promise.race([
      iterator.next(),
      sleep(Math.min(remainingMs, 1_000)).then(() => undefined),
    ]);

    if (!result) {
      continue;
    }

    if (result.done) {
      throw new Error(closedMessage);
    }

    if (result.value.snapshot.version <= lastVersion) {
      ignoredCount += 1;
      continue;
    }

    count += 1;
    lastVersion = result.value.snapshot.version;
  }

  return { count, ignoredCount, lastVersion };
}

async function smokeSymbol(options: {
  client: ReturnType<typeof createClient>;
  symbol: string;
  durationMs: number;
  disconnectAfterMs?: number;
  reconnectWaitMs: number;
}): Promise<SmokeResult> {
  const key = {
    venue: "binance" as const,
    symbol: options.symbol,
  };
  const iterator = options.client.market.events
    .l1BookUpdates(key)
    [Symbol.asyncIterator]();
  const socketIndex = TrackedWebSocket.instances.length;

  try {
    const subscribeStartedAt = Date.now();
    await options.client.market.subscribeL1Book(key);
    const subscribeLatencyMs = Date.now() - subscribeStartedAt;

    const socket = await waitForTrackedSocket(
      socketIndex,
      5_000,
      `Timed out waiting for tracked websocket for ${options.symbol}`,
    );
    const initialBook = options.client.market.getL1Book(key);
    const statusAfterSubscribe = options.client.market.getMarketStatus(key);
    if (!initialBook || !statusAfterSubscribe) {
      throw new Error(`Missing initial snapshot for ${options.symbol}`);
    }

    const firstEvent = await nextEvent(
      iterator,
      5_000,
      `Timed out waiting for first L1 event for ${options.symbol}`,
    );

    let updateCountAfterFirstEvent = 0;
    let ignoredOutdatedEvents = 0;
    let lastObservedVersion = firstEvent.snapshot.version;
    let reconnect: ReconnectSummary | undefined;
    const startedAt = Date.now();
    const disconnectAt =
      options.disconnectAfterMs === undefined
        ? undefined
        : startedAt + options.disconnectAfterMs;
    const deadline = startedAt + options.durationMs;

    if (disconnectAt !== undefined) {
      const preDisconnect = await collectEventsUntil(
        iterator,
        Math.min(disconnectAt, deadline),
        lastObservedVersion,
      );
      updateCountAfterFirstEvent += preDisconnect.count;
      ignoredOutdatedEvents += preDisconnect.ignoredCount;
      lastObservedVersion = preDisconnect.lastVersion;

      const versionBeforeDisconnect =
        options.client.market.getL1Book(key)?.version ?? lastObservedVersion;
      socket.forceClose();

      const staleStatus = await waitForCondition(
        () => {
          const current = options.client.market.getMarketStatus(key);
          if (current?.reason === "ws_disconnected") {
            return cloneStatus(current);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        `Timed out waiting for ws_disconnected for ${options.symbol}`,
      );

      const reconnectedSocket = await waitForTrackedSocket(
        socketIndex + 1,
        options.reconnectWaitMs,
        `Timed out waiting for reconnected websocket for ${options.symbol}`,
      );

      const recoveredStatus = await waitForCondition(
        () => {
          const currentStatus = options.client.market.getMarketStatus(key);
          const currentBook = options.client.market.getL1Book(key);
          if (
            currentStatus?.freshness === "fresh" &&
            currentBook &&
            currentBook.version > versionBeforeDisconnect
          ) {
            return cloneStatus(currentStatus);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        `Timed out waiting for reconnect recovery for ${options.symbol}`,
      );

      const recoveredVersion =
        options.client.market.getL1Book(key)?.version ??
        versionBeforeDisconnect;

      reconnect = {
        forcedDisconnectAt: new Date().toISOString(),
        versionBeforeDisconnect,
        staleStatus,
        reconnectedSocketUrl: reconnectedSocket.url,
        recoveredStatus,
        recoveredVersion,
      };

      if (deadline > Date.now()) {
        const postReconnect = await collectEventsUntil(
          iterator,
          deadline,
          recoveredVersion,
        );
        updateCountAfterFirstEvent += postReconnect.count;
        ignoredOutdatedEvents += postReconnect.ignoredCount;
        lastObservedVersion = postReconnect.lastVersion;
      } else {
        lastObservedVersion = recoveredVersion;
      }
    } else {
      const soak = await collectEventsUntil(
        iterator,
        deadline,
        lastObservedVersion,
      );
      updateCountAfterFirstEvent += soak.count;
      ignoredOutdatedEvents += soak.ignoredCount;
      lastObservedVersion = soak.lastVersion;
    }

    await options.client.market.unsubscribeL1Book(key);
    const statusAfterUnsubscribe = options.client.market.getMarketStatus(key);
    if (!statusAfterUnsubscribe) {
      throw new Error(`Missing status after unsubscribe for ${options.symbol}`);
    }

    return {
      symbol: options.symbol,
      subscribeLatencyMs,
      socketUrl: socket.url,
      initialBook: {
        bidPrice: initialBook.bidPrice,
        bidSize: initialBook.bidSize,
        askPrice: initialBook.askPrice,
        askSize: initialBook.askSize,
        version: initialBook.version,
        exchangeTs: initialBook.exchangeTs,
        receivedAt: initialBook.receivedAt,
      },
      firstEvent: {
        bidPrice: firstEvent.snapshot.bidPrice,
        askPrice: firstEvent.snapshot.askPrice,
        version: firstEvent.snapshot.version,
        ts: firstEvent.ts,
      },
      updateCountAfterFirstEvent,
      ignoredOutdatedEvents,
      lastObservedVersion,
      statusAfterSubscribe: cloneStatus(statusAfterSubscribe),
      statusAfterUnsubscribe: cloneStatus(statusAfterUnsubscribe),
      reconnect,
    };
  } finally {
    await iterator.return?.();
  }
}

async function smokeFundingRate(options: {
  client: ReturnType<typeof createClient>;
  symbol: string;
  durationMs: number;
  disconnectAfterMs?: number;
  reconnectWaitMs: number;
}): Promise<FundingSmokeResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= FUNDING_SUBSCRIBE_ATTEMPTS; attempt += 1) {
    try {
      return await smokeFundingRateAttempt({ ...options, attempt });
    } catch (error) {
      lastError = error;
      if (attempt === FUNDING_SUBSCRIBE_ATTEMPTS) {
        break;
      }
      await sleep(500 * attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Unknown funding smoke failure"));
}

async function smokeFundingRateAttempt(options: {
  client: ReturnType<typeof createClient>;
  symbol: string;
  durationMs: number;
  disconnectAfterMs?: number;
  reconnectWaitMs: number;
  attempt: number;
}): Promise<FundingSmokeResult> {
  const key = {
    venue: "binance" as const,
    symbol: options.symbol,
  };
  const iterator = options.client.market.events
    .fundingRateUpdates(key)
    [Symbol.asyncIterator]();
  const socketIndex = TrackedWebSocket.instances.length;

  try {
    const subscribeStartedAt = Date.now();
    const subscribePromise = options.client.market.subscribeFundingRate(key);
    const socket = await waitForTrackedSocket(
      socketIndex,
      5_000,
      `Timed out waiting for tracked funding websocket for ${options.symbol}`,
    );
    try {
      await subscribePromise;
    } catch (error) {
      throw new Error(
        `Funding subscription failed for ${options.symbol}: ${
          error instanceof Error ? error.message : String(error)
        }; attempt=${options.attempt}/${FUNDING_SUBSCRIBE_ATTEMPTS}; socket=${JSON.stringify(
          summarizeSocket(socket),
        )}`,
        { cause: error },
      );
    }
    const subscribeLatencyMs = Date.now() - subscribeStartedAt;

    const initialFundingRate = options.client.market.getFundingRate(key);
    const statusAfterSubscribe = options.client.market.getMarketStatus(key);
    if (!initialFundingRate || !statusAfterSubscribe) {
      throw new Error(`Missing initial funding snapshot for ${options.symbol}`);
    }

    const firstEvent = await nextEvent(
      iterator,
      5_000,
      `Timed out waiting for first funding event for ${options.symbol}`,
    );

    let updateCountAfterFirstEvent = 0;
    let ignoredOutdatedEvents = 0;
    let lastObservedVersion = firstEvent.snapshot.version;
    let reconnect: ReconnectSummary | undefined;
    const startedAt = Date.now();
    const disconnectAt =
      options.disconnectAfterMs === undefined
        ? undefined
        : startedAt + options.disconnectAfterMs;
    const deadline = startedAt + options.durationMs;

    if (disconnectAt !== undefined) {
      const preDisconnect = await collectFundingEventsUntil(
        iterator,
        Math.min(disconnectAt, deadline),
        lastObservedVersion,
      );
      updateCountAfterFirstEvent += preDisconnect.count;
      ignoredOutdatedEvents += preDisconnect.ignoredCount;
      lastObservedVersion = preDisconnect.lastVersion;

      const versionBeforeDisconnect =
        options.client.market.getFundingRate(key)?.version ??
        lastObservedVersion;
      socket.forceClose();

      const staleStatus = await waitForCondition(
        () => {
          const current = options.client.market.getFundingRate(key)?.status;
          if (current?.reason === "ws_disconnected") {
            return cloneStatus(current);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        `Timed out waiting for funding ws_disconnected for ${options.symbol}`,
      );

      const reconnectedSocket = await waitForTrackedSocket(
        socketIndex + 1,
        options.reconnectWaitMs,
        `Timed out waiting for reconnected funding websocket for ${options.symbol}`,
      );

      const recoveredStatus = await waitForCondition(
        () => {
          const currentFundingRate = options.client.market.getFundingRate(key);
          if (
            currentFundingRate?.status.freshness === "fresh" &&
            currentFundingRate.version > versionBeforeDisconnect
          ) {
            return cloneStatus(currentFundingRate.status);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        `Timed out waiting for funding reconnect recovery for ${options.symbol}`,
      );

      const recoveredVersion =
        options.client.market.getFundingRate(key)?.version ??
        versionBeforeDisconnect;

      reconnect = {
        forcedDisconnectAt: new Date().toISOString(),
        versionBeforeDisconnect,
        staleStatus,
        reconnectedSocketUrl: reconnectedSocket.url,
        recoveredStatus,
        recoveredVersion,
      };

      if (deadline > Date.now()) {
        const postReconnect = await collectFundingEventsUntil(
          iterator,
          deadline,
          recoveredVersion,
        );
        updateCountAfterFirstEvent += postReconnect.count;
        ignoredOutdatedEvents += postReconnect.ignoredCount;
        lastObservedVersion = postReconnect.lastVersion;
      } else {
        lastObservedVersion = recoveredVersion;
      }
    } else {
      const soak = await collectFundingEventsUntil(
        iterator,
        deadline,
        lastObservedVersion,
      );
      updateCountAfterFirstEvent += soak.count;
      ignoredOutdatedEvents += soak.ignoredCount;
      lastObservedVersion = soak.lastVersion;
    }

    await options.client.market.unsubscribeFundingRate(key);
    const statusAfterUnsubscribe =
      options.client.market.getFundingRate(key)?.status;
    if (!statusAfterUnsubscribe) {
      throw new Error(
        `Missing funding status after unsubscribe for ${options.symbol}`,
      );
    }

    return {
      symbol: options.symbol,
      subscribeLatencyMs,
      socketUrl: socket.url,
      initialFundingRate: {
        fundingRate: initialFundingRate.fundingRate,
        markPrice: initialFundingRate.markPrice,
        indexPrice: initialFundingRate.indexPrice,
        nextFundingTime: initialFundingRate.nextFundingTime,
        version: initialFundingRate.version,
        exchangeTs: initialFundingRate.exchangeTs,
        receivedAt: initialFundingRate.receivedAt,
        status: cloneStatus(initialFundingRate.status),
      },
      firstEvent: {
        fundingRate: firstEvent.snapshot.fundingRate,
        markPrice: firstEvent.snapshot.markPrice,
        indexPrice: firstEvent.snapshot.indexPrice,
        nextFundingTime: firstEvent.snapshot.nextFundingTime,
        version: firstEvent.snapshot.version,
        ts: firstEvent.ts,
      },
      updateCountAfterFirstEvent,
      ignoredOutdatedEvents,
      lastObservedVersion,
      statusAfterSubscribe: cloneStatus(statusAfterSubscribe),
      statusAfterUnsubscribe: cloneStatus(statusAfterUnsubscribe),
      reconnect,
    };
  } finally {
    await options.client.market.unsubscribeFundingRate(key);
    await iterator.return?.();
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(Bun.argv.slice(2));
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 15_000,
      l1StaleAfterMs: 15_000,
      l1ReconnectDelayMs: 1_000,
      l1ReconnectMaxDelayMs: 3_000,
    },
  });
  const errors: ErrorSummary[] = [];
  const errorIterator = client.events.errors()[Symbol.asyncIterator]();

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: TrackedWebSocket as unknown as typeof WebSocket,
  });

  const errorTask = (async () => {
    while (true) {
      const result = await errorIterator.next();
      if (result.done) {
        return;
      }

      errors.push(summarizeError(result.value));
    }
  })();

  try {
    await client.start();
    await client.market.loadMarkets();

    const markets = client.market.listMarkets("binance");
    const spotMarket = cli.spotSymbol
      ? client.market.getMarket("binance", cli.spotSymbol)
      : undefined;
    const perpMarket = cli.perpSymbol
      ? client.market.getMarket("binance", cli.perpSymbol)
      : undefined;

    const results: SmokeResult[] = [];
    const fundingResults: FundingSmokeResult[] = [];
    const durationMs = cli.durationSec * 1_000;
    const reconnectWaitMs = cli.reconnectWaitSec * 1_000;
    const disconnectAfterMs =
      cli.disconnectAfterSec === undefined
        ? undefined
        : cli.disconnectAfterSec * 1_000;

    if (cli.spotSymbol) {
      results.push(
        await smokeSymbol({
          client,
          symbol: cli.spotSymbol,
          durationMs,
          disconnectAfterMs:
            cli.disconnectTarget === "spot" ? disconnectAfterMs : undefined,
          reconnectWaitMs,
        }),
      );
    }

    if (cli.perpSymbol) {
      fundingResults.push(
        await smokeFundingRate({
          client,
          symbol: cli.perpSymbol,
          durationMs,
          disconnectAfterMs:
            cli.disconnectTarget === "funding" ? disconnectAfterMs : undefined,
          reconnectWaitMs,
        }),
      );

      results.push(
        await smokeSymbol({
          client,
          symbol: cli.perpSymbol,
          durationMs,
          disconnectAfterMs:
            cli.disconnectTarget === "perp" ? disconnectAfterMs : undefined,
          reconnectWaitMs,
        }),
      );
    }

    const summary = {
      checkedAt: new Date().toISOString(),
      options: cli,
      marketCatalog: {
        totalMarkets: markets.length,
        spotSymbol: cli.spotSymbol,
        perpSymbol: cli.perpSymbol,
        spotMarket: spotMarket
          ? {
              type: spotMarket.type,
              active: spotMarket.active,
              priceStep: spotMarket.priceStep,
              amountStep: spotMarket.amountStep,
            }
          : null,
        perpMarket: perpMarket
          ? {
              type: perpMarket.type,
              active: perpMarket.active,
              settle: perpMarket.settle,
              linear: perpMarket.linear,
              priceStep: perpMarket.priceStep,
              amountStep: perpMarket.amountStep,
            }
          : null,
      },
      results,
      fundingResults,
      errors,
      healthBeforeStop: client.getHealth(),
    };

    writeStdout(JSON.stringify(summary, null, 2));
  } finally {
    await client.stop({ graceful: true, timeoutMs: 5_000 });
    await errorIterator.return?.();
    await errorTask;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  }
}

await main().catch((error: unknown) => {
  writeStderr(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
