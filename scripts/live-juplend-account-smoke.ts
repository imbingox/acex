import { type AccountEvent, createClient } from "../index.ts";
import {
  cloneStatus,
  collectEventsUntil,
  nextEvent,
  parseNumber,
  summarizeError,
  waitForCondition,
  writeStderr,
  writeStdout,
} from "./live-private-smoke-shared.ts";

interface CliOptions {
  accountId: string;
  walletAddress?: string;
  vaultId?: string;
  positionId?: string;
  rpcUrl?: string;
  durationSec: number;
  pollIntervalMs: number;
  showAmounts: boolean;
}

interface SmokeResult {
  accountId: string;
  walletAddress?: string;
  vaultId?: string;
  positionId?: string;
  rpcUrl?: string;
  subscribeLatencyMs: number;
  statusAfterSubscribe: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  firstEvent: Record<string, unknown>;
  updateEventsAfterFirstEvent: number;
}

const DEFAULT_ACCOUNT_ID = "live-juplend";
const DEFAULT_DURATION_SEC = 35;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

function printHelp(): void {
  writeStdout(`Usage:
  bun run test:live:juplend -- [options]

Environment:
  JUPLEND_WALLET_ADDRESS    Optional Solana wallet address to inspect
  SOL_HELIUS_RPC            Optional Solana RPC URL for @jup-ag/lend-read
  JUP_API                   Optional Jup API key for Tokens V2 / Price V3

Options:
  --account-id <id>          SDK account id (default: ${DEFAULT_ACCOUNT_ID})
  --wallet-address <addr>    Solana wallet address (overrides JUPLEND_WALLET_ADDRESS)
  --vault-id <id>            Juplend vault id for direct single-position read
  --position-id <id>         Juplend NFT position id
  --rpc-url <url>            Optional Solana RPC URL (overrides SOL_HELIUS_RPC)
  --duration <seconds>       Total observation duration (default: ${DEFAULT_DURATION_SEC})
  --poll-interval-ms <ms>    Juplend polling interval (default: ${DEFAULT_POLL_INTERVAL_MS})
  --show-amounts             Include lending balance/risk amounts in output
  --help                     Show this help

Examples:
  SOL_HELIUS_RPC=... JUPLEND_WALLET_ADDRESS=... bun run test:live:juplend -- --show-amounts
  bun run test:live:juplend -- --account-id jup-loop-a --wallet-address <wallet> --position-id <nftId> --rpc-url <rpc> --poll-interval-ms 10000 --duration 25
  bun run test:live:juplend -- --account-id jup-loop-a --vault-id <vaultId> --position-id <nftId> --rpc-url <rpc> --show-amounts`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    accountId: DEFAULT_ACCOUNT_ID,
    walletAddress: process.env.JUPLEND_WALLET_ADDRESS || undefined,
    rpcUrl: process.env.SOL_HELIUS_RPC,
    durationSec: DEFAULT_DURATION_SEC,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
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
      case "--wallet-address":
        options.walletAddress = argv[++index] ?? "";
        break;
      case "--vault-id":
        options.vaultId = argv[++index] ?? "";
        break;
      case "--position-id":
        options.positionId = argv[++index] ?? "";
        break;
      case "--rpc-url":
        options.rpcUrl = argv[++index] ?? "";
        break;
      case "--duration":
        options.durationSec = parseNumber(argv[++index] ?? "", "--duration");
        break;
      case "--poll-interval-ms":
        options.pollIntervalMs = parseNumber(
          argv[++index] ?? "",
          "--poll-interval-ms",
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

  if (!options.walletAddress && !(options.vaultId && options.positionId)) {
    throw new Error(
      "JUPLEND_WALLET_ADDRESS/--wallet-address or --vault-id + --position-id is required",
    );
  }

  if (options.pollIntervalMs <= 0) {
    throw new Error("--poll-interval-ms must be positive");
  }

  return options;
}

function summarizeSnapshot(
  client: ReturnType<typeof createClient>,
  accountId: string,
  showAmounts: boolean,
): Record<string, unknown> {
  const balances = client.account.getBalances(accountId);
  const risk = client.account.getRiskSnapshot(accountId);

  return {
    balanceCount: balances.length,
    balanceAssets: balances.map((balance) => balance.asset).sort(),
    balances: showAmounts
      ? balances.map((balance) => ({
          asset: balance.asset,
          total: balance.total,
          lending: balance.lending
            ? {
                supplied: balance.lending.supplied,
                borrowed: balance.lending.borrowed,
                interest: balance.lending.interest,
                netAsset: balance.lending.netAsset,
                supplyAPY: balance.lending.supplyAPY,
                borrowAPY: balance.lending.borrowAPY,
              }
            : undefined,
          updatedAt: balance.updatedAt,
        }))
      : undefined,
    risk: risk
      ? {
          hasRiskRatio: risk.riskRatio !== undefined,
          riskRatio: showAmounts ? risk.riskRatio : undefined,
          netEquity: showAmounts ? risk.netEquity : undefined,
          riskEquity: showAmounts ? risk.riskEquity : undefined,
          lending: risk.lending
            ? {
                healthFactor: showAmounts
                  ? risk.lending.healthFactor
                  : undefined,
                ltv: showAmounts ? risk.lending.ltv : undefined,
                liquidationThreshold: showAmounts
                  ? risk.lending.liquidationThreshold
                  : undefined,
                totalCollateralUSD: showAmounts
                  ? risk.lending.totalCollateralUSD
                  : undefined,
                totalDebtUSD: showAmounts
                  ? risk.lending.totalDebtUSD
                  : undefined,
              }
            : undefined,
          updatedAt: risk.updatedAt,
        }
      : null,
  };
}

function summarizeEvent(event: AccountEvent): Record<string, unknown> {
  return {
    type: event.type,
    accountId: "accountId" in event ? event.accountId : undefined,
    venue: "venue" in event ? event.venue : undefined,
    asset: "asset" in event ? event.asset : undefined,
    ts: "ts" in event ? event.ts : undefined,
  };
}

async function smokeJuplend(options: {
  accountId: string;
  walletAddress?: string;
  vaultId?: string;
  positionId?: string;
  rpcUrl?: string;
  durationMs: number;
  pollIntervalMs: number;
  showAmounts: boolean;
}): Promise<SmokeResult> {
  const client = createClient({
    account: {
      venues: {
        juplend: {
          pollIntervalMs: options.pollIntervalMs,
          rpcUrl: options.rpcUrl,
        },
      },
    },
  });

  const updateIterator = client.account.events
    .updates({ accountId: options.accountId, venue: "juplend" })
    [Symbol.asyncIterator]();
  const errorIterator = client.events.errors()[Symbol.asyncIterator]();

  try {
    const accountOptions = options.walletAddress
      ? {
          walletAddress: options.walletAddress,
          positionId: options.positionId,
        }
      : {
          vaultId: options.vaultId as string,
          positionId: options.positionId as string,
        };

    await client.registerAccount({
      accountId: options.accountId,
      venue: "juplend",
      options: accountOptions,
    });
    await client.start();

    const startedAt = Date.now();
    await client.account.subscribeAccount({ accountId: options.accountId });
    const subscribeLatencyMs = Date.now() - startedAt;

    const statusAfterSubscribe = await waitForCondition(
      () => {
        const status = client.account.getAccountStatus(options.accountId);
        return status?.ready ? cloneStatus(status) : undefined;
      },
      10_000,
      "Juplend account did not become ready after subscribe",
    );

    const firstEvent = await nextEvent(
      updateIterator,
      10_000,
      "No Juplend account event received",
    );
    const deadlineMs = Date.now() + options.durationMs;
    const updateEventsAfterFirstEvent = await collectEventsUntil(
      updateIterator,
      deadlineMs,
      {
        idlePollMs: Math.min(options.pollIntervalMs, 1_000),
      },
    );

    const result: SmokeResult = {
      accountId: options.accountId,
      walletAddress: options.walletAddress,
      vaultId: options.vaultId,
      positionId: options.positionId,
      rpcUrl: options.rpcUrl,
      subscribeLatencyMs,
      statusAfterSubscribe,
      snapshot: summarizeSnapshot(
        client,
        options.accountId,
        options.showAmounts,
      ),
      firstEvent: summarizeEvent(firstEvent),
      updateEventsAfterFirstEvent,
    };

    const errorRace = await Promise.race([
      errorIterator.next(),
      Promise.resolve(undefined),
    ]);
    if (errorRace && !errorRace.done) {
      throw new Error(
        `Runtime error emitted: ${JSON.stringify(summarizeError(errorRace.value))}`,
      );
    }

    return result;
  } finally {
    await updateIterator.return?.();
    await errorIterator.return?.();
    await client.stop();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await smokeJuplend({
    accountId: options.accountId,
    walletAddress: options.walletAddress,
    vaultId: options.vaultId,
    positionId: options.positionId,
    rpcUrl: options.rpcUrl,
    durationMs: options.durationSec * 1_000,
    pollIntervalMs: options.pollIntervalMs,
    showAmounts: options.showAmounts,
  });

  writeStdout(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  writeStderr(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
