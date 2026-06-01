# @imbingox/acex

## 0.3.1-beta.0

### Patch Changes

- 19f60bc: Binance 行情订阅现在复用 WebSocket 连接：同一 connectionKey / base URL 下多个 symbol 复用物理连接（例如 USDM L1 与 funding 因 base URL 不同会分开），通过 JSON `SUBSCRIBE`/`UNSUBSCRIBE` 动态增删订阅，断线重连后自动重放，单连接订阅数达上限会自动开新连接。行情层改为按 venue 分派 adapter，为接入更多交易所打基础。公开 API 不变。

## 0.3.0

### Minor Changes

- 14d25cb: 重命名账户风险权益字段并拆分净值与风控口径。`RiskSnapshot.equity` 替换为 `netEquity` / `riskEquity`，`actualLeverage` 替换为 `riskLeverage`；Binance 使用 `actualEquity` / `accountEquity` 分别映射净权益和风控折算权益，Juplend 使用清算阈值折算权益填充 `riskEquity`。
- 50e4e09: 通过周期性 REST polling 刷新 Binance 账户风险和 mark-to-market 仓位字段。`RiskSnapshot` 现在暴露风控口径的 `riskLeverage`，Binance 账户运行时配置新增 `account.binance.riskPollIntervalMs`。
- 680e315: Add strict-symbol market data aggregation APIs for markets, L1 books, and funding rates. Also update Binance USDⓈ-M funding mark price streams to use the current market websocket endpoint and default 3s `markPrice` stream.
- 68356a0: Replace Juplend's portfolio-backed lending account implementation with native `@jup-ag/lend-read` reads. Juplend accounts no longer require credentials, can be loaded by `walletAddress` or direct `vaultId + positionId`, support optional RPC and Jup API enrichment via `SOL_HELIUS_RPC` / `account.juplend.rpcUrl` and `JUP_API` / `account.juplend.jupApiKey`, and now report more accurate lending balances, debt, collateral, and risk data from native vault sources.
- c411b69: Add venue-based account registration and Juplend read-only lending account support. `Exchange` is renamed to `Venue`, account risk now uses unified `riskRatio`, and `RegisterAccountInput` is venue-specific so Juplend requires `credentials.apiKey` plus `options.walletAddress` with optional `positionId` filtering. Juplend account polling exposes lending balance/risk facets, replaces full snapshots to clear closed positions, and includes live smoke coverage.
- 9dad2f0: Add post-only limit order support and market order input normalization. Binance PAPI UM limit orders now map `postOnly: true` to `timeInForce=GTX`, and callers can normalize price and amount strings with `market.normalizeOrderInput()` before placing orders.
- ea9a4a7: Add top-level venue capability queries for SDK runtime support by venue.

### Patch Changes

- 46d1291: Include `docs/api.md` in the published npm package.

## 0.3.0-beta.6

### Minor Changes

- 68356a0: Replace Juplend's portfolio-backed lending account implementation with native `@jup-ag/lend-read` reads. Juplend accounts no longer require credentials, can be loaded by `walletAddress` or direct `vaultId + positionId`, support optional RPC and Jup API enrichment via `SOL_HELIUS_RPC` / `account.juplend.rpcUrl` and `JUP_API` / `account.juplend.jupApiKey`, and now report more accurate lending balances, debt, collateral, and risk data from native vault sources.

## 0.3.0-beta.5

### Minor Changes

- 14d25cb: 重命名账户风险权益字段并拆分净值与风控口径。`RiskSnapshot.equity` 替换为 `netEquity` / `riskEquity`，`actualLeverage` 替换为 `riskLeverage`；Binance 使用 `actualEquity` / `accountEquity` 分别映射净权益和风控折算权益，Juplend 使用清算阈值折算权益填充 `riskEquity`。

## 0.3.0-beta.4

### Minor Changes

- 50e4e09: 通过周期性 REST polling 刷新 Binance 账户风险和 mark-to-market 仓位字段。`RiskSnapshot` 现在暴露 `actualLeverage`，Binance 账户运行时配置新增 `account.binance.riskPollIntervalMs`。

## 0.3.0-beta.3

### Minor Changes

- ea9a4a7: Add top-level venue capability queries for SDK runtime support by venue.

### Patch Changes

- 46d1291: Include `docs/api.md` in the published npm package.

## 0.3.0-beta.2

### Minor Changes

- c411b69: Add venue-based account registration and Juplend read-only lending account support. `Exchange` is renamed to `Venue`, account risk now uses unified `riskRatio`, and `RegisterAccountInput` is venue-specific so Juplend requires `credentials.apiKey` plus `options.walletAddress` with optional `positionId` filtering. Juplend account polling exposes lending balance/risk facets, replaces full snapshots to clear closed positions, and includes live smoke coverage.

## 0.3.0-beta.1

### Minor Changes

- 9dad2f0: Add post-only limit order support and market order input normalization. Binance PAPI UM limit orders now map `postOnly: true` to `timeInForce=GTX`, and callers can normalize price and amount strings with `market.normalizeOrderInput()` before placing orders.

## 0.3.0-beta.0

### Minor Changes

- 680e315: Add strict-symbol market data aggregation APIs for markets, L1 books, and funding rates. Also update Binance USDⓈ-M funding mark price streams to use the current market websocket endpoint and default 3s `markPrice` stream.

## 0.2.0

### Minor Changes

- 5dcc3c1: Add Binance funding rate market data stream with per-stream market data status.
- baeab15: Add Binance PAPI private account and order support, including the first `createOrder`, `cancelOrder`, and `cancelAllOrders` APIs.

## 0.1.0-beta.4

### Minor Changes

- 5dcc3c1: Add Binance funding rate market data stream with per-stream market data status.

## 0.1.0-beta.3

### Minor Changes

- baeab15: Add Binance PAPI private account and order support, including the first `createOrder`, `cancelOrder`, and `cancelAllOrders` APIs.
