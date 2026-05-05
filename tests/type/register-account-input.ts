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
  credentials: {
    apiKey: "key",
  },
  options: {
    walletAddress: "wallet",
    positionId: "101",
  },
};

// @ts-expect-error Juplend must provide walletAddress in options.
const juplendMissingWallet: RegisterAccountInput = {
  accountId: "jup-loop-a",
  venue: "juplend",
  credentials: {
    apiKey: "key",
  },
};

// @ts-expect-error Juplend credentials require apiKey.
const juplendMissingApiKey: RegisterAccountInput = {
  accountId: "jup-loop-a",
  venue: "juplend",
  credentials: {},
  options: {
    walletAddress: "wallet",
  },
};

void binanceAccount;
void juplendAccount;
void juplendMissingWallet;
void juplendMissingApiKey;
