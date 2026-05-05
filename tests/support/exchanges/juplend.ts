import { resetJuplendVaultCacheForTests } from "../../../src/adapters/juplend/private-adapter.ts";
import { stopAllClientsForTests } from "../../../src/client/runtime.ts";

export interface JuplendFetchRecord {
  method: string;
  url: URL;
  apiKey: string | null;
}

interface MutableJuplendState {
  portfolio?: unknown;
  vaults?: unknown;
  portfolioDelayMs?: number;
  activePortfolioRequests: number;
  maxActivePortfolioRequests: number;
}

export type MutableJuplendFetchRecords = JuplendFetchRecord[] & {
  state: MutableJuplendState;
};

export const JUPLEND_WALLET = "8xJuplendWallet11111111111111111111111111111";
export const JUPLEND_ACCOUNT_ID = "juplend-main-position-a";

export function installJuplendInfra(options?: {
  failPortfolio?: boolean;
  failVaults?: boolean;
  portfolio?: unknown;
  vaults?: unknown;
  portfolioDelayMs?: number;
}): MutableJuplendFetchRecords {
  const requests = [] as unknown as MutableJuplendFetchRecords;
  const state: MutableJuplendState = {
    portfolio: options?.portfolio,
    vaults: options?.vaults,
    portfolioDelayMs: options?.portfolioDelayMs,
    activePortfolioRequests: 0,
    maxActivePortfolioRequests: 0,
  };
  requests.state = state;
  stopAllClientsForTests();
  resetJuplendVaultCacheForTests();

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

      if (url.hostname === "api.jup.ag") {
        if (options?.failPortfolio) {
          return textResponse("portfolio unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        state.activePortfolioRequests += 1;
        state.maxActivePortfolioRequests = Math.max(
          state.maxActivePortfolioRequests,
          state.activePortfolioRequests,
        );
        try {
          if (state.portfolioDelayMs) {
            await Bun.sleep(state.portfolioDelayMs);
          }
          return jsonResponse(state.portfolio ?? juplendFixtures.portfolio);
        } finally {
          state.activePortfolioRequests -= 1;
        }
      }

      if (url.hostname === "lite-api.jup.ag") {
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

const juplendFixtures = {
  portfolio: {
    elements: [
      {
        data: {
          link: "https://jup.ag/lend/borrow/1/nfts/101",
          suppliedValue: "1000",
          borrowedValue: "250",
          value: "750",
        },
      },
      {
        data: {
          link: "https://jup.ag/lend/borrow/1/nfts/102",
          suppliedValue: "500",
          borrowedValue: "50",
          value: "450",
        },
      },
    ],
  },
  vaults: {
    data: [
      {
        id: "1",
        supplyToken: {
          symbol: "SOL",
          oraclePrice: "100",
        },
        borrowToken: {
          symbol: "USDC",
          oraclePrice: "1",
        },
        liquidationThreshold: 850,
        supplyRate: "0.05",
        borrowRate: "0.08",
      },
    ],
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(
  body: string,
  init: { status: number; statusText: string },
): Response {
  return new Response(body, init);
}
