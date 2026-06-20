import { createHmac } from "node:crypto";
import {
  BigNumber,
  createClient,
  type MarketSubscriptionLease,
  type OrderEvent,
  type OrderSnapshot,
  type OrderTradeEvent,
} from "../index.ts";
import {
  cloneStatus,
  collectEventsUntil,
  type ErrorSummary,
  installTrackedWebSocket,
  nextEvent,
  parseNumber,
  requireEnv,
  restoreTrackedWebSocket,
  summarizeError,
  TrackedWebSocket,
  waitForCondition,
  waitForTrackedSocket,
  writeStderr,
  writeStdout,
} from "./live-private-smoke-shared.ts";

interface CliOptions {
  accountId: string;
  symbol: string;
  durationSec: number;
  disconnectAfterSec?: number;
  expireListenKeyAfterSec?: number;
  reconnectWaitSec: number;
  showOrders: boolean;
  cancelAll: boolean;
  positionSide?: OrderSnapshot["positionSide"];
}

interface OrderEventSummary {
  type: OrderEvent["type"];
  orderCount?: number;
  symbols?: string[];
  symbol?: string;
  orderId?: string;
  clientOrderId?: string;
  status?: OrderSnapshot["status"];
  ts: number;
}

interface OpenOrderSummary {
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSnapshot["side"];
  type: string;
  status: OrderSnapshot["status"];
  price?: string;
  triggerPrice?: string;
  amount: string;
  filled: string;
  remaining?: string;
  reduceOnly?: boolean;
  positionSide?: OrderSnapshot["positionSide"];
  avgFillPrice?: string;
  exchangeTs?: number;
  updatedAt: number;
}

interface OpenOrdersSnapshot {
  count: number;
  symbols: string[];
  orderIds: string[];
  orders?: OpenOrderSummary[];
}

interface ReconnectSummary {
  forcedDisconnectAt: string;
  staleStatus: Record<string, unknown>;
  reconnectedSocketUrl: string;
  recoveredStatus: Record<string, unknown>;
  recoveredOpenOrderCount: number;
}

interface ListenKeyExpirationSummary {
  expiredAt: string;
  expiredListenKeySuffix: string;
  statusAfterDelete: Record<string, unknown>;
  reconnectedListenKeySuffix: string;
  recoveredStatus: Record<string, unknown>;
  recoveredOpenOrderCount: number;
}

interface CancelAllSummary {
  symbol: string;
  placedOrders: OpenOrderSummary[];
  canceledCount: number;
  canceledOrders: OpenOrderSummary[];
  remainingOpenOrders: OpenOrdersSnapshot;
}

interface SmokeResult {
  accountId: string;
  subscribeLatencyMs: number;
  socketUrl: string;
  statusAfterSubscribe: Record<string, unknown>;
  cachedOpenOrders: OpenOrdersSnapshot;
  firstEvent: OrderEventSummary;
  updateEventsAfterFirstEvent: number;
  reconnect?: ReconnectSummary;
  listenKeyExpiration?: ListenKeyExpirationSummary;
  cancelAll?: CancelAllSummary;
}

const DEFAULT_ACCOUNT_ID = "live-binance";
const DEFAULT_SYMBOL = "BTC/USDT:USDT";
const DEFAULT_DURATION_SEC = 10;
const DEFAULT_RECONNECT_WAIT_SEC = 10;
const CANCEL_ALL_TEST_ORDER_COUNT = 2;
const BINANCE_PAPI_REST_BASE_URL = "https://papi.binance.com";
const DEFAULT_RECV_WINDOW = "5000";
const DELETE_LISTEN_KEY_TIMEOUT_MS = 10_000;
const LISTEN_KEY_SUMMARY_SUFFIX_LENGTH = 6;

function signQuery(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

function extractListenKey(socketUrl: string): string {
  const url = new URL(socketUrl);
  const listenKey = url.pathname.split("/").filter(Boolean).at(-1);
  if (!listenKey) {
    throw new Error(`Unable to extract listenKey from websocket URL: ${url}`);
  }

  return listenKey;
}

function listenKeySuffix(listenKey: string): string {
  return listenKey.slice(-LISTEN_KEY_SUMMARY_SUFFIX_LENGTH);
}

function extractListenKeySuffix(socketUrl: string): string {
  return listenKeySuffix(extractListenKey(socketUrl));
}

function isAbortOrTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

async function deleteListenKey(options: {
  apiKey: string;
  secret: string;
  listenKey: string;
}): Promise<void> {
  const params = new URLSearchParams({
    listenKey: options.listenKey,
    timestamp: `${Date.now()}`,
    recvWindow: DEFAULT_RECV_WINDOW,
  });
  params.set("signature", signQuery(params.toString(), options.secret));

  let response: Response;
  try {
    response = await fetch(
      `${BINANCE_PAPI_REST_BASE_URL}/papi/v1/listenKey?${params.toString()}`,
      {
        method: "DELETE",
        headers: {
          "X-MBX-APIKEY": options.apiKey,
        },
        signal: AbortSignal.timeout(DELETE_LISTEN_KEY_TIMEOUT_MS),
      },
    );
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      throw new Error(
        `Timed out deleting Binance PAPI listenKey after ${DELETE_LISTEN_KEY_TIMEOUT_MS}ms`,
        { cause: error },
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to delete listenKey: ${response.status} ${response.statusText} ${await response.text()}`,
    );
  }
}

async function waitForRotatedListenKeySocket(options: {
  previousUrl: string;
  minIndex: number;
  timeoutMs: number;
  label: string;
}): Promise<TrackedWebSocket> {
  return await waitForCondition(
    () =>
      TrackedWebSocket.instances
        .slice(options.minIndex)
        .find((socket) => socket.url !== options.previousUrl),
    options.timeoutMs,
    options.label,
  );
}

function latestTrackedSocket(minIndex: number): TrackedWebSocket | undefined {
  return TrackedWebSocket.instances
    .slice(minIndex)
    .reduce<TrackedWebSocket | undefined>(
      (latest, socket) =>
        !latest || socket.createdAt > latest.createdAt ? socket : latest,
      undefined,
    );
}

function printHelp(): void {
  writeStdout(`Usage:
  bun run test:live:order -- [options]

Environment:
  BINANCE_PAPI_API_KEY      Required Binance PAPI API key
  BINANCE_PAPI_SECRET       Required Binance PAPI secret

Options:
  --account-id <id>          SDK account id (default: ${DEFAULT_ACCOUNT_ID})
  --symbol <symbol>          Symbol for optional cancel-all smoke (default: ${DEFAULT_SYMBOL})
  --duration <seconds>       Total observation duration (default: ${DEFAULT_DURATION_SEC})
  --disconnect-after <sec>   Force-close the private websocket after N seconds and verify reconnect
  --expire-listen-key-after <sec>
                             DELETE the active listenKey after N seconds and verify recovery
  --reconnect-wait <sec>     Max reconnect recovery wait (default: ${DEFAULT_RECONNECT_WAIT_SEC})
  --show-orders              Include cached open-order details in output
  --cancel-all               Place 2 far GTX limit orders, cancel all by symbol, and verify no opens remain
  --position-side <side>     Optional order position side: net, long, or short
  --help                     Show this help

Examples:
  bun run test:live:order -- --duration 10
  bun run test:live:order -- --duration 60 --disconnect-after 5 --show-orders
  bun run test:live:order -- --duration 60 --expire-listen-key-after 5 --show-orders
  bun run test:live:order -- --cancel-all --symbol BTC/USDT:USDT --position-side long`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    accountId: DEFAULT_ACCOUNT_ID,
    symbol: DEFAULT_SYMBOL,
    durationSec: DEFAULT_DURATION_SEC,
    reconnectWaitSec: DEFAULT_RECONNECT_WAIT_SEC,
    showOrders: false,
    cancelAll: false,
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
      case "--account-id":
        options.accountId = argv[++index] ?? "";
        break;
      case "--symbol":
        options.symbol = argv[++index] ?? "";
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
      case "--expire-listen-key-after":
        options.expireListenKeyAfterSec = parseNumber(
          argv[++index] ?? "",
          "--expire-listen-key-after",
        );
        break;
      case "--reconnect-wait":
        options.reconnectWaitSec = parseNumber(
          argv[++index] ?? "",
          "--reconnect-wait",
        );
        break;
      case "--show-orders":
        options.showOrders = true;
        break;
      case "--cancel-all":
        options.cancelAll = true;
        break;
      case "--position-side": {
        const value = argv[++index];
        if (value !== "net" && value !== "long" && value !== "short") {
          throw new Error(`Invalid value for --position-side: ${value ?? ""}`);
        }
        options.positionSide = value;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.accountId) {
    throw new Error("--account-id cannot be empty");
  }
  if (!options.symbol) {
    throw new Error("--symbol cannot be empty");
  }
  if (
    options.disconnectAfterSec !== undefined &&
    options.expireListenKeyAfterSec !== undefined
  ) {
    throw new Error(
      "--disconnect-after and --expire-listen-key-after are mutually exclusive",
    );
  }

  return options;
}

function summarizeOrder(snapshot: OrderSnapshot): OpenOrderSummary {
  return {
    orderId: snapshot.orderId,
    clientOrderId: snapshot.clientOrderId,
    symbol: snapshot.symbol,
    side: snapshot.side,
    type: snapshot.type,
    status: snapshot.status,
    price: snapshot.price,
    triggerPrice: snapshot.triggerPrice,
    amount: snapshot.amount,
    filled: snapshot.filled,
    remaining: snapshot.remaining,
    reduceOnly: snapshot.reduceOnly,
    positionSide: snapshot.positionSide,
    avgFillPrice: snapshot.avgFillPrice,
    exchangeTs: snapshot.exchangeTs,
    updatedAt: snapshot.updatedAt,
  };
}

function summarizeOpenOrders(
  snapshots: OrderSnapshot[],
  showOrders: boolean,
): OpenOrdersSnapshot {
  const symbols = [...new Set(snapshots.map((snapshot) => snapshot.symbol))];
  symbols.sort((left, right) => left.localeCompare(right));

  const orderIds = snapshots
    .map(
      (snapshot) =>
        snapshot.orderId ??
        snapshot.clientOrderId ??
        `${snapshot.symbol}:${snapshot.updatedAt}`,
    )
    .sort((left, right) => left.localeCompare(right));

  return {
    count: snapshots.length,
    symbols,
    orderIds,
    orders: showOrders ? snapshots.map(summarizeOrder) : undefined,
  };
}

function summarizeEvent(event: OrderEvent): OrderEventSummary {
  if (event.type === "order.snapshot_replaced") {
    const symbols = [
      ...new Set(event.snapshot.map((snapshot) => snapshot.symbol)),
    ];
    symbols.sort((left, right) => left.localeCompare(right));

    return {
      type: event.type,
      orderCount: event.snapshot.length,
      symbols,
      ts: event.ts,
    };
  }

  return {
    type: event.type,
    symbol: event.symbol,
    orderId: event.snapshot.orderId,
    clientOrderId: event.snapshot.clientOrderId,
    status: event.snapshot.status,
    ts: event.ts,
  };
}

function formatTradeFee(trade: OrderTradeEvent["trade"]): string {
  return trade.fee ? `${trade.fee.cost} ${trade.fee.asset}` : "undefined";
}

function printTradeEvent(event: OrderTradeEvent): void {
  writeStderr(
    [
      "order.trade",
      `tradeId=${event.trade.tradeId ?? "undefined"}`,
      `price=${event.trade.price}`,
      `qty=${event.trade.qty}`,
      `fee=${formatTradeFee(event.trade)}`,
      `realizedPnl=${event.trade.realizedPnl ?? "undefined"}`,
      `maker=${event.trade.maker ?? "undefined"}`,
    ].join(" "),
  );
}

function maxBigNumber(values: BigNumber[]): BigNumber {
  return values.reduce((max, value) =>
    value.isGreaterThan(max) ? value : max,
  );
}

function normalizeCancelAllTestOrder(options: {
  client: ReturnType<typeof createClient>;
  symbol: string;
  price: BigNumber;
  amount: BigNumber;
}): { price: string; amount: string } {
  let amount = options.amount;
  let lastRejectReason: string | undefined;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const normalized = options.client.market.normalizeOrderInput({
      venue: "binance",
      symbol: options.symbol,
      price: options.price.toFixed(),
      amount: amount.toFixed(),
    });

    if (normalized.accepted) {
      return {
        price: normalized.price,
        amount: normalized.amount,
      };
    }

    lastRejectReason = normalized.rejectReason;
    amount = amount.multipliedBy(2);
  }

  throw new Error(
    `Unable to normalize cancel-all test order: ${
      lastRejectReason ?? "unknown"
    }`,
  );
}

async function runCancelAllSmoke(options: {
  client: ReturnType<typeof createClient>;
  accountId: string;
  symbol: string;
  positionSide?: OrderSnapshot["positionSide"];
}): Promise<CancelAllSummary> {
  const existingOpenOrders = options.client.order.getOpenOrders(
    options.accountId,
    options.symbol,
  );
  if (existingOpenOrders.length > 0) {
    throw new Error(
      `Refusing cancel-all smoke with ${existingOpenOrders.length} pre-existing open orders for ${options.symbol}`,
    );
  }

  const key = {
    venue: "binance" as const,
    symbol: options.symbol,
  };
  let l1Lease: MarketSubscriptionLease | undefined;
  let cleanupNeeded = false;
  const placedOrders: OrderSnapshot[] = [];

  try {
    l1Lease = await options.client.market.acquireL1BookSubscription(key);
    await l1Lease.ready;

    const market = options.client.market.getMarket("binance", options.symbol);
    const book = options.client.market.getL1Book(key);
    if (!market || !book) {
      throw new Error(`Missing market data for ${options.symbol}`);
    }

    const bidPrice = new BigNumber(book.bidPrice);
    if (!bidPrice.isFinite() || bidPrice.isLessThanOrEqualTo(0)) {
      throw new Error(
        `Invalid bid price for ${options.symbol}: ${book.bidPrice}`,
      );
    }

    const price = bidPrice.multipliedBy("0.7");
    const minAmount =
      market.minAmount === undefined
        ? new BigNumber(0)
        : new BigNumber(market.minAmount);
    const minNotional =
      market.minNotional === undefined
        ? new BigNumber(0)
        : new BigNumber(market.minNotional);
    const amountStep = new BigNumber(market.amountStep);
    const amountFromNotional = minNotional.isGreaterThan(0)
      ? minNotional.multipliedBy(2).dividedBy(price)
      : new BigNumber(0);
    const amount = maxBigNumber([
      amountFromNotional,
      minAmount.multipliedBy(2),
      amountStep.multipliedBy(2),
    ]);
    const normalized = normalizeCancelAllTestOrder({
      client: options.client,
      symbol: options.symbol,
      price,
      amount,
    });

    const productOptions =
      market.contract || market.type !== "spot"
        ? {
            postOnly: true,
            um: {
              positionSide: options.positionSide,
            },
          }
        : {
            margin: {
              sideEffectType: "no_side_effect" as const,
            },
          };

    cleanupNeeded = true;
    for (let index = 0; index < CANCEL_ALL_TEST_ORDER_COUNT; index += 1) {
      placedOrders.push(
        await options.client.order.createOrder({
          accountId: options.accountId,
          symbol: options.symbol,
          side: "buy",
          type: "limit",
          price: normalized.price,
          amount: normalized.amount,
          ...productOptions,
        }),
      );
    }

    const canceledOrders = await options.client.order.cancelAllOrders({
      accountId: options.accountId,
      symbol: options.symbol,
    });
    cleanupNeeded = false;

    if (canceledOrders.length < CANCEL_ALL_TEST_ORDER_COUNT) {
      throw new Error(
        `Expected at least ${CANCEL_ALL_TEST_ORDER_COUNT} canceled snapshots, got ${canceledOrders.length}`,
      );
    }

    let remainingOpenOrders = options.client.order.getOpenOrders(
      options.accountId,
      options.symbol,
    );
    if (remainingOpenOrders.length > 0) {
      try {
        remainingOpenOrders = await waitForCondition(
          () => {
            const currentOpenOrders = options.client.order.getOpenOrders(
              options.accountId,
              options.symbol,
            );
            return currentOpenOrders.length === 0
              ? currentOpenOrders
              : undefined;
          },
          10_000,
          `Timed out waiting for ${options.symbol} open orders to clear after cancel-all`,
        );
      } catch {
        remainingOpenOrders = options.client.order.getOpenOrders(
          options.accountId,
          options.symbol,
        );
        throw new Error(
          `Expected no open orders after cancel-all for ${options.symbol}, got ${remainingOpenOrders.length}`,
        );
      }
    }

    return {
      symbol: options.symbol,
      placedOrders: placedOrders.map(summarizeOrder),
      canceledCount: canceledOrders.length,
      canceledOrders: canceledOrders.map(summarizeOrder),
      remainingOpenOrders: summarizeOpenOrders(remainingOpenOrders, true),
    };
  } finally {
    if (cleanupNeeded) {
      try {
        await options.client.order.cancelAllOrders({
          accountId: options.accountId,
          symbol: options.symbol,
        });
      } catch (error) {
        writeStderr(
          `Cancel-all cleanup failed: ${
            error instanceof Error ? error.message : `${error}`
          }`,
        );
      }
    }

    l1Lease?.close();
  }
}

async function smokeOrders(options: {
  client: ReturnType<typeof createClient>;
  accountId: string;
  apiKey: string;
  secret: string;
  durationMs: number;
  disconnectAfterMs?: number;
  expireListenKeyAfterMs?: number;
  reconnectWaitMs: number;
  showOrders: boolean;
}): Promise<SmokeResult> {
  const iterator = options.client.order.events
    .updates({
      accountId: options.accountId,
      venue: "binance",
    })
    [Symbol.asyncIterator]();
  const tradeIterator = options.client.order.events
    .trades({
      accountId: options.accountId,
      venue: "binance",
    })
    [Symbol.asyncIterator]();
  const tradeTask = (async () => {
    while (true) {
      const result = await tradeIterator.next();
      if (result.done) {
        return;
      }

      printTradeEvent(result.value);
    }
  })();
  const socketIndex = TrackedWebSocket.instances.length;

  try {
    const subscribeStartedAt = Date.now();
    await options.client.order.subscribeOrders({
      accountId: options.accountId,
    });
    const subscribeLatencyMs = Date.now() - subscribeStartedAt;

    const socket = await waitForTrackedSocket(
      socketIndex,
      5_000,
      "Timed out waiting for tracked order websocket",
    );
    const statusAfterSubscribe = options.client.order.getOrderStatus(
      options.accountId,
    );
    if (!statusAfterSubscribe) {
      throw new Error("Missing order status after subscribe");
    }

    const firstEvent = await nextEvent(
      iterator,
      5_000,
      "Timed out waiting for first order event",
    );

    let updateEventsAfterFirstEvent = 0;
    let reconnect: ReconnectSummary | undefined;
    let listenKeyExpiration: ListenKeyExpirationSummary | undefined;
    const startedAt = Date.now();
    const disconnectAt =
      options.disconnectAfterMs === undefined
        ? undefined
        : startedAt + options.disconnectAfterMs;
    const expireListenKeyAt =
      options.expireListenKeyAfterMs === undefined
        ? undefined
        : startedAt + options.expireListenKeyAfterMs;
    const deadline = startedAt + options.durationMs;

    if (disconnectAt !== undefined) {
      updateEventsAfterFirstEvent += await collectEventsUntil(
        iterator,
        Math.min(disconnectAt, deadline),
        {
          doneLabel: "Order update stream closed unexpectedly",
        },
      );
      socket.forceClose();

      const staleStatus = await waitForCondition(
        () => {
          const current = options.client.order.getOrderStatus(
            options.accountId,
          );
          if (current?.reason === "ws_disconnected") {
            return cloneStatus(current);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        "Timed out waiting for order ws_disconnected",
      );

      const reconnectedSocket = await waitForTrackedSocket(
        socketIndex + 1,
        options.reconnectWaitMs,
        "Timed out waiting for reconnected order websocket",
      );

      const recoveredStatus = await waitForCondition(
        () => {
          const current = options.client.order.getOrderStatus(
            options.accountId,
          );
          if (current?.runtimeStatus === "healthy" && current.ready) {
            return cloneStatus(current);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        "Timed out waiting for order reconnect recovery",
      );

      reconnect = {
        forcedDisconnectAt: new Date().toISOString(),
        staleStatus,
        reconnectedSocketUrl: reconnectedSocket.url,
        recoveredStatus,
        recoveredOpenOrderCount: options.client.order.getOpenOrders(
          options.accountId,
        ).length,
      };

      if (deadline > Date.now()) {
        updateEventsAfterFirstEvent += await collectEventsUntil(
          iterator,
          deadline,
          {
            doneLabel: "Order update stream closed unexpectedly",
          },
        );
      }
    } else if (expireListenKeyAt !== undefined) {
      const expiresWithinDeadline = expireListenKeyAt <= deadline;
      updateEventsAfterFirstEvent += await collectEventsUntil(
        iterator,
        expiresWithinDeadline ? expireListenKeyAt : deadline,
        {
          doneLabel: "Order update stream closed unexpectedly",
        },
      );

      if (expiresWithinDeadline) {
        const socketToExpire = latestTrackedSocket(socketIndex) ?? socket;
        const socketCountBeforeDelete = TrackedWebSocket.instances.length;
        const listenKey = extractListenKey(socketToExpire.url);
        await deleteListenKey({
          apiKey: options.apiKey,
          secret: options.secret,
          listenKey,
        });
        const statusAfterDelete = cloneStatus(
          options.client.order.getOrderStatus(options.accountId),
        );

        const reconnectedSocket = await waitForRotatedListenKeySocket({
          previousUrl: socketToExpire.url,
          minIndex: socketCountBeforeDelete,
          timeoutMs: options.reconnectWaitMs,
          label: "Timed out waiting for rotated listenKey recovery websocket",
        });

        const recoveredStatus = await waitForCondition(
          () => {
            const current = options.client.order.getOrderStatus(
              options.accountId,
            );
            if (current?.runtimeStatus === "healthy" && current.ready) {
              return cloneStatus(current);
            }
            return undefined;
          },
          options.reconnectWaitMs,
          "Timed out waiting for listenKey recovery",
        );

        listenKeyExpiration = {
          expiredAt: new Date().toISOString(),
          expiredListenKeySuffix: listenKeySuffix(listenKey),
          statusAfterDelete,
          reconnectedListenKeySuffix: extractListenKeySuffix(
            reconnectedSocket.url,
          ),
          recoveredStatus,
          recoveredOpenOrderCount: options.client.order.getOpenOrders(
            options.accountId,
          ).length,
        };
      }

      if (deadline > Date.now()) {
        updateEventsAfterFirstEvent += await collectEventsUntil(
          iterator,
          deadline,
          {
            doneLabel: "Order update stream closed unexpectedly",
          },
        );
      }
    } else {
      updateEventsAfterFirstEvent += await collectEventsUntil(
        iterator,
        deadline,
        {
          doneLabel: "Order update stream closed unexpectedly",
        },
      );
    }

    return {
      accountId: options.accountId,
      subscribeLatencyMs,
      socketUrl: socket.url,
      statusAfterSubscribe: cloneStatus(statusAfterSubscribe),
      cachedOpenOrders: summarizeOpenOrders(
        options.client.order.getOpenOrders(options.accountId),
        options.showOrders,
      ),
      firstEvent: summarizeEvent(firstEvent),
      updateEventsAfterFirstEvent,
      reconnect,
      listenKeyExpiration,
    };
  } finally {
    await iterator.return?.();
    await tradeIterator.return?.();
    await tradeTask;
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(Bun.argv.slice(2));
  const apiKey = requireEnv("BINANCE_PAPI_API_KEY");
  const secret = requireEnv("BINANCE_PAPI_SECRET");
  const listenKeyKeepAliveMs =
    cli.expireListenKeyAfterSec === undefined ? undefined : 5_000;
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 15_000,
      streamReconnectDelayMs: 1_000,
      streamReconnectMaxDelayMs: 3_000,
      venues: {
        binance: {
          listenKeyKeepAliveMs,
        },
      },
    },
  });
  const errors: ErrorSummary[] = [];
  const errorIterator = client.events.errors()[Symbol.asyncIterator]();

  installTrackedWebSocket();

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
    await client.registerAccount({
      accountId: cli.accountId,
      venue: "binance",
      credentials: {
        apiKey,
        secret,
      },
    });
    await client.start();

    const result = await smokeOrders({
      client,
      accountId: cli.accountId,
      apiKey,
      secret,
      durationMs: cli.durationSec * 1_000,
      disconnectAfterMs:
        cli.disconnectAfterSec === undefined
          ? undefined
          : cli.disconnectAfterSec * 1_000,
      expireListenKeyAfterMs:
        cli.expireListenKeyAfterSec === undefined
          ? undefined
          : cli.expireListenKeyAfterSec * 1_000,
      reconnectWaitMs: cli.reconnectWaitSec * 1_000,
      showOrders: cli.showOrders,
    });
    if (cli.cancelAll) {
      result.cancelAll = await runCancelAllSmoke({
        client,
        accountId: cli.accountId,
        symbol: cli.symbol,
        positionSide: cli.positionSide,
      });
    }

    const summary = {
      checkedAt: new Date().toISOString(),
      options: {
        ...cli,
        hasApiKey: Boolean(apiKey),
        hasSecret: Boolean(secret),
      },
      result,
      errors,
      healthBeforeStop: client.getHealth(),
    };

    writeStdout(JSON.stringify(summary, null, 2));
  } finally {
    await client.stop({ graceful: true, timeoutMs: 5_000 });
    await errorIterator.return?.();
    await errorTask;
    restoreTrackedWebSocket();
  }
}

main().catch((error) => {
  writeStderr(
    error instanceof Error ? (error.stack ?? error.message) : `${error}`,
  );
  process.exit(1);
});
