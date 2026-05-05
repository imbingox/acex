import { createClient, type OrderEvent, type OrderSnapshot } from "../index.ts";
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
  durationSec: number;
  disconnectAfterSec?: number;
  reconnectWaitSec: number;
  showOrders: boolean;
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

interface SmokeResult {
  accountId: string;
  subscribeLatencyMs: number;
  socketUrl: string;
  statusAfterSubscribe: Record<string, unknown>;
  cachedOpenOrders: OpenOrdersSnapshot;
  firstEvent: OrderEventSummary;
  updateEventsAfterFirstEvent: number;
  reconnect?: ReconnectSummary;
}

const DEFAULT_ACCOUNT_ID = "live-binance";
const DEFAULT_DURATION_SEC = 10;
const DEFAULT_RECONNECT_WAIT_SEC = 10;

function printHelp(): void {
  writeStdout(`Usage:
  bun run test:live:order -- [options]

Environment:
  BINANCE_PAPI_API_KEY      Required Binance PAPI API key
  BINANCE_PAPI_SECRET       Required Binance PAPI secret

Options:
  --account-id <id>          SDK account id (default: ${DEFAULT_ACCOUNT_ID})
  --duration <seconds>       Total observation duration (default: ${DEFAULT_DURATION_SEC})
  --disconnect-after <sec>   Force-close the private websocket after N seconds and verify reconnect
  --reconnect-wait <sec>     Max reconnect recovery wait (default: ${DEFAULT_RECONNECT_WAIT_SEC})
  --show-orders              Include cached open-order details in output
  --help                     Show this help

Examples:
  bun run test:live:order -- --duration 10
  bun run test:live:order -- --duration 60 --disconnect-after 5 --show-orders`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    accountId: DEFAULT_ACCOUNT_ID,
    durationSec: DEFAULT_DURATION_SEC,
    reconnectWaitSec: DEFAULT_RECONNECT_WAIT_SEC,
    showOrders: false,
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
      case "--duration":
        options.durationSec = parseNumber(argv[++index] ?? "", "--duration");
        break;
      case "--disconnect-after":
        options.disconnectAfterSec = parseNumber(
          argv[++index] ?? "",
          "--disconnect-after",
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
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.accountId) {
    throw new Error("--account-id cannot be empty");
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
    price: snapshot.price?.toFixed(),
    triggerPrice: snapshot.triggerPrice?.toFixed(),
    amount: snapshot.amount.toFixed(),
    filled: snapshot.filled.toFixed(),
    remaining: snapshot.remaining?.toFixed(),
    reduceOnly: snapshot.reduceOnly,
    positionSide: snapshot.positionSide,
    avgFillPrice: snapshot.avgFillPrice?.toFixed(),
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

async function smokeOrders(options: {
  client: ReturnType<typeof createClient>;
  accountId: string;
  durationMs: number;
  disconnectAfterMs?: number;
  reconnectWaitMs: number;
  showOrders: boolean;
}): Promise<SmokeResult> {
  const iterator = options.client.order.events
    .updates({
      accountId: options.accountId,
      venue: "binance",
    })
    [Symbol.asyncIterator]();
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
    const startedAt = Date.now();
    const disconnectAt =
      options.disconnectAfterMs === undefined
        ? undefined
        : startedAt + options.disconnectAfterMs;
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
    };
  } finally {
    await iterator.return?.();
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(Bun.argv.slice(2));
  const apiKey = requireEnv("BINANCE_PAPI_API_KEY");
  const secret = requireEnv("BINANCE_PAPI_SECRET");
  const client = createClient({
    account: {
      streamOpenTimeoutMs: 15_000,
      streamReconnectDelayMs: 1_000,
      streamReconnectMaxDelayMs: 3_000,
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
      durationMs: cli.durationSec * 1_000,
      disconnectAfterMs:
        cli.disconnectAfterSec === undefined
          ? undefined
          : cli.disconnectAfterSec * 1_000,
      reconnectWaitMs: cli.reconnectWaitSec * 1_000,
      showOrders: cli.showOrders,
    });

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
