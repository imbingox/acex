# provide symbol fee capability

## Goal

为 SDK 下游提供按 symbol 获取手续费相关信息的能力。需要明确提供的是 symbol 的交易费率、已发生成交手续费，还是两者都提供，并保持现有订单成交事件语义兼容。

## What I already know

* 用户需要“提供 symbol 的手续费功能”。
* 用户进一步明确：目标不是只查单个 symbol，而是希望 SDK 能发现 / 维护 maker fee 为 0 的交易对。
* 用户倾向一个类似 fee manager 的机制：SDK 内部通过 poll 维护各 symbol 下的 maker / taker fee。
* 当前 SDK 已通过 `client.order.events.trades({ accountId, symbol })` 暴露 Binance 私有 WS 的逐笔成交手续费。
* `OrderTradeEvent` 包含 `symbol`，`trade.fee?.cost`，`trade.fee?.asset`，下游可以自行按 symbol 累加已发生手续费。
* `OrderSnapshot` 公开字段不包含手续费。
* 文档说明 REST 订单查询/命令回包不含逐笔手续费，不会发布 `order.trade`。
* 当前公开 market contract `MarketDefinition` 不包含 maker/taker fee rate 或 symbol fee schedule。
* Binance market catalog 可以作为候选 symbol 来源，但真实 maker/taker fee 是账号级 private data，不能仅从 market data 判断。

## Assumptions (temporary)

* “symbol 的手续费功能”很可能指下游需要按 symbol 查询交易费率，例如 maker/taker rate，而不是只消费已发生的逐笔手续费。
* 初期实现应优先遵循现有分层：public type 在 `src/types/*`，manager 暴露 public API，adapter 封装交易所私有细节。
* Binance 是当前优先 venue；其它 venue 可以返回 unsupported，除非用户明确要求同时覆盖。

## Open Questions

* 已确认：本次 MVP 优先提供手续费费率查询，不做已发生手续费聚合。
* 需要重新确认：MVP 是否从 `OrderManager.getSymbolFeeRate()` 扩展为独立 fee manager / fee cache，还是保留单次查询并新增批量筛选 helper。

## Requirements (evolving)

* 下游能够按 `accountId + symbol` 获取手续费费率。
* 本次能力提供 symbol 的 maker/taker 手续费费率查询，返回 canonical decimal string。
* API 入口放在订单/交易私有能力下：`client.order.getSymbolFeeRate({ accountId, symbol })`。
* Binance 实现使用 PAPI UM `GET /papi/v1/um/commissionRate`，输入接受统一 symbol，adapter 内转换为 venue symbol。
* 保持现有 `order.trade` 逐笔成交手续费事件兼容。
* 新方向候选：提供账号级 fee cache / manager，维护 `{ accountId, symbol, maker, taker, receivedAt, stale? }` 视图，并支持筛选 maker 为 0 的 symbol。
* fee cache 的候选 symbol 来自 market catalog；Binance 第一版默认只考虑 PAPI UM 可查询的 active USD-M linear swap。

## Acceptance Criteria (evolving)

* [ ] 公开 API 能按 `accountId + symbol` 查询 symbol maker/taker fee rate。
* [ ] 返回值包含 `accountId`、`venue`、统一 `symbol`、`maker`、`taker`、`receivedAt`。
* [ ] Binance PAPI UM 场景有测试覆盖，验证请求路径、签名参数、symbol 映射、返回字段 canonical 化。
* [ ] 不支持的 venue 或无法查询的 symbol 有清晰错误/返回语义。
* [ ] `docs/api.md` 更新使用方式和限制。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 不实现历史成交手续费回放或自动持久化聚合。
* 不默认支持所有交易所；非 Binance / 不支持 adapter 走清晰 unsupported 语义。

## Technical Notes

* `src/types/order.ts` 已定义 `OrderTrade.fee` 和 `OrderTradeEvent.symbol`。
* `src/adapters/binance/private-adapter.ts` 将 Binance execution report 的 `n/N` 映射到 `fee.cost/asset`。
* `src/managers/order-manager.ts` 发布 `order.trade` 时保留 `symbol` 和 canonicalized `trade.fee`。
* `docs/api.md` 已说明逐笔成交手续费通过独立 `order.trade` 事件消费。
* 可能需要检查 Binance 手续费接口以及 API 权限、账号维度、symbol 类型限制。

## Research References

* [`research/binance-symbol-fee-rate.md`](research/binance-symbol-fee-rate.md) — Binance PAPI UM 提供账号级 symbol maker/taker 费率接口，适合接入订单私有能力。
