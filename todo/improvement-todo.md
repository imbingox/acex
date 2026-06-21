# 改进待办

> 仅保留当前未完成、优先级较低的 backlog。已完成的 2026-06-10 review 条目、历史批次记录、附录和明确不做的事项已清理。

## 低优先级 Backlog

- [ ] **WS-API 下单**
  - 现状：Binance 交易命令仍走 REST。
  - 价值：降低下单往返延迟，是 HFT 场景的主线增强。
  - 注意：需要独立设计签名、限流、命令水位、错误语义和 fallback。

- [ ] **L2 增量深度 / market trades 流 / K线**
  - 现状：`MarketAdapter` 主要覆盖 L1 和 funding；公开 market trades 只有 REST 查询，未提供实时流；K线也未建模。
  - 价值：补齐策略常用行情面。
  - 注意：L2 需要 REST snapshot + diff 序列号拼接的有状态 assembler，影响面较大。

- [ ] **行情双连接冗余热备**
  - 现状：重连 jitter 已完成，但同一行情流的 `redundancy: 2` 热备未实现。
  - 价值：单连接断开时减少行情中断窗口。
  - 注意：需要按 stream update 去重、保留先到数据，并处理双连接状态聚合。

- [ ] **查询面剩余缺口**
  - 现状：已完成 `fetchPublicTrades()`、`fetchPublicRawTrades()`、`fetchFundingRateHistory()` 和实时 `order.events.trades()`。
  - 剩余：`getClosedOrders()`、账号成交历史、funding income 历史查询 API。
  - 注意：需要区分公开 funding rate 历史和账户实际资金费收付历史。

- [ ] **交易操作面扩展**
  - 现状：改单、条件单、杠杆设置、持仓模式设置、资金划转仍未实现。
  - 价值：补齐交易 bot 常见操作。
  - 注意：需要先更新 capabilities，再分 venue 实现，避免公开 API 承诺超过实际支持面。

- [ ] **正式 logger 集成**
  - 现状：`logger` / `logLevel` 仍是预留字段；目前生产诊断主要依赖 `events.errors()`、health/status 事件和 `onMetric`。
  - 价值：补齐结构化诊断入口。
  - 注意：需要定义等级、字段脱敏、热路径采样策略，并同步 `.trellis/spec/sdk/` 下对应 runtime / observability 规范；如无合适落点，先新增专门 logging 规范。

- [ ] **降低 `order.snapshot_replaced` 事件负载**
  - 现状：reconcile 会发布 open + retained closed 的全量数组，事件较重。
  - 价值：减少大账户下的周期性事件体积。
  - 注意：当前 `.trellis/spec/sdk/venues/binance.md` 要求该事件保持全量，变更前需先设计新契约，例如新增轻量 open-set 事件或增量事件，而不是直接缩窄既有事件语义。

- [ ] **bootstrap 覆盖先到 stream 增量的竞态**
  - 现状：私有账户 bootstrap 可能在订阅初期覆盖更早到达的 WS 增量。
  - 影响：低危，通常会在下一轮 risk polling / reconcile 自愈，但订阅启动窗口内可能短暂回退余额、仓位或风险字段。
  - 注意：修复需让 bootstrap 对已有快照走 merge/watermark，影响余额、仓位、risk 三条账户链路，建议独立任务处理。
