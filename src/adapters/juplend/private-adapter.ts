import BigNumber from "bignumber.js";
import type {
  AccountCredentials,
  VenueAccountCapabilities,
  VenueOrderCapabilities,
} from "../../types/index.ts";
import type {
  CancelAllOrdersRequest,
  CancelOrderRequest,
  CreateOrderRequest,
  PrivateStreamCallbacks,
  PrivateStreamOptions,
  PrivateUserDataAdapter,
  RawAccountBootstrap,
  RawBalanceUpdate,
  RawOrderUpdate,
  RawRiskUpdate,
  StreamHandle,
} from "../types.ts";
import {
  getJupApiKey,
  type JuplendTokenMetadata,
  readJuplendPositions,
} from "./borrow-api.ts";

interface JuplendMappedAccount {
  balances: RawBalanceUpdate[];
  risk?: RawRiskUpdate;
}

interface BalanceAccumulator {
  asset: string;
  supplied: BigNumber;
  borrowed: BigNumber;
  supplyAPY?: BigNumber;
  borrowAPY?: BigNumber;
}

interface JuplendAccountOptions {
  walletAddress: string;
  vaultId?: string;
  positionId?: string;
}

type FetchLike = typeof fetch;

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

function getJuplendAccountOptions(
  accountOptions?: Record<string, unknown>,
): JuplendAccountOptions {
  const walletAddress = accountOptions?.walletAddress;
  if (walletAddress !== undefined && typeof walletAddress !== "string") {
    throw new Error("options.walletAddress must be a string");
  }

  const vaultId = accountOptions?.vaultId;
  if (vaultId !== undefined && typeof vaultId !== "string") {
    throw new Error("options.vaultId must be a string");
  }
  const positionId = accountOptions?.positionId;
  if (positionId !== undefined && typeof positionId !== "string") {
    throw new Error("options.positionId must be a string");
  }

  if (!walletAddress) {
    throw new Error("options.walletAddress required");
  }

  return {
    walletAddress,
    vaultId: vaultId || undefined,
    positionId: positionId || undefined,
  };
}

function toBigNumber(
  value: BigNumber.Value | undefined,
  fallback = new BigNumber(0),
): BigNumber {
  return value === undefined ? fallback : new BigNumber(value);
}

function normalizeThreshold(value: BigNumber.Value | undefined): BigNumber {
  const threshold = toBigNumber(value);
  return threshold.gt(1) ? threshold.dividedBy(1000) : threshold;
}

function normalizeRate(
  value: BigNumber.Value | undefined,
): BigNumber | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rate = new BigNumber(value);
  if (!rate.isFinite()) {
    return undefined;
  }

  return rate.gt(1) ? rate.dividedBy(10_000) : rate;
}

function tokenAsset(
  token: JuplendTokenMetadata | undefined,
): string | undefined {
  return token?.uiSymbol ?? token?.symbol;
}

function tokenPrice(
  token: JuplendTokenMetadata | undefined,
): BigNumber | undefined {
  const price = toBigNumber(
    token?.usdPrice ?? token?.price ?? token?.oraclePrice,
  );
  return price.gt(0) ? price : undefined;
}

function setAccumulator(
  map: Map<string, BalanceAccumulator>,
  asset: string,
): BalanceAccumulator {
  const existing = map.get(asset);
  if (existing) {
    return existing;
  }

  const next: BalanceAccumulator = {
    asset,
    supplied: new BigNumber(0),
    borrowed: new BigNumber(0),
  };
  map.set(asset, next);
  return next;
}

function buildBalances(
  balances: Map<string, BalanceAccumulator>,
  receivedAt: number,
): RawBalanceUpdate[] {
  return [...balances.values()].map((balance) => {
    const netAsset = balance.supplied.minus(balance.borrowed);
    return {
      asset: balance.asset,
      free: "0",
      used: "0",
      total: netAsset.toString(10),
      receivedAt,
      lending: {
        supplied: balance.supplied.toString(10),
        borrowed: balance.borrowed.toString(10),
        interest: "0",
        netAsset: netAsset.toString(10),
        supplyAPY: balance.supplyAPY?.toString(10),
        borrowAPY: balance.borrowAPY?.toString(10),
      },
    };
  });
}

function buildRisk(input: {
  totalCollateralUsd: BigNumber;
  totalDebtUsd: BigNumber;
  weightedLiquidationValueUsd: BigNumber;
  receivedAt: number;
}): RawRiskUpdate | undefined {
  const { totalCollateralUsd, totalDebtUsd, weightedLiquidationValueUsd } =
    input;
  if (totalCollateralUsd.isZero() && totalDebtUsd.isZero()) {
    return undefined;
  }

  const riskRatio = weightedLiquidationValueUsd.isZero()
    ? undefined
    : totalDebtUsd.dividedBy(weightedLiquidationValueUsd).toString(10);
  const ltv = totalCollateralUsd.isZero()
    ? undefined
    : totalDebtUsd.dividedBy(totalCollateralUsd).toString(10);
  const liquidationThreshold = totalCollateralUsd.isZero()
    ? undefined
    : weightedLiquidationValueUsd.dividedBy(totalCollateralUsd).toString(10);
  const healthFactor = riskRatio
    ? new BigNumber(1).dividedBy(riskRatio).toString(10)
    : undefined;

  return {
    netEquity: totalCollateralUsd.minus(totalDebtUsd).toString(10),
    riskEquity: weightedLiquidationValueUsd.minus(totalDebtUsd).toString(10),
    riskRatio,
    receivedAt: input.receivedAt,
    lending: {
      healthFactor,
      ltv,
      liquidationThreshold,
      totalCollateralUSD: totalCollateralUsd.toString(10),
      totalDebtUSD: totalDebtUsd.toString(10),
    },
  };
}

function tokenDecimals(
  token: JuplendTokenMetadata | undefined,
  context: string,
): number {
  if (token?.decimals === undefined || token.decimals === null) {
    throw new Error(`Juplend ${context} token missing decimals`);
  }

  const decimals = Number(token.decimals);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Juplend ${context} token invalid decimals`);
  }

  return decimals;
}

function divideTokenAmount(
  value: BigNumber,
  token: JuplendTokenMetadata | undefined,
  context: string,
): BigNumber {
  return value.dividedBy(new BigNumber(10).pow(tokenDecimals(token, context)));
}

async function mapAccount(
  accountOptions: JuplendAccountOptions,
  receivedAt: number,
  jupApiKey: string | undefined,
  fetchFn: FetchLike | undefined,
  timeoutMs: number,
): Promise<JuplendMappedAccount> {
  const positionResult = await readJuplendPositions({
    walletAddress: accountOptions.walletAddress,
    vaultId: accountOptions.vaultId,
    positionId: accountOptions.positionId,
    jupApiKey,
    fetchFn,
    timeoutMs,
  });

  const balances = new Map<string, BalanceAccumulator>();
  let totalCollateralUsd = new BigNumber(0);
  let totalDebtUsd = new BigNumber(0);
  let weightedLiquidationValueUsd = new BigNumber(0);

  for (const position of positionResult.positions) {
    const vault = position.vault;
    const suppliedQuantity = divideTokenAmount(
      toBigNumber(position.supplyAmount),
      vault.supplyToken,
      `position ${position.nftId} supply`,
    );
    const borrowedBaseAmount = toBigNumber(position.borrowAmount).plus(
      toBigNumber(position.dustBorrowAmount),
    );
    const borrowedQuantity = divideTokenAmount(
      borrowedBaseAmount,
      vault.borrowToken,
      `position ${position.nftId} borrow`,
    );

    const liquidationThreshold = normalizeThreshold(vault.liquidationThreshold);

    const supplyAsset =
      tokenAsset(vault.supplyToken) ?? vault.supplyToken?.address;
    if (supplyAsset) {
      const accumulator = setAccumulator(balances, supplyAsset);
      accumulator.supplied = accumulator.supplied.plus(suppliedQuantity);
      accumulator.supplyAPY =
        normalizeRate(vault.supplyRate) ?? accumulator.supplyAPY;
    }

    const borrowAsset =
      tokenAsset(vault.borrowToken) ?? vault.borrowToken?.address;
    if (borrowAsset) {
      const accumulator = setAccumulator(balances, borrowAsset);
      accumulator.borrowed = accumulator.borrowed.plus(borrowedQuantity);
      accumulator.borrowAPY =
        normalizeRate(vault.borrowRate) ?? accumulator.borrowAPY;
    }

    const supplyPrice = tokenPrice(vault.supplyToken);
    if (supplyPrice) {
      const collateralUsd = suppliedQuantity.multipliedBy(supplyPrice);
      totalCollateralUsd = totalCollateralUsd.plus(collateralUsd);
      weightedLiquidationValueUsd = weightedLiquidationValueUsd.plus(
        collateralUsd.multipliedBy(liquidationThreshold),
      );
    }

    const borrowPrice = tokenPrice(vault.borrowToken);
    if (borrowPrice) {
      totalDebtUsd = totalDebtUsd.plus(
        borrowedQuantity.multipliedBy(borrowPrice),
      );
    }
  }

  return {
    balances: buildBalances(balances, receivedAt),
    risk: buildRisk({
      totalCollateralUsd,
      totalDebtUsd,
      weightedLiquidationValueUsd,
      receivedAt,
    }),
  };
}

export class JuplendPrivateAdapter implements PrivateUserDataAdapter {
  readonly venue = "juplend" as const;
  readonly readOnly = true;
  readonly notes = [
    "Juplend support is limited to read-only lending account views.",
    "Order and market data managers are not supported for this venue.",
  ];
  readonly accountCapabilities: VenueAccountCapabilities = {
    register: "supported",
    snapshot: "supported",
    updates: "polling",
    balances: "supported",
    positions: "unsupported",
    risk: "supported",
    lending: "supported",
    fundingFeeHistory: "unsupported",
    credentialsRequired: false,
  };
  readonly orderCapabilities: VenueOrderCapabilities = {
    supported: false,
    openOrders: "unsupported",
    updates: "unsupported",
    fees: "unsupported",
    create: "unsupported",
    cancel: "unsupported",
    cancelAll: "unsupported",
    orderTypes: [],
    timeInForce: [],
    postOnly: false,
    reduceOnly: false,
    positionSide: "unsupported",
    clientOrderId: false,
    reason: "read_only",
  };

  constructor(
    private readonly jupApiKey?: string,
    private readonly options: {
      readonly fetchFn?: FetchLike;
      readonly httpTimeoutMs?: number;
      readonly pollIntervalMs?: number;
    } = {},
  ) {}

  async bootstrapAccount(
    _credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap> {
    const receivedAt = Date.now();
    const juplendOptions = getJuplendAccountOptions(accountOptions);
    const mapped = await mapAccount(
      juplendOptions,
      receivedAt,
      getJupApiKey(this.jupApiKey),
      this.options.fetchFn,
      this.options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    );

    return {
      balances: mapped.balances,
      positions: [],
      risk: mapped.risk,
      receivedAt,
    };
  }

  bootstrapOpenOrders(): Promise<RawOrderUpdate[]> {
    return Promise.resolve([]);
  }

  createOrder(
    _credentials: AccountCredentials,
    _request: CreateOrderRequest,
  ): Promise<RawOrderUpdate> {
    throw new Error("Juplend is read-only and does not support createOrder");
  }

  cancelOrder(
    _credentials: AccountCredentials,
    _request: CancelOrderRequest,
  ): Promise<RawOrderUpdate> {
    throw new Error("Juplend is read-only and does not support cancelOrder");
  }

  cancelAllOrders(
    _credentials: AccountCredentials,
    _request: CancelAllOrdersRequest,
  ): Promise<RawOrderUpdate[]> {
    throw new Error(
      "Juplend is read-only and does not support cancelAllOrders",
    );
  }

  createPrivateStream(
    credentials: AccountCredentials,
    callbacks: PrivateStreamCallbacks,
    _options: PrivateStreamOptions,
    accountOptions?: Record<string, unknown>,
  ): StreamHandle {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollIntervalMs =
      this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const poll = async (): Promise<void> => {
      try {
        const bootstrap = await this.bootstrapAccount(
          credentials,
          accountOptions,
        );
        if (closed) {
          return;
        }

        callbacks.onAccountSnapshot(bootstrap);
      } catch (error) {
        callbacks.onError(
          error instanceof Error ? error : new Error("Juplend polling failed"),
        );
      }
    };

    const scheduleNextPoll = (): void => {
      if (closed) {
        return;
      }

      timer = setTimeout(() => {
        void poll().finally(scheduleNextPoll);
      }, pollIntervalMs);
    };

    const ready = Promise.resolve().then(() => {
      scheduleNextPoll();
    });

    return {
      ready,
      close() {
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
    };
  }
}
