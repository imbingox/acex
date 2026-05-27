import {
  type JuplendPositionLike,
  type JuplendReadSdkLike,
  resetJuplendReadSdkForTests,
  setJuplendReadSdkForTests,
} from "../../../src/adapters/juplend/lend-read.ts";
import { resetJuplendVaultCacheForTests } from "../../../src/adapters/juplend/private-adapter.ts";
import { stopAllClientsForTests } from "../../../src/client/runtime.ts";
import { jsonResponse, textResponse } from "../test-utils.ts";

export interface JuplendFetchRecord {
  method: string;
  url: URL;
  apiKey: string | null;
}

interface MutableJuplendState {
  positions?: JuplendPositionLike[];
  vaults?: unknown;
  tokenSearch?: unknown;
  prices?: unknown;
  failTokenSearch: boolean;
  failPrices: boolean;
  positionsDelayMs?: number;
  activePositionRequests: number;
  maxActivePositionRequests: number;
  rpcUrls: string[];
  directPositionRequests: Array<{
    vaultId: number;
    nftId: number;
  }>;
}

export type MutableJuplendFetchRecords = JuplendFetchRecord[] & {
  state: MutableJuplendState;
};

export const JUPLEND_WALLET = "11111111111111111111111111111111";
export const JUPLEND_ACCOUNT_ID = "juplend-main-position-a";

export function installJuplendInfra(options?: {
  failPositions?: boolean;
  failVaults?: boolean;
  failTokenSearch?: boolean;
  failPrices?: boolean;
  positions?: JuplendPositionLike[];
  vaults?: unknown;
  tokenSearch?: unknown;
  prices?: unknown;
  positionsDelayMs?: number;
}): MutableJuplendFetchRecords {
  const requests = [] as unknown as MutableJuplendFetchRecords;
  const state: MutableJuplendState = {
    positions: options?.positions,
    vaults: options?.vaults,
    tokenSearch: options?.tokenSearch,
    prices: options?.prices,
    failTokenSearch: options?.failTokenSearch ?? false,
    failPrices: options?.failPrices ?? false,
    positionsDelayMs: options?.positionsDelayMs,
    activePositionRequests: 0,
    maxActivePositionRequests: 0,
    rpcUrls: [],
    directPositionRequests: [],
  };
  requests.state = state;

  stopAllClientsForTests();
  resetJuplendVaultCacheForTests();
  resetJuplendReadSdkForTests();

  const sdk: JuplendReadSdkLike = {
    createVaultReader(rpcUrl) {
      state.rpcUrls.push(rpcUrl);

      return {
        async getAllUserPositions() {
          if (options?.failPositions) {
            throw new Error("positions unavailable");
          }

          state.activePositionRequests += 1;
          state.maxActivePositionRequests = Math.max(
            state.maxActivePositionRequests,
            state.activePositionRequests,
          );

          try {
            if (state.positionsDelayMs) {
              await Bun.sleep(state.positionsDelayMs);
            }

            return (state.positions ??
              juplendFixtures.positions) as JuplendPositionLike[];
          } finally {
            state.activePositionRequests -= 1;
          }
        },
        async getPositionByVaultId(vaultId, nftId) {
          if (options?.failPositions) {
            throw new Error("positions unavailable");
          }

          state.directPositionRequests.push({ vaultId, nftId });
          const positions = (state.positions ??
            juplendFixtures.positions) as JuplendPositionLike[];
          const matched = positions.find(
            (position) =>
              position.nftId === nftId &&
              position.vault.constantViews.vaultId === vaultId,
          );
          if (!matched) {
            throw new Error(`position not found: ${vaultId}/${nftId}`);
          }

          return matched;
        },
      };
    },
  };

  setJuplendReadSdkForTests(sdk);

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(rawUrl);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );

      requests.push({
        method,
        url,
        apiKey: headers.get("X-API-KEY"),
      });

      if (
        url.hostname === "api.jup.ag" &&
        url.pathname === "/tokens/v2/search"
      ) {
        if (state.failTokenSearch) {
          return textResponse("token search unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }

        return jsonResponse(state.tokenSearch ?? juplendFixtures.tokenSearch);
      }

      if (url.hostname === "api.jup.ag" && url.pathname === "/price/v3") {
        if (state.failPrices) {
          return textResponse("prices unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }

        return jsonResponse(state.prices ?? juplendFixtures.prices);
      }

      if (
        url.hostname === "lite-api.jup.ag" &&
        url.pathname === "/lend/v1/borrow/vaults"
      ) {
        if (options?.failVaults) {
          return textResponse("vaults unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }

        return jsonResponse(state.vaults ?? juplendFixtures.vaults);
      }

      throw new Error(`Unexpected Juplend fetch URL: ${url.toString()}`);
    },
  });

  return requests;
}

const juplendFixtures: {
  positions: JuplendPositionLike[];
  vaults: unknown[];
  tokenSearch: unknown[];
  prices: Record<string, unknown>;
} = {
  positions: [
    {
      nftId: 101,
      supply: "10000000000",
      borrow: "250000000000",
      dustBorrow: "0",
      vault: {
        constantViews: {
          vaultId: 1,
          supplyToken: "So11111111111111111111111111111111111111112",
          borrowToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
        configs: {
          liquidationThreshold: "850",
        },
        exchangePricesAndRates: {
          supplyRateVault: "554",
          borrowRateVault: "513",
        },
      },
    },
    {
      nftId: 102,
      supply: "5000000000",
      borrow: "50000000000",
      dustBorrow: "0",
      vault: {
        constantViews: {
          vaultId: 1,
          supplyToken: "So11111111111111111111111111111111111111112",
          borrowToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
        configs: {
          liquidationThreshold: "850",
        },
        exchangePricesAndRates: {
          supplyRateVault: "554",
          borrowRateVault: "513",
        },
      },
    },
  ],
  vaults: [
    {
      id: "1",
      supplyToken: {
        address: "So11111111111111111111111111111111111111112",
        symbol: "WSOL",
        uiSymbol: "SOL",
        decimals: 9,
        price: "100",
      },
      borrowToken: {
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        symbol: "USDC",
        uiSymbol: "USDC",
        decimals: 6,
        price: "1",
      },
      liquidationThreshold: "850",
      supplyRate: "554",
      borrowRate: "513",
    },
  ],
  tokenSearch: [
    {
      id: "So11111111111111111111111111111111111111112",
      symbol: "SOL",
      decimals: 9,
      usdPrice: "100",
    },
    {
      id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
      usdPrice: "1",
    },
  ],
  prices: {
    So11111111111111111111111111111111111111112: {
      usdPrice: "100",
      decimals: 9,
    },
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
      usdPrice: "1",
      decimals: 6,
    },
  },
};
