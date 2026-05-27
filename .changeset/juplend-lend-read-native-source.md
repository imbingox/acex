---
"@imbingox/acex": minor
---

Replace Juplend's portfolio-backed lending account implementation with native `@jup-ag/lend-read` reads. Juplend accounts no longer require credentials, can be loaded by `walletAddress` or direct `vaultId + positionId`, support optional RPC and Jup API enrichment via `SOL_HELIUS_RPC` / `account.juplend.rpcUrl` and `JUP_API` / `account.juplend.jupApiKey`, and now report more accurate lending balances, debt, collateral, and risk data from native vault sources.
