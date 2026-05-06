import BigNumber from "bignumber.js";
import { AcexError } from "../../errors.ts";
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

interface JuplendPortfolioResponse {
  elements?: JuplendPortfolioElement[];
}

interface JuplendPortfolioElement {
  data?: {
    link?: string;
    suppliedValue?: number | string;
    borrowedValue?: number | string;
    value?: number | string;
  };
}

interface JuplendVaultResponse {
  data?: JuplendVault[];
}

interface JuplendVault {
  id?: number | string;
  vaultId?: number | string;
  supplyToken?: JuplendToken;
  borrowToken?: JuplendToken;
  liquidationThreshold?: number | string;
  loanToValue?: number | string;
  supplyRate?: number | string;
  borrowRate?: number | string;
}

interface JuplendToken {
  symbol?: string;
  asset?: string;
  oraclePrice?: number | string;
  price?: number | string;
}

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
  positionId?: string;
}

const PORTFOLIO_BASE_URL = "https://api.jup.ag/portfolio/v1";
const VAULTS_URL = "https://lite-api.jup.ag/lend/v1/borrow/vaults";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const VAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const LINK_PATTERN = /\/borrow\/([^/]+)\/nfts\/([^/?#]+)/;

let vaultCache:
  | {
      loadedAt: number;
      vaults: Map<string, JuplendVault>;
    }
  | undefined;
let vaultCachePromise: Promise<Map<string, JuplendVault>> | undefined;

function requireApiKey(credentials: AccountCredentials): string {
  if (!credentials.apiKey) {
    throw new Error("credentials.apiKey required");
  }

  return credentials.apiKey;
}

function getJuplendAccountOptions(
  accountOptions?: Record<string, unknown>,
): JuplendAccountOptions {
  const walletAddress = accountOptions?.walletAddress;
  if (typeof walletAddress !== "string" || !walletAddress) {
    throw new Error("options.walletAddress required");
  }

  const positionId = accountOptions.positionId;
  if (positionId !== undefined && typeof positionId !== "string") {
    throw new Error("options.positionId must be a string");
  }

  return {
    walletAddress,
    positionId: positionId || undefined,
  };
}

function toBigNumber(value: number | string | undefined): BigNumber {
  return value === undefined ? new BigNumber(0) : new BigNumber(value);
}

function normalizeThreshold(value: number | string | undefined): BigNumber {
  const threshold = toBigNumber(value);
  return threshold.gt(1) ? threshold.dividedBy(1000) : threshold;
}

function tokenAsset(token: JuplendToken | undefined): string | undefined {
  return token?.symbol ?? token?.asset;
}

function tokenPrice(token: JuplendToken | undefined): BigNumber | undefined {
  const price = toBigNumber(token?.oraclePrice ?? token?.price);
  return price.gt(0) ? price : undefined;
}

function extractPositionLink(
  link: string | undefined,
): { vaultId: string; positionId: string } | undefined {
  if (!link) {
    return undefined;
  }

  const match = LINK_PATTERN.exec(link);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  return {
    vaultId: match[1],
    positionId: match[2],
  };
}

function getVaultId(vault: JuplendVault): string | undefined {
  const id = vault.id ?? vault.vaultId;
  return id === undefined ? undefined : `${id}`;
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
    equity: totalCollateralUsd.minus(totalDebtUsd).toString(10),
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

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Juplend HTTP ${response.status}: ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function loadVaults(now: number): Promise<Map<string, JuplendVault>> {
  if (vaultCache && now - vaultCache.loadedAt < VAULT_CACHE_TTL_MS) {
    return vaultCache.vaults;
  }

  if (!vaultCachePromise) {
    vaultCachePromise = readJson<JuplendVaultResponse | JuplendVault[]>(
      VAULTS_URL,
    )
      .then((response) => {
        const rawVaults = Array.isArray(response) ? response : response.data;
        const vaults = new Map<string, JuplendVault>();
        for (const vault of rawVaults ?? []) {
          const id = getVaultId(vault);
          if (id) {
            vaults.set(id, vault);
          }
        }
        vaultCache = { loadedAt: now, vaults };
        return vaults;
      })
      .finally(() => {
        vaultCachePromise = undefined;
      });
  }

  try {
    return await vaultCachePromise;
  } catch (error) {
    if (vaultCache) {
      return vaultCache.vaults;
    }
    throw error;
  }
}

async function loadPortfolio(
  walletAddress: string,
  apiKey: string,
): Promise<JuplendPortfolioResponse> {
  return readJson<JuplendPortfolioResponse>(
    `${PORTFOLIO_BASE_URL}/positions/${walletAddress}?platforms=jupiter-exchange`,
    {
      headers: {
        "X-API-KEY": apiKey,
      },
    },
  );
}

function mapAccount(
  portfolio: JuplendPortfolioResponse,
  vaults: Map<string, JuplendVault>,
  receivedAt: number,
  positionId?: string,
): JuplendMappedAccount {
  const balances = new Map<string, BalanceAccumulator>();
  let totalCollateralUsd = new BigNumber(0);
  let totalDebtUsd = new BigNumber(0);
  let weightedLiquidationValueUsd = new BigNumber(0);

  for (const element of portfolio.elements ?? []) {
    const positionLink = extractPositionLink(element.data?.link);
    if (!positionLink) {
      continue;
    }

    if (positionId && positionLink.positionId !== positionId) {
      continue;
    }

    const vault = vaults.get(positionLink.vaultId);
    if (!vault) {
      continue;
    }

    const suppliedValue = toBigNumber(element.data?.suppliedValue);
    const borrowedValue = toBigNumber(element.data?.borrowedValue);
    const liquidationThreshold = normalizeThreshold(
      vault.liquidationThreshold ?? vault.loanToValue,
    );
    totalCollateralUsd = totalCollateralUsd.plus(suppliedValue);
    totalDebtUsd = totalDebtUsd.plus(borrowedValue);
    weightedLiquidationValueUsd = weightedLiquidationValueUsd.plus(
      suppliedValue.multipliedBy(liquidationThreshold),
    );

    const supplyAsset = tokenAsset(vault.supplyToken);
    const supplyPrice = tokenPrice(vault.supplyToken);
    if (supplyAsset && supplyPrice) {
      const accumulator = setAccumulator(balances, supplyAsset);
      accumulator.supplied = accumulator.supplied.plus(
        suppliedValue.dividedBy(supplyPrice),
      );
      accumulator.supplyAPY = toBigNumber(vault.supplyRate);
    }

    const borrowAsset = tokenAsset(vault.borrowToken);
    const borrowPrice = tokenPrice(vault.borrowToken);
    if (borrowAsset && borrowPrice) {
      const accumulator = setAccumulator(balances, borrowAsset);
      accumulator.borrowed = accumulator.borrowed.plus(
        borrowedValue.dividedBy(borrowPrice),
      );
      accumulator.borrowAPY = toBigNumber(vault.borrowRate);
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
    credentialsRequired: true,
  };
  readonly orderCapabilities: VenueOrderCapabilities = {
    supported: false,
    openOrders: "unsupported",
    updates: "unsupported",
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

  async bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap> {
    const receivedAt = Date.now();
    const apiKey = requireApiKey(credentials);
    const juplendOptions = getJuplendAccountOptions(accountOptions);
    const [portfolio, vaults] = await Promise.all([
      loadPortfolio(juplendOptions.walletAddress, apiKey),
      loadVaults(receivedAt),
    ]);
    const mapped = mapAccount(
      portfolio,
      vaults,
      receivedAt,
      juplendOptions.positionId,
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
    throw new AcexError(
      "VENUE_NOT_SUPPORTED",
      "Juplend is read-only and does not support createOrder",
    );
  }

  cancelOrder(
    _credentials: AccountCredentials,
    _request: CancelOrderRequest,
  ): Promise<RawOrderUpdate> {
    throw new AcexError(
      "VENUE_NOT_SUPPORTED",
      "Juplend is read-only and does not support cancelOrder",
    );
  }

  cancelAllOrders(
    _credentials: AccountCredentials,
    _request: CancelAllOrdersRequest,
  ): Promise<RawOrderUpdate[]> {
    throw new AcexError(
      "VENUE_NOT_SUPPORTED",
      "Juplend is read-only and does not support cancelAllOrders",
    );
  }

  createPrivateStream(
    credentials: AccountCredentials,
    callbacks: PrivateStreamCallbacks,
    options: PrivateStreamOptions,
    accountOptions?: Record<string, unknown>,
  ): StreamHandle {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollIntervalMs =
      options.juplendPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

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

export function resetJuplendVaultCacheForTests(): void {
  vaultCache = undefined;
  vaultCachePromise = undefined;
}
