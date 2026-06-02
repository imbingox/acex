import BigNumber from "bignumber.js";
import { AcexError } from "../../errors.ts";
import {
  type HttpClientMessages,
  httpRequest,
} from "../../internal/http-client.ts";
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
import { readJuplendPositions } from "./lend-read.ts";

interface JuplendTokenMetadata {
  address?: string;
  id?: string;
  symbol?: string;
  uiSymbol?: string;
  decimals?: number | string;
  price?: number | string;
  usdPrice?: number | string;
  oraclePrice?: number | string;
}

interface JuplendVaultMetadata {
  id?: number | string;
  vaultId?: number | string;
  supplyToken?: JuplendTokenMetadata;
  borrowToken?: JuplendTokenMetadata;
  liquidationThreshold?: number | string;
  supplyRate?: number | string;
  borrowRate?: number | string;
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
  walletAddress?: string;
  vaultId?: string;
  positionId?: string;
}

interface JuplendPriceApiEntry {
  usdPrice?: number | string;
  price?: number | string;
  decimals?: number | string;
}

type FetchLike = typeof fetch;

interface JuplendTokenSearchEntry {
  id?: string;
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number | string;
  usdPrice?: number | string;
}

const JUP_API_BASE_URL = "https://api.jup.ag";
const JUP_LITE_API_BASE_URL = "https://lite-api.jup.ag";
const TOKENS_SEARCH_PATH = "/tokens/v2/search";
const PRICE_V3_PATH = "/price/v3";
const LEND_VAULTS_PATH = "/lend/v1/borrow/vaults";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
// lend-read returns exchange-price-adjusted amounts on a fixed 1e9 scale,
// not mint-atomic token amounts.
const POSITION_AMOUNT_SCALE_DECIMALS = 9;
const VAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const JUPLEND_HTTP_MESSAGES: HttpClientMessages = {
  http: ({ status, statusText }) => `Juplend HTTP ${status}: ${statusText}`,
  timeout: () => `Juplend fetch timeout after ${DEFAULT_HTTP_TIMEOUT_MS}ms`,
  aborted: () => "Juplend fetch aborted",
};

interface JuplendVaultEnrichmentCacheEntry {
  loadedAt: number;
  vaults: Map<string, JuplendVaultMetadata>;
  enriched: boolean;
}

let enrichmentCache = new Map<string, JuplendVaultEnrichmentCacheEntry>();
let enrichmentCachePromise = new Map<
  string,
  Promise<Map<string, JuplendVaultMetadata>>
>();

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

  const hasWalletAddress = Boolean(walletAddress);
  const hasDirectPosition = Boolean(vaultId && positionId);
  if (!hasWalletAddress && !hasDirectPosition) {
    throw new Error(
      "options.walletAddress or options.vaultId + options.positionId required",
    );
  }

  return {
    walletAddress: walletAddress || undefined,
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

function getVaultId(vault: JuplendVaultMetadata): string | undefined {
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

async function requestJuplendJson<T>(
  url: string,
  init: RequestInit | undefined,
  fetchFn: FetchLike | undefined,
  timeoutMs: number,
): Promise<T> {
  const response = await httpRequest<T>({
    fetchFn,
    url,
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
    signal: init?.signal ?? undefined,
    timeoutMs,
    parseAs: "json",
    jsonParseMode: "response",
    retryPolicy: {
      idempotent: true,
      maxAttempts: 3,
    },
    messages: JUPLEND_HTTP_MESSAGES,
  });

  return response.body;
}

function getJupApiKey(explicitApiKey?: string): string | undefined {
  return explicitApiKey || process.env.JUP_API || undefined;
}

function getEnrichmentCacheKey(apiKey?: string): string {
  return apiKey || "__no_jup_api_key__";
}

function buildApiHeaders(apiKey?: string): Record<string, string> | undefined {
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

function withBaseUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString();
}

async function loadVaultMetadataFromLiteApi(
  apiKey?: string,
  fetchFn?: FetchLike,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Map<string, JuplendVaultMetadata>> {
  const response = await requestJuplendJson<
    JuplendVaultMetadata[] | { data?: JuplendVaultMetadata[] }
  >(
    withBaseUrl(JUP_LITE_API_BASE_URL, LEND_VAULTS_PATH),
    {
      headers: buildApiHeaders(apiKey),
    },
    fetchFn,
    timeoutMs,
  );
  const rawVaults = Array.isArray(response) ? response : response.data;
  const vaults = new Map<string, JuplendVaultMetadata>();

  for (const vault of rawVaults ?? []) {
    const id = getVaultId(vault);
    if (id) {
      vaults.set(id, vault);
    }
  }

  return vaults;
}

async function loadTokenSearchMap(
  mintAddresses: string[],
  apiKey?: string,
  fetchFn?: FetchLike,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Map<string, JuplendTokenMetadata>> {
  if (mintAddresses.length === 0) {
    return new Map();
  }

  const query = encodeURIComponent(mintAddresses.join(","));
  const response = await requestJuplendJson<JuplendTokenSearchEntry[]>(
    `${withBaseUrl(JUP_API_BASE_URL, TOKENS_SEARCH_PATH)}?query=${query}`,
    {
      headers: buildApiHeaders(apiKey),
    },
    fetchFn,
    timeoutMs,
  );

  const tokens = new Map<string, JuplendTokenMetadata>();
  for (const token of response ?? []) {
    const mint = token.id ?? token.address;
    if (!mint) {
      continue;
    }

    tokens.set(mint, {
      address: mint,
      id: mint,
      symbol: token.symbol,
      uiSymbol: token.symbol,
      decimals: token.decimals,
      usdPrice: token.usdPrice,
      oraclePrice: token.usdPrice,
    });
  }

  return tokens;
}

async function loadPriceMap(
  mintAddresses: string[],
  apiKey?: string,
  fetchFn?: FetchLike,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Map<string, JuplendPriceApiEntry>> {
  if (mintAddresses.length === 0) {
    return new Map();
  }

  const ids = encodeURIComponent(mintAddresses.join(","));
  const response = await requestJuplendJson<
    Record<string, JuplendPriceApiEntry>
  >(
    `${withBaseUrl(JUP_API_BASE_URL, PRICE_V3_PATH)}?ids=${ids}`,
    {
      headers: buildApiHeaders(apiKey),
    },
    fetchFn,
    timeoutMs,
  );

  return new Map(Object.entries(response ?? {}));
}

function mergeTokenMetadata(
  baseToken: JuplendTokenMetadata | undefined,
  searchedToken: JuplendTokenMetadata | undefined,
  pricedToken: JuplendPriceApiEntry | undefined,
): JuplendTokenMetadata | undefined {
  if (!baseToken && !searchedToken && !pricedToken) {
    return undefined;
  }

  return {
    ...baseToken,
    ...searchedToken,
    price:
      pricedToken?.usdPrice ??
      pricedToken?.price ??
      searchedToken?.usdPrice ??
      baseToken?.usdPrice ??
      baseToken?.price ??
      baseToken?.oraclePrice,
    usdPrice:
      pricedToken?.usdPrice ??
      pricedToken?.price ??
      searchedToken?.usdPrice ??
      baseToken?.usdPrice ??
      baseToken?.price ??
      baseToken?.oraclePrice,
    oraclePrice: baseToken?.oraclePrice,
    decimals:
      searchedToken?.decimals ?? pricedToken?.decimals ?? baseToken?.decimals,
  };
}

async function enrichVaultsWithJupApi(input: {
  apiKey?: string;
  baseVaults: Map<string, JuplendVaultMetadata>;
  fetchFn?: FetchLike;
  timeoutMs: number;
}): Promise<Map<string, JuplendVaultMetadata>> {
  const mintAddresses = new Set<string>();
  for (const vault of input.baseVaults.values()) {
    const supplyMint = vault.supplyToken?.address;
    const borrowMint = vault.borrowToken?.address;
    if (supplyMint) {
      mintAddresses.add(supplyMint);
    }
    if (borrowMint) {
      mintAddresses.add(borrowMint);
    }
  }

  const [tokenMap, priceMap] = await Promise.all([
    loadTokenSearchMap(
      [...mintAddresses],
      input.apiKey,
      input.fetchFn,
      input.timeoutMs,
    ),
    loadPriceMap(
      [...mintAddresses],
      input.apiKey,
      input.fetchFn,
      input.timeoutMs,
    ),
  ]);

  const enriched = new Map<string, JuplendVaultMetadata>();
  for (const [vaultId, vault] of input.baseVaults.entries()) {
    const supplyMint = vault.supplyToken?.address;
    const borrowMint = vault.borrowToken?.address;

    enriched.set(vaultId, {
      ...vault,
      supplyToken: mergeTokenMetadata(
        vault.supplyToken,
        supplyMint ? tokenMap.get(supplyMint) : undefined,
        supplyMint ? priceMap.get(supplyMint) : undefined,
      ),
      borrowToken: mergeTokenMetadata(
        vault.borrowToken,
        borrowMint ? tokenMap.get(borrowMint) : undefined,
        borrowMint ? priceMap.get(borrowMint) : undefined,
      ),
    });
  }

  return enriched;
}

async function loadVaults(
  now: number,
  apiKey?: string,
  fetchFn?: FetchLike,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Map<string, JuplendVaultMetadata>> {
  const cacheKey = getEnrichmentCacheKey(apiKey);
  const cached = enrichmentCache.get(cacheKey);
  const cacheFresh =
    cached !== undefined && now - cached.loadedAt < VAULT_CACHE_TTL_MS;
  if (cacheFresh && (cached.enriched || !apiKey)) {
    return cached.vaults;
  }

  const inflight = enrichmentCachePromise.get(cacheKey);
  if (!inflight) {
    const nextPromise = (async () => {
      const baseVaults = await loadVaultMetadataFromLiteApi(
        apiKey,
        fetchFn,
        timeoutMs,
      );
      if (!apiKey) {
        enrichmentCache.set(cacheKey, {
          loadedAt: now,
          vaults: baseVaults,
          enriched: false,
        });
        return baseVaults;
      }

      try {
        const enrichedVaults = await enrichVaultsWithJupApi({
          apiKey,
          baseVaults,
          fetchFn,
          timeoutMs,
        });
        enrichmentCache.set(cacheKey, {
          loadedAt: now,
          vaults: enrichedVaults,
          enriched: true,
        });
        return enrichedVaults;
      } catch {
        return baseVaults;
      }
    })().finally(() => {
      enrichmentCachePromise.delete(cacheKey);
    });

    enrichmentCachePromise.set(cacheKey, nextPromise);
  }

  try {
    return await (enrichmentCachePromise.get(cacheKey) as Promise<
      Map<string, JuplendVaultMetadata>
    >);
  } catch (error) {
    const fallbackCached = enrichmentCache.get(cacheKey);
    if (fallbackCached) {
      return fallbackCached.vaults;
    }
    throw error;
  }
}

function dividePositionAmount(value: BigNumber): BigNumber {
  return value.dividedBy(new BigNumber(10).pow(POSITION_AMOUNT_SCALE_DECIMALS));
}

async function mapAccount(
  accountOptions: JuplendAccountOptions,
  receivedAt: number,
  rpcUrl: string | undefined,
  jupApiKey: string | undefined,
  fetchFn: FetchLike | undefined,
  timeoutMs: number,
): Promise<JuplendMappedAccount> {
  const [vaults, positionResult] = await Promise.all([
    loadVaults(receivedAt, jupApiKey, fetchFn, timeoutMs),
    readJuplendPositions({
      walletAddress: accountOptions.walletAddress,
      vaultId: accountOptions.vaultId,
      positionId: accountOptions.positionId,
      explicitRpcUrl: rpcUrl,
    }),
  ]);

  const balances = new Map<string, BalanceAccumulator>();
  let totalCollateralUsd = new BigNumber(0);
  let totalDebtUsd = new BigNumber(0);
  let weightedLiquidationValueUsd = new BigNumber(0);

  for (const position of positionResult.positions) {
    if (
      accountOptions.walletAddress &&
      accountOptions.positionId &&
      position.nftId !== accountOptions.positionId
    ) {
      continue;
    }

    const vault = vaults.get(position.vaultId);
    const suppliedQuantity = dividePositionAmount(
      toBigNumber(position.supplyAmount),
    );
    const borrowedQuantity = dividePositionAmount(
      toBigNumber(position.borrowAmount),
    );

    const liquidationThreshold = normalizeThreshold(
      position.liquidationThresholdRaw ?? vault?.liquidationThreshold,
    );

    const supplyAsset =
      tokenAsset(vault?.supplyToken) ?? vault?.supplyToken?.address;
    if (supplyAsset) {
      const accumulator = setAccumulator(balances, supplyAsset);
      accumulator.supplied = accumulator.supplied.plus(suppliedQuantity);
      accumulator.supplyAPY =
        normalizeRate(vault?.supplyRate ?? position.supplyRateRaw) ??
        accumulator.supplyAPY;
    }

    const borrowAsset =
      tokenAsset(vault?.borrowToken) ?? vault?.borrowToken?.address;
    if (borrowAsset) {
      const accumulator = setAccumulator(balances, borrowAsset);
      accumulator.borrowed = accumulator.borrowed.plus(borrowedQuantity);
      accumulator.borrowAPY =
        normalizeRate(vault?.borrowRate ?? position.borrowRateRaw) ??
        accumulator.borrowAPY;
    }

    const supplyPrice = tokenPrice(vault?.supplyToken);
    if (supplyPrice) {
      const collateralUsd = suppliedQuantity.multipliedBy(supplyPrice);
      totalCollateralUsd = totalCollateralUsd.plus(collateralUsd);
      weightedLiquidationValueUsd = weightedLiquidationValueUsd.plus(
        collateralUsd.multipliedBy(liquidationThreshold),
      );
    }

    const borrowPrice = tokenPrice(vault?.borrowToken);
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
    credentialsRequired: false,
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

  constructor(
    private readonly rpcUrl?: string,
    private readonly jupApiKey?: string,
    private readonly options: {
      readonly fetchFn?: FetchLike;
      readonly httpTimeoutMs?: number;
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
      this.rpcUrl,
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
  enrichmentCache = new Map<string, JuplendVaultEnrichmentCacheEntry>();
  enrichmentCachePromise = new Map<
    string,
    Promise<Map<string, JuplendVaultMetadata>>
  >();
}
