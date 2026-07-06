---
"@imbingox/acex": major
---

Juplend account reads now use Jupiter's official Borrow REST API instead of `@jup-ag/lend-read`.

Migration: `venue: "juplend"` accounts must pass `options.walletAddress`; `vaultId` and `positionId` are now local filters over the wallet's returned borrow positions. `account.venues.juplend.rpcUrl` is removed because the reader no longer connects to Solana RPC.
