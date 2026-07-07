import {
  type HttpClientMessages,
  httpRequest,
} from "../../internal/http-client.ts";

type FetchLike = typeof fetch;

interface StringLike {
  toString(): string;
}

export interface JuplendTokenMetadata {
  address?: string;
  id?: string;
  symbol?: string;
  uiSymbol?: string;
  decimals?: number | string | null;
  price?: number | string;
}

export interface JuplendVaultMetadata {
  id?: number | string;
  vaultId?: number | string;
  supplyToken?: JuplendTokenMetadata;
  borrowToken?: JuplendTokenMetadata;
  liquidationThreshold?: number | string;
  supplyRate?: number | string;
  borrowRate?: number | string;
}

export interface JuplendBorrowPositionLike {
  id?: number | string;
  nftId?: number | string;
  vaultId?: number | string;
  supply?: StringLike | string | number | null;
  borrow?: StringLike | string | number | null;
  dustBorrow?: StringLike | string | number | null;
  ownerAddress?: string;
  vault?: JuplendVaultMetadata;
}

export interface JuplendReadPosition {
  nftId: string;
  vaultId: string;
  ownerAddress?: string;
  supplyAmount: string;
  borrowAmount: string;
  dustBorrowAmount: string;
  vault: JuplendVaultMetadata;
}

const JUP_LEND_API_BASE_URL = "https://api.jup.ag/lend/v1";
const BORROW_POSITIONS_PATH = "borrow/positions";
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

function getJuplendHttpMessages(timeoutMs: number): HttpClientMessages {
  return {
    http: ({ status, statusText }) => `Juplend HTTP ${status}: ${statusText}`,
    timeout: () => `Juplend fetch timeout after ${timeoutMs}ms`,
    aborted: () => "Juplend fetch aborted",
  };
}

function buildApiHeaders(apiKey?: string): Record<string, string> | undefined {
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

export function getJupApiKey(explicitApiKey?: string): string | undefined {
  return explicitApiKey || process.env.JUP_API || undefined;
}

function withBaseUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString();
}

function asString(
  value: StringLike | string | number | null | undefined,
): string {
  return value === undefined || value === null ? "0" : value.toString();
}

function getPositionNftId(position: JuplendBorrowPositionLike): string {
  const id = position.id ?? position.nftId;
  if (id === undefined) {
    throw new Error("Juplend position missing id");
  }

  return `${id}`;
}

function getPositionVaultId(position: JuplendBorrowPositionLike): string {
  const id = position.vaultId ?? position.vault?.id ?? position.vault?.vaultId;
  if (id === undefined) {
    throw new Error("Juplend position missing vaultId");
  }

  return `${id}`;
}

function mapReadPosition(
  position: JuplendBorrowPositionLike,
): JuplendReadPosition {
  const vaultId = getPositionVaultId(position);

  return {
    nftId: getPositionNftId(position),
    vaultId,
    ownerAddress: position.ownerAddress,
    supplyAmount: asString(position.supply),
    borrowAmount: asString(position.borrow),
    dustBorrowAmount: asString(position.dustBorrow),
    vault: {
      ...position.vault,
      id: position.vault?.id ?? vaultId,
      vaultId: position.vault?.vaultId ?? vaultId,
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
    messages: getJuplendHttpMessages(timeoutMs),
  });

  return response.body;
}

export async function readJuplendPositions(input: {
  walletAddress?: string;
  vaultId?: string;
  positionId?: string;
  jupApiKey?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}): Promise<{
  positions: JuplendReadPosition[];
}> {
  if (!input.walletAddress) {
    throw new Error("Juplend read requires options.walletAddress");
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const url = new URL(
    withBaseUrl(JUP_LEND_API_BASE_URL, BORROW_POSITIONS_PATH),
  );
  url.searchParams.set("users", input.walletAddress);

  const rawPositions = await requestJuplendJson<JuplendBorrowPositionLike[]>(
    url.toString(),
    {
      headers: buildApiHeaders(input.jupApiKey),
    },
    input.fetchFn,
    timeoutMs,
  );

  const positions = rawPositions.map((position) => mapReadPosition(position));
  return {
    positions: positions.filter((position) => {
      if (input.vaultId && position.vaultId !== input.vaultId) {
        return false;
      }
      if (input.positionId && position.nftId !== input.positionId) {
        return false;
      }
      return true;
    }),
  };
}
