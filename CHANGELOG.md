# @imbingox/acex

## 0.4.0-beta.7

### Minor Changes

- dac87aa: Add `client.market.fetchServerTime(venue)` with Binance USDM server-time support, RTT measurement, estimated clock offset, venue capability reporting, and a structured failure code.

## 0.4.0-beta.6

### Minor Changes

- f65bab7: 新增 `client.market.reloadMarkets(venue?)` 主动刷新市场目录能力，并公开 `MarketCatalogReloadSummary` 返回每个 venue 的新增、移除、总数和失败摘要。刷新失败会保留旧目录并在对应 summary 中返回错误，方便长运行进程在交易所新增 symbol 后无需重启即可加载新目录。

## 0.4.0-beta.5

### Patch Changes

- e61f10f: private 编排层改为按 adapter capability 分派，移除残留的 venue 字面量：下单命令是否支持按 `orderCapabilities.supported`、订单订阅按 `orderCapabilities.updates`、private credentials 是否必需按 `accountCapabilities.credentialsRequired`、account stream 启动顺序按 `accountCapabilities.updates`（polling 先 bootstrap、websocket 先建流）、REST account refresh polling 按 adapter 是否实现可选的 `refreshAccount()` 判别。juplend 轮询间隔从内部 `PrivateStreamOptions` 收口进 adapter 构造。公开 API、公共类型与运行时行为均不变，为后续接入新交易所做准备。

## 0.4.0-beta.4

### Minor Changes

- 0d99377: Add a public `RateLimiter` seam via `CreateClientOptions.rateLimiter`. The default reactive limiter tracks venue-provided REST usage metadata and honors `Retry-After` after 429/418 responses without proactively throttling normal requests or replaying non-idempotent order commands.

## 0.4.0-beta.3

### Minor Changes

- c3c9460: Add an injectable request signing clock via `CreateClientOptions.clock` and the public `TimeProvider` type. The default remains the local system clock; this does not add server-time calibration.

## 0.4.0-beta.2

### Patch Changes

- d9bacb6: 对外错误信息不再泄漏签名与密钥。请求失败时，错误的 `message` 与 URL 会对 `signature`、API key、`listenKey`、`token`、`passphrase` 等敏感 query 参数及对应的 JSON body 字段做脱敏（替换为 `[REDACTED]`），私有订阅 bootstrap 失败路径同样会对透传的错误信息脱敏。此前这些敏感值可能随错误信息进入日志。属向后兼容的行为修复，不改变公共类型与 API 形状。

## 0.4.0-beta.1

### Minor Changes

- adc9274: 公共 snapshot / market 数值字段（包括 `L1Book`、`FundingRateSnapshot`、`OrderSnapshot`、`BalanceSnapshot`、`PositionSnapshot`、`RiskSnapshot`、`MarketDefinition` 及 lending facets）由 `BigNumber` 改为 canonical 十进制 string。

  这是破坏性 public contract 变更：`snapshot.bidPrice.minus(...)`、`.multipliedBy(...)` 等链式调用不再可用，消费者需要改为 `new BigNumber(field)` 自行解析后运算（SDK 仍保留 `export { BigNumber }`）。不要用 `parseFloat()` 解析这些字段，否则会退回 JS 浮点精度。输入侧 `DecimalInput` 不变，仍接受 string / number / `BigNumber`。

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
