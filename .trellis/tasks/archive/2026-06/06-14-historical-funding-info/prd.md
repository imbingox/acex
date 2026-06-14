# 获取某 symbol 的历史 funding 信息

## Goal

为 SDK 增加一个 public market REST 查询能力，允许调用方按 `venue + symbol` 获取某个永续合约的历史 funding rate 记录，用于回测、分析和对账。

## What I already know

- 用户需要“获取某 symbol 的历史 funding 信息”。
- 当前 SDK 已有实时 funding snapshot：`subscribeFundingRate()`、`getFundingRate()`、`getFundingRates()`。
- 当前 SDK 已有类似的 public REST 查询模式：`fetchPublicRawTrades()`，路径是 public type -> `MarketAdapter` contract -> `MarketManager` validation/error wrapping -> Binance REST helper -> docs/tests。
- Binance market catalog 已区分 `spot` / `swap` / `future`，当前 funding rate 支持语义只允许 `MarketDefinition.type === "swap"` 且 `contract === true`。
- Binance USD-M funding history endpoint 是 `GET /fapi/v1/fundingRate`；COIN-M perpetual funding history endpoint 是 `GET /dapi/v1/fundingRate`。

## Assumptions

- MVP 暂只实现 Binance，因为当前仓库唯一真实 market adapter 是 Binance。
- 新方法命名为 `fetchFundingRateHistory()`，挂在 `client.market`。
- 输入使用统一 symbol，不暴露交易所原生 symbol。
- `startTs` / `endTs` 都可选；都不传时返回交易所默认最近记录；`limit` 可选但必须是正整数，最大 1000。
- `startTs` 按 inclusive 语义传给 Binance `startTime`；`endTs` 按 Binance 文档 inclusive 语义传给 `endTime`，不复用 raw trades 的 exclusive `endTs` 语义。
- 返回值不写入现有实时 funding cache，也不发布 market event。

## Requirements

- 新增 public 类型：
  - `FundingRateHistoryEntry`
  - `FetchFundingRateHistoryInput`
  - `FetchFundingRateHistoryResult`
- `FundingRateHistoryEntry` 至少包含 `venue`、`symbol`、`fundingRate`、`fundingTime`、`receivedAt`、`raw`，可选包含 `markPrice`。
- `FetchFundingRateHistoryInput` 包含 `venue`、`symbol`、可选 `startTs`、`endTs`、`limit`。
- `FetchFundingRateHistoryResult` 包含 `rates`、可选 echo `startTs` / `endTs` / `limit`、`truncated`。
- `MarketManager.fetchFundingRateHistory()` 自动加载/解析 market catalog，校验 market 存在且 active。
- 对 spot 或 dated future 查询历史 funding 时抛 `MARKET_FUNDING_RATE_UNSUPPORTED`。
- Adapter contract 新增可选 `fetchFundingRateHistory()`，不强制所有 venue 实现。
- Binance adapter 支持 USD-M 和 COIN-M swap market；spot / delivery future 不发远端请求。
- Binance REST helper 复用共享 `httpRequest`、rate limiter、响应结构校验、原始 payload clone。
- 远端请求失败或响应结构不合法时包装为新的 market error code `MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED`，并带 `venue` / `symbol` details。
- 文档补充 MarketManager 方法、示例、类型和错误码。
- 加 changeset，作为 public API 新增的 minor 变更。

## Follow-up Requirement: Public trades 默认使用 aggregate trades

- 新增 `client.market.fetchPublicTrades()` 作为公开市场成交查询入口。
- Binance `fetchPublicTrades()` 默认走公开无鉴权 `aggTrades`，返回 aggregate trade，不依赖 API key。
- `publicTrades` capability 对 Binance 声明 `"supported"`。
- `client.market.fetchPublicRawTrades()` 作为 ready 能力恢复，走 Binance `historicalTrades`。
- raw trades 需要 market API key；支持 `CreateClientOptions.market.venues.binance.apiKey`，未显式传入时读取 `BINANCE_MARKET_API_KEY`。
- 缺 key 时本地报错且不发远端请求；无效 key / 远端失败包装为 `MARKET_PUBLIC_TRADES_FETCH_FAILED`。
- `publicRawTrades` capability 对 Binance 声明 `"supported"`。
- 文档和 changeset 必须明确 `fetchPublicTrades()` 返回的是 Binance aggregate trades，`fetchPublicRawTrades()` 才是逐笔 raw trades。

## Acceptance Criteria

- [x] `client.market.fetchFundingRateHistory({ venue: "binance", symbol: "BTC/USDT:USDT" })` 返回标准化 funding history 记录。
- [x] 支持 `{ startTs, endTs, limit }` 参数，并透传到 Binance `startTime` / `endTime` / `limit`。
- [x] `limit <= 0`、非整数 timestamp、`endTs < startTs` 等输入抛 `MARKET_INPUT_INVALID`。
- [x] spot / dated future 查询抛 `MARKET_FUNDING_RATE_UNSUPPORTED`。
- [x] Binance USD-M response 的 `markPrice` 被标准化返回；COIN-M response 缺少 `markPrice` 时仍可正常返回。
- [x] HTTP/parse 失败被包装为 `MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED`，并发布 adapter runtime error。
- [x] `client.market.fetchPublicTrades()` 走 Binance `aggTrades`，无 API key 可用。
- [x] `client.market.fetchPublicRawTrades()` 带 market API key 走 Binance `historicalTrades`，返回逐笔 raw public trades。
- [x] `client.market.fetchPublicRawTrades()` 缺 key 时本地报错且不发远端请求。
- [x] 单测覆盖 Binance helper、MarketManager dispatch/validation/error wrapping。
- [x] `bun run lint`、`bun run type-check`、`bun run test` 通过。

## Definition of Done

- Tests added/updated.
- Lint / type-check / test green.
- API docs updated.
- Changeset added for public API minor change.

## Out of Scope

- 不实现 funding income / 账户资金费支付记录。
- 不新增历史 funding WebSocket、缓存、分页自动拉全或事件流。
- 不接入 Binance `/fundingInfo`，只做历史 funding rate。
- 不实现非 Binance venue。

## Research References

- [`research/binance-funding-rate-history.md`](research/binance-funding-rate-history.md) - Binance funding history endpoint、字段和分页约束。

## Technical Notes

- 相关代码：`src/types/market.ts`、`src/adapters/types.ts`、`src/managers/market-manager.ts`、`src/adapters/binance/adapter.ts`、`src/adapters/binance/rate-limit-topology.ts`。
- 可参考实现：`src/adapters/binance/public-trades.ts`、`MarketManager.fetchPublicRawTrades()`。
