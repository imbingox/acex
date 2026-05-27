---
"@imbingox/acex": minor
---

Add native Juplend read-only lending account support powered by `@jup-ag/lend-read`. Juplend accounts no longer require credentials, can be registered by `walletAddress` or direct `vaultId + positionId`, and now expose more accurate lending balances and risk data from on-chain reads. The Juplend account runtime also supports explicit `account.juplend.rpcUrl` / `SOL_HELIUS_RPC`, optional Jup token metadata and price enrichment via `account.juplend.jupApiKey` / `JUP_API`, and full-snapshot polling that clears closed positions.
