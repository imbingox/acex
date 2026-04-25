# 添加资金费率 market 数据

## Goal

为 SDK 的 market 数据能力接入真实资金费率数据，让用户可以订阅、读取并监听 `FundingRateSnapshot`，而不是当前的本地占位快照。

## What I already know

* 用户希望添加资金费率相关的 market 数据（原文为 “markt 数据”，按上下文理解为 `market` 数据）。
* 当前 public contract 已存在 `FundingRateSnapshot`、`subscribeFundingRate()`、`unsubscribeFundingRate()`、`getFundingRate()` 和 `funding_rate.updated` 事件。
* 实施前 `MarketManager.subscribeFundingRate()` 只生成本地占位快照，`fundingRate` 默认为 `0`，没有调用 adapter，也没有真实 REST/WS 数据源。
* `MarketAdapter` 当前只包含 `loadMarkets()` 和 `createL1BookStream()`；Binance adapter 也只实现 bookTicker L1 数据流。
* 代码架构要求：public types 放在 `src/types/*`，标准化 adapter contract 放在 `src/adapters/types.ts`，Binance 交易所细节封装在 `src/adapters/binance/*`，Manager 负责领域状态与事件。

## Assumptions (temporary)

* MVP 先面向 Binance，因为当前仓库已有 Binance market adapter。
* “资金费率 market 数据” 指永续合约 funding rate / mark price / index price / next funding time 这类行情数据。
* 不支持资金费率的 spot/future 市场应有明确行为，避免默默返回假数据。

## Open Questions

* MVP 的数据源范围：只做 Binance mark price WebSocket 实时流，还是同时做 REST bootstrap / fallback？

## Requirements (evolving)

* 订阅资金费率后，应产生真实 `FundingRateSnapshot` 更新。
* `getFundingRate()` 应返回最近一次真实资金费率快照。
* `funding_rate.updated` 事件应沿用现有事件流 API。
* 资金费率实现应通过 `MarketAdapter` 契约接入，不让 Binance 特定字段泄漏到 Manager/public types。

## Acceptance Criteria (evolving)

* [ ] `subscribeFundingRate()` 不再发布硬编码 `0` 的占位数据作为成功路径。
* [ ] Binance 永续市场可以通过真实数据源更新 `FundingRateSnapshot`。
* [ ] 不支持 funding rate 的市场有明确错误或 no-op 策略，并有测试覆盖。
* [ ] `bun run type-check` 通过。
* [ ] 相关单元测试通过。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 暂不新增非 Binance 交易所。
* 暂不改动 account/order 领域。
* 暂不新增数据库持久化。

## Technical Notes

* 已读规范：`.trellis/spec/backend/index.md`、`.trellis/spec/backend/code-organization.md`、`.trellis/spec/backend/adapter-contract.md`、`.trellis/spec/backend/type-safety.md`、`.trellis/spec/guides/index.md`。
* 关键文件：`src/types/market.ts`、`src/adapters/types.ts`、`src/adapters/binance/adapter.ts`、`src/managers/market-manager.ts`。
* 现有 L1 book stream 可作为 funding rate stream 的模式参考：adapter 创建 `StreamHandle`，manager 在回调中更新 record、发布事件和 status。

## Decision (ADR-lite)

**Context**: funding rate 需要真实 market 数据源，当前已有订阅/事件 API 但实现是本地占位。  
**Decision**: MVP 只接 Binance mark price WebSocket 实时流，不做 REST bootstrap / fallback。  
**Consequences**: 实现更小、更符合现有 stream 架构；订阅后首次可用依赖 WebSocket 首条消息，若连接或首条消息超时则按 market stream timeout 处理。
