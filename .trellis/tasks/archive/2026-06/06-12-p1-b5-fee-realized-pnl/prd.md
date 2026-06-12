# P1-B5 成交明细字段（fee / 逐笔成交 / realized PnL）

## Goal

让策略层能从 SDK 拿到手续费、逐笔成交价量、已实现盈亏——量化 SDK 的基本盘。当前 `mapOrderUpdate`（`private-adapter.ts:590`）把 Binance `ORDER_TRADE_UPDATE` 的 `n/N/l/L/rp` 全部丢弃，`RawOrderUpdate` / `OrderSnapshot` 也无对应字段，导致策略无法核算手续费成本、逐笔成交与 realized PnL。

## What I already know（代码勘察 @ commit 7313b58）

- **丢弃点**：`mapOrderUpdate`（`private-adapter.ts:590-617`）只映射到 `z`(cum filled)/`ap`(avg price)，未读 `n/N/l/L/rp`。WS payload 类型 `BinanceOrderTradeUpdatePayload`（`:143`）当前根本没声明这些字段，需要补。
- **公开类型**：`RawOrderUpdate`（`adapters/types.ts:161`）、`OrderSnapshot`（`types/order.ts:98`）均无 fee/lastFill/realizedPnl 字段。
- **关键约束 — 这些字段是 WS-only**：REST PAPI 订单端点（`BinancePapiOpenOrder` `:87`，覆盖 createOrder ack / fetchOrder 回查 / openOrders 快照）**不返回** commission / realizedPnl。故新字段在 REST 来源的快照上天然缺失 → 必须 optional。
- **Binance 语义是逐笔（per-event）而非累计**：`n`=本笔手续费、`N`=手续费资产、`l`=本笔成交量、`L`=本笔成交价、`rp`=本笔已实现盈亏；`z`=累计成交量(已用)、`Z`=累计成交额(未用)。手续费资产可跨笔变化（BNB 抵扣 vs 计价币），累计 `fee.cost` 单值会有币种歧义。
- **快照合并模型**：`createSnapshot`（`managers/order/snapshot.ts`）逐字段 `input.X === undefined ? previous?.X : ...` 合并；终态事件（如 fill 后的 CANCELED）不带 fee → 决定"保留上一笔"还是"反映最新一笔"需要明确语义。
- **事件体系**：`OrderEvent` 联合（`types/order.ts:156`）现有 updated/filled/canceled/rejected/snapshot_replaced，均挂整份 `OrderSnapshot`；无独立 trade 事件。
- **juplend 也产 `RawOrderUpdate`**（`adapters/juplend/private-adapter.ts`），新字段对其须 optional、不强制。
- **decimal**：统一走 `toCanonical`（`internal/decimal.ts`）做 canonical 化。
- **spec/docs**：契约见 `.trellis/spec/backend/adapter-contract.md` 与 `order-execution.md`；公开类型扩展 → **需要 minor changeset**，并回写 `docs/api.md`。

## Decision (ADR-lite)

**Q1 数据模型形状 → 方案 B（独立 `order.trade` 逐笔事件）**
- Context: Binance `ORDER_TRADE_UPDATE` 给逐笔值且 WS-only；纯快照末笔字段有损（buffer 丢笔/合并后无法精确累加），累计字段引入 manager 有状态 + 跨币种歧义。
- Decision: 每个 `x=TRADE` 的成交发一条独立 `OrderTradeEvent`（buffer 流、不 conflate）承载逐笔 price/qty/fee/realizedPnl；逐笔是量化 SDK 应有的一等原语。背压下 buffer 可丢最老 trade，但带单调 `seq` 可检测 gap（见 D5）。
- Consequences: 新增事件类型 + 总线路由 + raw 层 trade 结构；工作量最大但核算正确。

**Q2 API 流形状 → 独立 `events.order.trades(filter?, options?)` 流**
- Decision: 新增 `trades()` 方法返回 `AsyncIterable<OrderTradeEvent>`，buffer 语义；`updates()` 契约不变。
- Consequences: API 多一方法，但关注点分离（状态机变更 vs 逐笔流水），不破坏现有订阅者。

**Q3 快照是否挂成交明细 → 否(选项 1)**
- Decision: `OrderSnapshot`(即订单对象,SDK 无单独 `Order` 类型)不挂 fee/trades;fee/逐笔/realizedPnl 只活在 `OrderTradeEvent`,下游按 `orderId` 关联累加。
- 核实(Binance 官方文档,2026-06-12): `GET .../order` / `openOrders` 等 per-order 查询接口**一律不返回** commission/realizedPnl(by design);fee 只在 `userTrades`(REST 逐笔)与 WS `ORDER_TRADE_UPDATE`(`n/N/rp`)出现。app 显示的订单 fee 是对 userTrades 按 orderId 聚合的结果。来源见 Technical Notes。
- Consequences: 快照保持精简、无每-tick 克隆无界 trades 数组、无 manager 有状态累加。

## Open Questions

(none — 见 Final 确认)

## Decision (ADR-lite) — codex review 增补（2026-06-12）

**D4 trade 发布独立于快照 watermark（blocker 修）**
- 当前 `applyUpdateToRecord` 经 `shouldApplyWatermarkedUpdate` 拒绝乱序 update 会返回 `undefined`（`order-manager.ts:1002/640`）。成交是既成事实，trade 发布**不得**被快照 watermark 门控。
- Decision: `onPrivateOrderUpdate` 先从 raw `update.trade` 决定是否发 `OrderTradeEvent`，**与 `applyUpdateToRecord` 是否写入快照解耦**；快照仍走 watermark，trade 各走各的。

**D5 trade 去重 + gap 可检测（blocker/major 修）**
- 去重：按 `(accountId, venue, tradeId)` 有界 seen-set（每 record 一个 bounded LRU/FIFO，上限如 1024）丢弃重复 `ORDER_TRADE_UPDATE`；`tradeId` 缺失时不去重并发布（保守不丢真实成交）。
- gap 可检测：`OrderTradeEvent` 带单调 `seq`（per accountId+venue 的 tradesBus 序号），下游可检测 buffer 溢出造成的缺口。
- 溢出语义：tradesBus 沿用 `AsyncEventBus` buffer（drop-oldest + `EVENT_BUFFER_OVERFLOW` 告警，`async-event-bus.ts`）。**不再宣称"无损"**——背压下可丢最老 trade，但可经 `seq` 缺口检测；真要零丢由下游配大 `maxBuffer` 或后续 REST `userTrades` 对账补全（Out of Scope）。

**D6 跨 bus 顺序关联（major 修）**
- order 事件与 trade 事件分属 `orderBus`/`tradesBus`，无跨 bus 相对顺序保证。`OrderTradeEvent` 带 `orderSeq`（关联当时快照的 `OrderSnapshot.seq`），下游可对齐。

## Requirements (evolving)

- 新增公开类型（`types/order.ts`）：
  - `OrderTrade { tradeId?, price, qty, fee?{cost, asset}, realizedPnl?, maker?, positionSide?, exchangeTs?, receivedAt }`（数值均 decimal string）。
  - `OrderTradeEvent extends OrderEventBase { type: "order.trade"; trade: OrderTrade; orderId?; clientOrderId?; seq; orderSeq?; }`（信封含 accountId/venue/symbol/side/ts，内嵌 `trade`）。
- `OrderEventStreams` 新增 `trades(filter?: OrderEventFilter, options?: BufferedEventStreamOptions): AsyncIterable<OrderTradeEvent>`（buffer 语义，不 conflate）。`updates()`/`status()` 契约不变。
- raw 层：`RawOrderUpdate` 新增 optional `trade?: RawOrderTrade { tradeId?, price, qty, fee?{cost,asset}, realizedPnl?, maker?, positionSide? }`。Binance ORDER_TRADE_UPDATE 与订单状态变更同条消息原子到达，故成交挂在 order update 上、由 manager 拆发两类事件，保持单一摄入路径。
- `mapOrderUpdate`（`private-adapter.ts:590`）：补 payload 类型 `x`(执行类型)/`t`/`l`/`L`/`n`/`N`/`rp`/`m`；仅当 `x === "TRADE"` 且 `Number(l) > 0`（数值判断，非字符串 truthy）时填 `trade`。`fee.cost` 允许 0/负（maker rebate）——只要 `n` 存在就映射，不因 falsy/零值省略；`N` 缺失时省略 `fee` 整体。
- order-manager：新增 `tradesBus`，`onPrivateOrderUpdate` 在 watermark 门控**之外**按 `update.trade` 去重后发 `OrderTradeEvent`（见 D4/D5/D6）。
- decimal：trade 数值走 `toCanonical`。
- 单测：映射（带 `n/N/l/L/rp/m/ps`）+ trades 流端到端 + 非 TRADE 不发 + `l=0` 不发 + 重复 `tradeId` 去重 + **乱序 update（快照被 watermark 拒）仍发 trade** + REST-only 无 trade 不报错 + `seq` 单调。
- minor changeset + adapter-contract / order-execution spec + docs/api.md。

## Acceptance Criteria (evolving)

- [ ] WS `ORDER_TRADE_UPDATE`（`x=TRADE`, `l>0`）带 `n/N/l/L/rp` 时，`events.order.trades()` 收到一条含对应字段的 `OrderTradeEvent`（含 `positionSide`/`receivedAt`/`seq`/`orderSeq`）。
- [ ] 非 TRADE 执行类型（NEW/CANCELED/EXPIRED）或 `l=0` 不产生 trade 事件；`updates()` 行为不变。
- [ ] 重复 `tradeId` 的 ORDER_TRADE_UPDATE 只发一条 trade 事件。
- [ ] **乱序 update（快照被 watermark 拒绝写入）时，trade 事件仍照常发布**。
- [ ] `fee.cost` 为 `"0"` 或负值时不被丢弃；`maker` 布尔正确。
- [ ] REST 来源（createOrder/fetchOrder/openOrders）的快照与更新不含 trade、不报错。
- [ ] `OrderSnapshot` 公开字段无变化（快照不挂 fee/trades）。
- [ ] trades 流为 buffer 语义，可按 accountId/venue/symbol 过滤；溢出走 `EVENT_BUFFER_OVERFLOW`，`seq` 单调可检测 gap。
- [ ] minor changeset + spec（adapter-contract / order-execution）+ docs/api.md 同步。
- [ ] lint / type-check / test 全绿；live order smoke 打印逐笔 fee。

## Definition of Done

- Tests added/updated（unit；live smoke 打印验证）
- Lint / typecheck / test 全绿
- spec + docs/api.md 更新
- minor changeset

## Out of Scope (explicit)

- 快照级累计 fee / realizedPnl（有状态累加，跨币种语义 → 留给策略侧 fold 或后续增强）。
- `OrderSnapshot.trades[]` 数组 / `getOrderTrades()` 查询 API（归 P2-5 查询面）。
- REST `userTrades` 拉取历史成交 / 对账补全 / 零丢保证（归 P2-5）。
- `quoteQty`（可由 `price*qty` 派生，MVP 不收）。
- juplend 等其他 venue 的成交明细映射（字段 optional，不强制实现）。
- 独立 `order.trade` 在 `updates()` 联合中重复暴露。

## Technical Notes

- 改动面：`adapters/binance/private-adapter.ts`（`BinanceOrderTradeUpdatePayload` 加 `x/t/l/L/n/N/rp/m` + `mapOrderUpdate`）、`adapters/types.ts`（`RawOrderUpdate.trade?` + `RawOrderTrade`）、`types/order.ts`（`OrderTrade`/`OrderTradeEvent`/`OrderEventStreams.trades`）、`managers/order-manager.ts`（tradesBus + 发布）、`managers/order/snapshot.ts`（不变，确认忽略 trade）。
- 契约：`.trellis/spec/backend/adapter-contract.md`、`order-execution.md`；`docs/api.md`。
- Binance 字段语义（已核实 2026-06-12）：per-order 查询接口无 fee；fee 仅逐笔（WS `ORDER_TRADE_UPDATE.n/N/rp` 与 REST `userTrades.commission/commissionAsset/realizedPnl`）。
  - [Query Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Query-Order)
  - [UM Account Trade List (userTrades)](https://developers.binance.com/docs/derivatives/portfolio-margin/trade/UM-Account-Trade-List)
- ORDER_TRADE_UPDATE 字段：`x`=执行类型(NEW/CANCELED/CALCULATED/EXPIRED/TRADE/AMENDMENT)、`X`=订单状态(现有)、`t`=tradeId、`l`=本笔量、`L`=本笔价、`n`=手续费、`N`=手续费资产、`rp`=本笔已实现盈亏、`m`=是否 maker。

## Implementation Plan (small PRs / 单 PR 分步)

- 步骤1：types 扩展（`RawOrderTrade`/`RawOrderUpdate.trade?`、`OrderTrade`/`OrderTradeEvent`(含 seq/orderSeq/positionSide/receivedAt)、`OrderEventStreams.trades`）+ 单测桩。
- 步骤2：Binance payload 类型 + `mapOrderUpdate` 仅 `x=TRADE && l>0` 填 trade（fee 允许 0/负）；映射单测。
- 步骤3：order-manager tradesBus + 发布路由（**watermark 之外**、`tradeId` 去重、`seq` 递增、`orderSeq` 关联）+ `trades()` 接线；端到端单测（非 TRADE 不发、l=0 不发、重复去重、乱序仍发、过滤、seq 单调）。
- 步骤4：spec（adapter-contract / order-execution）+ docs/api.md + minor changeset；live smoke 打印 fee。
