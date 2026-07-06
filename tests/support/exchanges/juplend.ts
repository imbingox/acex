import type { JuplendBorrowPositionLike } from "../../../src/adapters/juplend/borrow-api.ts";
import { stopAllClientsForTests } from "../../../src/client/runtime.ts";
import { jsonResponse, textResponse } from "../test-utils.ts";

export interface JuplendFetchRecord {
  method: string;
  url: URL;
  apiKey: string | null;
}

interface MutableJuplendState {
  positions?: JuplendBorrowPositionLike[];
  positionsDelayMs?: number;
  activePositionRequests: number;
  maxActivePositionRequests: number;
}

export type MutableJuplendFetchRecords = JuplendFetchRecord[] & {
  state: MutableJuplendState;
};

export const JUPLEND_WALLET = "11111111111111111111111111111111";
export const JUPLEND_ACCOUNT_ID = "juplend-main-position-a";

export function installJuplendInfra(options?: {
  failPositions?: boolean;
  positions?: JuplendBorrowPositionLike[];
  positionsDelayMs?: number;
}): MutableJuplendFetchRecords {
  const requests = [] as unknown as MutableJuplendFetchRecords;
  const state: MutableJuplendState = {
    positions: options?.positions,
    positionsDelayMs: options?.positionsDelayMs,
    activePositionRequests: 0,
    maxActivePositionRequests: 0,
  };
  requests.state = state;

  stopAllClientsForTests();

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
        url.pathname === "/lend/v1/borrow/positions"
      ) {
        if (options?.failPositions) {
          return textResponse("positions unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
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

          return jsonResponse(state.positions ?? juplendFixtures.positions);
        } finally {
          state.activePositionRequests -= 1;
        }
      }

      throw new Error(`Unexpected Juplend fetch URL: ${url.toString()}`);
    },
  });

  return requests;
}

const juplendFixtures: {
  positions: JuplendBorrowPositionLike[];
} = {
  positions: [
    {
      id: 101,
      vaultId: 1,
      supply: "10000000000",
      borrow: "250000000",
      dustBorrow: "0",
      ownerAddress: JUPLEND_WALLET,
      vault: {
        id: 1,
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
    },
    {
      id: 102,
      vaultId: 1,
      supply: "5000000000",
      borrow: "50000000",
      dustBorrow: "0",
      ownerAddress: JUPLEND_WALLET,
      vault: {
        id: 1,
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
    },
  ],
};
