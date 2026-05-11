import { type AccountEvent, createClient } from "../index.ts";
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
  showAmounts: boolean;
}

interface AccountEventSummary {
  type: AccountEvent["type"];
  asset?: string;
  symbol?: string;
  ts: number;
}

interface ReconnectSummary {
  forcedDisconnectAt: string;
  staleStatus: Record<string, unknown>;
  reconnectedSocketUrl: string;
  recoveredStatus: Record<string, unknown>;
}

interface SmokeResult {
  accountId: string;
  subscribeLatencyMs: number;
  socketUrl: string;
  statusAfterSubscribe: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  firstEvent: AccountEventSummary;
  updateEventsAfterFirstEvent: number;
  reconnect?: ReconnectSummary;
}

const DEFAULT_ACCOUNT_ID = "live-binance";
const DEFAULT_DURATION_SEC = 10;
const DEFAULT_RECONNECT_WAIT_SEC = 10;

function printHelp(): void {
  writeStdout(`Usage:
  bun run test:live:account -- [options]

Environment:
  BINANCE_PAPI_API_KEY      Required Binance PAPI API key
  BINANCE_PAPI_SECRET       Required Binance PAPI secret

Options:
  --account-id <id>          SDK account id (default: ${DEFAULT_ACCOUNT_ID})
  --duration <seconds>       Total observation duration (default: ${DEFAULT_DURATION_SEC})
  --disconnect-after <sec>   Force-close the private websocket after N seconds and verify reconnect
  --reconnect-wait <sec>     Max reconnect recovery wait (default: ${DEFAULT_RECONNECT_WAIT_SEC})
  --show-amounts             Include balance/position/risk amounts in output
  --help                     Show this help

Examples:
  bun run test:live:account -- --duration 10
  bun run test:live:account -- --duration 60 --disconnect-after 5 --show-amounts`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    accountId: DEFAULT_ACCOUNT_ID,
    durationSec: DEFAULT_DURATION_SEC,
    reconnectWaitSec: DEFAULT_RECONNECT_WAIT_SEC,
    showAmounts: false,
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
      case "--show-amounts":
        options.showAmounts = true;
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

function summarizeEvent(event: AccountEvent): AccountEventSummary {
  return {
    type: event.type,
    asset: "asset" in event ? event.asset : undefined,
    symbol: "symbol" in event ? event.symbol : undefined,
    ts: event.ts,
  };
}

function summarizeSnapshot(
  client: ReturnType<typeof createClient>,
  accountId: string,
  showAmounts: boolean,
): Record<string, unknown> {
  const balances = client.account.getBalances(accountId);
  const positions = client.account.getPositions(accountId);
  const risk = client.account.getRiskSnapshot(accountId);

  return {
    balanceCount: balances.length,
    balanceAssets: balances.map((balance) => balance.asset).sort(),
    balances: showAmounts
      ? balances.map((balance) => ({
          asset: balance.asset,
          free: balance.free.toFixed(),
          used: balance.used.toFixed(),
          total: balance.total.toFixed(),
          exchangeTs: balance.exchangeTs,
          updatedAt: balance.updatedAt,
        }))
      : undefined,
    positionCount: positions.length,
    positionSymbols: positions.map((position) => position.symbol).sort(),
    positions: showAmounts
      ? positions.map((position) => ({
          symbol: position.symbol,
          side: position.side,
          size: position.size.toFixed(),
          entryPrice: position.entryPrice?.toFixed(),
          markPrice: position.markPrice?.toFixed(),
          unrealizedPnl: position.unrealizedPnl?.toFixed(),
          exchangeTs: position.exchangeTs,
          updatedAt: position.updatedAt,
        }))
      : undefined,
    risk: risk
      ? {
          hasEquity: risk.equity !== undefined,
          hasMarginRatio: risk.riskRatio !== undefined,
          hasActualLeverage: risk.actualLeverage !== undefined,
          hasInitialMargin: risk.initialMargin !== undefined,
          hasMaintenanceMargin: risk.maintenanceMargin !== undefined,
          equity: showAmounts ? risk.equity?.toFixed() : undefined,
          riskRatio: showAmounts ? risk.riskRatio?.toFixed() : undefined,
          actualLeverage: showAmounts
            ? risk.actualLeverage?.toFixed()
            : undefined,
          initialMargin: showAmounts
            ? risk.initialMargin?.toFixed()
            : undefined,
          maintenanceMargin: showAmounts
            ? risk.maintenanceMargin?.toFixed()
            : undefined,
          exchangeTs: risk.exchangeTs,
          updatedAt: risk.updatedAt,
        }
      : null,
  };
}

async function smokeAccount(options: {
  client: ReturnType<typeof createClient>;
  accountId: string;
  durationMs: number;
  disconnectAfterMs?: number;
  reconnectWaitMs: number;
  showAmounts: boolean;
}): Promise<SmokeResult> {
  const iterator = options.client.account.events
    .updates({
      accountId: options.accountId,
      venue: "binance",
    })
    [Symbol.asyncIterator]();
  const socketIndex = TrackedWebSocket.instances.length;

  try {
    const subscribeStartedAt = Date.now();
    await options.client.account.subscribeAccount({
      accountId: options.accountId,
    });
    const subscribeLatencyMs = Date.now() - subscribeStartedAt;

    const socket = await waitForTrackedSocket(
      socketIndex,
      5_000,
      "Timed out waiting for tracked account websocket",
    );
    const statusAfterSubscribe = options.client.account.getAccountStatus(
      options.accountId,
    );
    const snapshot = options.client.account.getAccountSnapshot(
      options.accountId,
    );
    if (!statusAfterSubscribe || !snapshot) {
      throw new Error("Missing account snapshot or status after subscribe");
    }

    const firstEvent = await nextEvent(
      iterator,
      5_000,
      "Timed out waiting for first account event",
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
          doneLabel: "Account update stream closed unexpectedly",
        },
      );
      socket.forceClose();

      const staleStatus = await waitForCondition(
        () => {
          const current = options.client.account.getAccountStatus(
            options.accountId,
          );
          if (current?.reason === "ws_disconnected") {
            return cloneStatus(current);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        "Timed out waiting for account ws_disconnected",
      );

      const reconnectedSocket = await waitForTrackedSocket(
        socketIndex + 1,
        options.reconnectWaitMs,
        "Timed out waiting for reconnected account websocket",
      );

      const recoveredStatus = await waitForCondition(
        () => {
          const current = options.client.account.getAccountStatus(
            options.accountId,
          );
          if (current?.runtimeStatus === "healthy" && current.ready) {
            return cloneStatus(current);
          }
          return undefined;
        },
        options.reconnectWaitMs,
        "Timed out waiting for account reconnect recovery",
      );

      reconnect = {
        forcedDisconnectAt: new Date().toISOString(),
        staleStatus,
        reconnectedSocketUrl: reconnectedSocket.url,
        recoveredStatus,
      };

      if (deadline > Date.now()) {
        updateEventsAfterFirstEvent += await collectEventsUntil(
          iterator,
          deadline,
          {
            doneLabel: "Account update stream closed unexpectedly",
          },
        );
      }
    } else {
      updateEventsAfterFirstEvent += await collectEventsUntil(
        iterator,
        deadline,
        {
          doneLabel: "Account update stream closed unexpectedly",
        },
      );
    }

    return {
      accountId: options.accountId,
      subscribeLatencyMs,
      socketUrl: socket.url,
      statusAfterSubscribe: cloneStatus(statusAfterSubscribe),
      snapshot: summarizeSnapshot(
        options.client,
        options.accountId,
        options.showAmounts,
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

    const result = await smokeAccount({
      client,
      accountId: cli.accountId,
      durationMs: cli.durationSec * 1_000,
      disconnectAfterMs:
        cli.disconnectAfterSec === undefined
          ? undefined
          : cli.disconnectAfterSec * 1_000,
      reconnectWaitMs: cli.reconnectWaitSec * 1_000,
      showAmounts: cli.showAmounts,
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
