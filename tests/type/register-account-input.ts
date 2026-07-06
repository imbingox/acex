import type { RegisterAccountInput } from "../../src/types/index.ts";

const binanceAccount: RegisterAccountInput = {
  accountId: "main-binance",
  venue: "binance",
  credentials: {
    apiKey: "key",
    secret: "secret",
  },
  options: {
    timestamp: 1710000000000,
    recvWindow: 5000,
  },
};

const juplendAccount: RegisterAccountInput = {
  accountId: "jup-loop-a",
  venue: "juplend",
  options: {
    walletAddress: "wallet",
    positionId: "101",
  },
};

const juplendFilteredPositionAccount: RegisterAccountInput = {
  accountId: "jup-loop-filtered",
  venue: "juplend",
  options: {
    walletAddress: "wallet",
    vaultId: "1",
    positionId: "101",
  },
};

const juplendDirectPositionAccount: RegisterAccountInput = {
  accountId: "jup-loop-direct",
  venue: "juplend",
  // @ts-expect-error Juplend must provide walletAddress.
  options: {
    vaultId: "1",
    positionId: "101",
  },
};

// @ts-expect-error Juplend must provide walletAddress.
const juplendMissingWallet: RegisterAccountInput = {
  accountId: "jup-loop-a",
  venue: "juplend",
};

void binanceAccount;
void juplendAccount;
void juplendFilteredPositionAccount;
void juplendDirectPositionAccount;
void juplendMissingWallet;
