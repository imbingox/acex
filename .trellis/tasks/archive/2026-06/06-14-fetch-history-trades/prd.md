# brainstorm: fetch history trades

## Goal

为 Acex 评估并设计主动拉取 public market trades 的能力，先明确 Binance 原生接口能力、CCXT 的统一封装方式，以及当前项目里最合适的接入边界。

## What I Already Know

* 用户希望先研究 Binance 相关能力和 CCXT 等封装方式，再决定实现。
* 用户已明确这里的 trades 指 public market trades，不是 account/my trades。
* 用户实际使用时会给一个比较小的时间窗口，例如 1 分钟。
* 用户需要最精确的撮合时间；aggregate trade 的时间不能替代内部每笔 raw trade 的撮合时间。
* 毫秒级撮合时间足够。
* 倾向在 `MarketManager` 暴露类似 `fetchPublicRawTrades` 的方法，输入包括 `venue`、`symbol`、`startTs`。
* 下游不是严格时间窗口场景；`endTs` 和 `limit` 二者任意一个可作为停止条件。
* 当前仓库是 single-repo，运行时主要已有 Binance market/order/account/private adapter。
* 现有 `client.order.events.trades(...)` 是私有订单成交事件流，用于 account 维度实时成交、手续费和 realized PnL，不等同于 public market trades。
* 项目已有 Binance PAPI private REST、listenKey、market REST/WS、rate limiter、venue capabilities 和 manager 分层。
* Public market trades 应归 `client.market` / `MarketManager` / `MarketAdapter`，不是 `client.order`。
* Binance public trades 分 raw recent、raw historical/old、aggregate 三种语义；raw historical 主要按 `fromId` 翻页，aggregate 才支持时间窗口。

## Assumptions (Temporary)

* MVP 更可能需要真实逐笔 public market trades，而不是 aggregate trades。
* 如果需要按时间窗口查询，Binance raw public historical trades 无法直接满足，需要用 aggregate trades，或先用 aggregate trades 定位 raw trade id 再拉 raw trades 并过滤。

## Open Questions

* `limit` 默认值和最大值应取多少，才能兼顾安全上限与常见 1min 窗口？

## Requirements (Evolving)

* 研究 Binance Spot / USDⓈ-M / COIN-M public trades 相关接口，包括 recent、historical/old、aggregate。
* 研究 CCXT `fetchTrades` 方法的语义、参数、分页和 Binance endpoint 选择。
* 对比 Acex 当前类型与 manager/adapter 边界，提出推荐接入方式。
* 明确 public market trades 与现有 private `order.trade` 事件的边界。
* 设计必须支持小时间窗口输入，例如 `since`/`until` 间隔约 1 分钟。
* API 命名倾向 `fetchPublicRawTrades`，归属 `client.market`。

## Acceptance Criteria (Evolving)

* [x] 有 research artifact 记录 Binance public trades 原生接口能力、限制和分页要点。
* [x] 有 research artifact 记录 CCXT `fetchTrades` 封装语义和可借鉴/不可照搬点。
* [x] 给出 Acex 推荐 MVP 范围、接口归属和后续实现注意事项。
* [x] 用户确认小时间窗口查询需要返回窗口内 raw public trades，而不是 aggregate trades。

## Definition of Done (Team Quality Bar)

* Tests added/updated if implementation follows.
* Lint / typecheck / CI green if code changes are made.
* Docs/notes updated if public API behavior changes.
* Rollout/rollback considered if risky.

## Out of Scope (Explicit)

* 本轮先不直接实现代码，除非用户明确要求进入实现。
* 不把实时 WS trade stream 和历史 REST trade fetch 混为一个接口。
* 不把 account/my trades 纳入本任务；账户成交历史应另走 private/order 设计。
* MVP 不做自动全量回填或无限分页。

## Technical Notes

* Initial repo search: `src/adapters/binance/*`, `src/managers/order-manager.ts`, `src/types/order.ts`, `docs/api.md`, `docs/improvement-todo.md`.
* Existing TODO mentions market L2/trades stream as separate future work; this task focuses on historical fetch semantics first.
* Market public API 现有边界: `src/types/market.ts`, `src/managers/market-manager.ts`, `src/adapters/types.ts`, `src/adapters/binance/adapter.ts`。
* Binance Spot raw recent: `GET /api/v3/trades`, weight 25, limit max 1000。
* Binance Spot raw historical: `GET /api/v3/historicalTrades`, weight 25, `fromId`, limit max 1000。
* Binance Spot aggregate: `GET /api/v3/aggTrades`, weight 4, supports `fromId/startTime/endTime`, limit max 1000。
* Binance USD-M raw recent: `GET /fapi/v1/trades`, weight 5, limit max 1000。
* Binance USD-M raw historical: `GET /fapi/v1/historicalTrades`, weight 20, `fromId`, limit max 500。
* Binance USD-M aggregate: `GET /fapi/v1/aggTrades`, weight 20, recent 24h only, `startTime/endTime` window under 1h。
* Binance COIN-M raw recent: `GET /dapi/v1/trades`, weight 5, limit max 1000。
* Binance COIN-M raw historical: `GET /dapi/v1/historicalTrades`, weight 20, `fromId`, limit max 500, last one month only。
* Binance COIN-M aggregate: `GET /dapi/v1/aggTrades`, weight 20, recent 24h only, `startTime/endTime` window under 1h。
* CCXT `binance.fetchTrades` 默认走 aggregate trades；raw endpoint 需要 `params.fetchTradesMethod` 指定。

## Research References

* [`research/binance-public-trades.md`](research/binance-public-trades.md) - Binance Spot / USD-M / COIN-M public raw 与 aggregate trades 接口、参数、限制。
* [`research/ccxt-public-trades.md`](research/ccxt-public-trades.md) - CCXT `fetchTrades` 统一语义，以及 Binance 默认 aggregate trades 的实现细节。
* [`research/acex-public-trades-integration.md`](research/acex-public-trades-integration.md) - Acex market 层接入边界、MVP 建议、类型与 rate limit 注意事项。

## Recommended MVP

用户实际会传小时间窗口，并要求最精确撮合时间。因此推荐 MVP 是 `client.market.fetchPublicRawTrades(...)`，执行 raw time-window 查询，内部两段式：

* 先用 `aggTrades({ startTime, endTime })` 找到窗口覆盖的 `firstTradeId` / `lastTradeId`。
* 再用 `historicalTrades({ fromId })` 分页拉 raw trades。
* SDK 过滤 `time >= since && time <= until` 后返回 raw public trades。
* 返回值的 `exchangeTs` 使用 raw trade 的 `time` 字段，不使用 aggregate trade 的 `T` 字段作为最终撮合时间。
* 实现比直接返回 aggregate trades 更复杂，遇到高成交量 1 分钟窗口时可能需要多次 REST 调用。

推荐 API 形态：

```ts
client.market.fetchPublicRawTrades({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  startTs: 1710000000000,
  endTs: 1710000060000,
  limit: 5000,
});
```

推荐语义：

* `startTs` 必填。
* `endTs` 和 `limit` 至少传一个。
* 只传 `limit` 时，语义是从 `startTs` 开始返回最多 N 条 raw public trades。
* 只传 `endTs` 时，语义是返回半开区间 `[startTs, endTs)` 内的 raw public trades，最多到 SDK 默认安全上限。
* 两者都传时，两者同时生效：返回 `[startTs, endTs)` 内最多 `limit` 条；如果窗口内超过 `limit`，返回 `truncated/nextFromId` 之类的分页信息。
* 内部调用 Binance `aggTrades` 时，如果有 `endTs`，按 Binance inclusive `endTime` 发送 `endTs - 1`，并考虑对 aggregate 查询窗口做小幅边界 padding，再用 raw trade `time` 精确过滤。

原先的 raw `fromId` 单页查询仍可作为底层能力：

* 不传 `fromId` 调 recent raw trades。
* 传 `fromId` 调 historical/old raw trades。
* `limit` 按 venue endpoint 上限校验或 clamp。
* 返回 normalized public trade，并保留 `raw`。
* 直接 raw endpoint 不支持 `since/until`；按时间窗口的 raw 查询必须通过方案 B 包装。
