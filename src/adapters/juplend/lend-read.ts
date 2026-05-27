import { Client, DEFAULT_RPC_URL } from "@jup-ag/lend-read";
import { PublicKey } from "@solana/web3.js";

interface StringLike {
  toString(): string;
}

export interface JuplendVaultLike {
  constantViews: {
    vaultId: number;
    supplyToken: StringLike;
    borrowToken: StringLike;
  };
  configs: {
    liquidationThreshold: StringLike;
  };
  exchangePricesAndRates: {
    supplyRateVault: StringLike;
    borrowRateVault: StringLike;
  };
}

export interface JuplendPositionLike {
  nftId: number;
  supply: StringLike;
  borrow: StringLike;
  dustBorrow: StringLike;
  vault: JuplendVaultLike;
}

export interface JuplendVaultReader {
  getAllUserPositions(user: PublicKey): Promise<JuplendPositionLike[]>;
  getPositionByVaultId(
    vaultId: number,
    nftId: number,
  ): Promise<JuplendPositionLike>;
}

export interface JuplendReadSdkLike {
  createVaultReader(rpcUrl: string): JuplendVaultReader;
}

export interface JuplendReadPosition {
  nftId: string;
  vaultId: string;
  supplyAmount: string;
  borrowAmount: string;
  dustBorrowAmount: string;
  liquidationThresholdRaw: string;
  supplyRateRaw: string;
  borrowRateRaw: string;
  supplyMintAddress: string;
  borrowMintAddress: string;
}

const defaultSdk: JuplendReadSdkLike = {
  createVaultReader(rpcUrl: string): JuplendVaultReader {
    return new Client(rpcUrl).vault;
  },
};

let activeSdk: JuplendReadSdkLike = defaultSdk;
let readerCache = new Map<string, JuplendVaultReader>();

export function getJuplendRpcUrl(explicitRpcUrl?: string): string {
  return explicitRpcUrl || process.env.SOL_HELIUS_RPC || DEFAULT_RPC_URL;
}

function getVaultReader(rpcUrl: string): JuplendVaultReader {
  const cached = readerCache.get(rpcUrl);
  if (cached) {
    return cached;
  }

  const created = activeSdk.createVaultReader(rpcUrl);
  readerCache.set(rpcUrl, created);
  return created;
}

function toJuplendId(value: string, field: "vaultId" | "positionId"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid Juplend ${field}: ${value}`);
  }

  return parsed;
}

function mapReadPosition(position: JuplendPositionLike): JuplendReadPosition {
  const vaultId = position.vault.constantViews.vaultId;

  return {
    nftId: `${position.nftId}`,
    vaultId: `${vaultId}`,
    supplyAmount: position.supply.toString(),
    borrowAmount: position.borrow.toString(),
    dustBorrowAmount: position.dustBorrow.toString(),
    liquidationThresholdRaw:
      position.vault.configs.liquidationThreshold.toString(),
    supplyRateRaw:
      position.vault.exchangePricesAndRates.supplyRateVault.toString(),
    borrowRateRaw:
      position.vault.exchangePricesAndRates.borrowRateVault.toString(),
    supplyMintAddress: position.vault.constantViews.supplyToken.toString(),
    borrowMintAddress: position.vault.constantViews.borrowToken.toString(),
  };
}

export async function readJuplendPositions(input: {
  walletAddress?: string;
  vaultId?: string;
  positionId?: string;
  explicitRpcUrl?: string;
}): Promise<{
  rpcUrl: string;
  positions: JuplendReadPosition[];
}> {
  const rpcUrl = getJuplendRpcUrl(input.explicitRpcUrl);
  const reader = getVaultReader(rpcUrl);
  const rawPositions =
    input.vaultId && input.positionId
      ? [
          await reader.getPositionByVaultId(
            toJuplendId(input.vaultId, "vaultId"),
            toJuplendId(input.positionId, "positionId"),
          ),
        ]
      : input.walletAddress
        ? await reader.getAllUserPositions(new PublicKey(input.walletAddress))
        : (() => {
            throw new Error(
              "Juplend read requires options.walletAddress or options.vaultId + options.positionId",
            );
          })();

  return {
    rpcUrl,
    positions: rawPositions.map((position) => mapReadPosition(position)),
  };
}

export function setJuplendReadSdkForTests(sdk: JuplendReadSdkLike): void {
  activeSdk = sdk;
  readerCache = new Map<string, JuplendVaultReader>();
}

export function resetJuplendReadSdkForTests(): void {
  activeSdk = defaultSdk;
  readerCache = new Map<string, JuplendVaultReader>();
}
