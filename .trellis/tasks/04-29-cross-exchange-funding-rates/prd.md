# 跨交易所 funding 聚合接口

## Goal

为 SDK 使用方提供一个跨交易所 funding 聚合读取接口，例如 `getFundingRates(symbol)`，直接返回同一交易对在各 exchange 下的 funding rate、mark price、index price、next funding time 和当前数据状态，降低使用方逐交易所查询和合并状态的成本。

## What I already know

* 用户希望 SDK 层直接提供 `getFundingRates(symbol)`。
* 返回需要包含各 exchange 的 `rate`、`mark`、`index`、`nextFundingTime`、状态。
* 当前代码已经有单市场 `getFundingRate({ exchange, symbol })`。
* 当前 Binance funding stream 已接入 `markPrice` / `indexPrice` / `nextFundingTime`。

## Assumptions (temporary)

* MVP 先聚合内存中已有订阅数据，不主动发起 REST 请求。
* MVP 先覆盖当前 SDK 支持的 exchange/market catalog；当前实际只有 Binance adapter。
* 输入 `symbol` 需要明确是否是统一 symbol（如 `BTC/USDT:USDT`）还是 base/quote 简写（如 `BTC/USDT` 或 `BTC`）。

## Open Questions

* `getFundingRates(symbol)` 的 `symbol` 参数应匹配完整统一 market symbol，还是允许按 base/quote 做归一化聚合？

## Requirements (evolving)

* SDK public API 提供跨交易所 funding 聚合读取方法。
* 每个结果项包含 exchange、symbol、funding rate、mark price、index price、next funding time、status。
* 聚合结果应复用已有 `FundingRateSnapshot` 状态语义，避免重复定义状态字段。

## Acceptance Criteria (evolving)

* [ ] 可调用 `client.market.getFundingRates("BTC/USDT:USDT")` 获取数组结果。
* [ ] 返回项包含 exchange、symbol、fundingRate、markPrice、indexPrice、nextFundingTime、status。
* [ ] 未订阅或无数据的市场不会产生伪造 rate。
* [ ] 单元测试覆盖有数据、无数据、跨 exchange 过滤语义。

## Definition of Done

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 不在 MVP 中新增其他交易所 adapter。
* 不在 MVP 中主动 REST 拉取 funding 历史或未订阅实时数据。
* 不改变已有 `getFundingRate({ exchange, symbol })` 行为。

## Technical Notes

* 待检查：`src/types/market.ts`、`src/managers/market-manager.ts`、tests 中 market API 模式。

## Context Findings

* `src/types/shared.ts` 的 `SUPPORTED_EXCHANGES` 已包含 `binance`、`okx`、`bybit`、`gate`。
* `src/client/runtime.ts` 当前只实例化一个 `BinanceMarketAdapter`，所以 MVP 的“跨交易所”接口需要先按 API 形态设计，当前运行结果只会返回已有 adapter/已有订阅数据。
* `src/types/market.ts` 中已有 `FundingRateSnapshot`，包含 `exchange`、`symbol`、`fundingRate`、`markPrice`、`indexPrice`、`nextFundingTime`、`status`，可直接作为返回项或复用其结构。
* `src/managers/market-manager.ts` 当前 records 以 `exchange:symbol` 存储，天然支持按 symbol 扫描聚合。

## Decision (ADR-lite)

**Context**: 使用方需要按统一 symbol 读取跨交易所 funding 聚合结果；当前 SDK 已有单市场 funding snapshot，且未来会扩展多交易所 adapter。

**Decision**: MVP 增加 `MarketManager.getFundingRates(symbol: string): FundingRateSnapshot[]`，严格按完整统一 symbol 匹配，只返回内存中已有 funding snapshot，不主动订阅或 REST 拉取。

**Consequences**: 当前只有 Binance adapter 时最多返回一项；未来增加 OKX/Bybit/Gate 后无需改变调用方 API。严格 symbol 避免把 spot/future/swap 或不同 settle 误聚合。

## Follow-up Decision

用户确认 strict symbol 方案，并提出 `findMarkets` 与 `getFundingRates` 语义不一致。决定新增一致的读取族：`getMarkets(symbol)`、`getL1Books(symbol)`、`getFundingRates(symbol)`；`findMarkets(symbol)` 保留为兼容别名并标记 deprecated。

## Follow-up Decision 2

用户确认下游无 `findMarkets(symbol)` 依赖。决定直接移除 `findMarkets(symbol)`，仅保留语义一致的 `getMarkets(symbol)`。
