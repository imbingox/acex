# 事件流质量：事件总线背压/conflation 与 status 发布去重（P1-B1 + P1-B2）

## Goal

事件总线当前对每个订阅者维护无界 FIFO（`src/internal/async-event-bus.ts:58`），慢消费者会无限积压过期 tick（内存 + 决策延迟双输）；同时 `market.status_changed` 在每个 L1 tick 无条件重算并发布到三条总线（`src/managers/market-manager.ts:872/1183`），status/health 订阅者被刷屏。本任务给事件流补上 HFT 必需的 conflation（latest-wins）与有界 buffer 能力，并让 status 事件只在真正变化时发布。

## What I already know

- `AsyncEventBus.stream(filter)`：per-listener `queue: U[]` 无界 push，仅在消费者 pending 时直接 resolve。
- 七条 bus 复用该实现：marketBus、marketStatusBus（market-manager.ts:124-126）、orderBus、orderStatusBus（order-manager.ts:103-105）、accountBus、accountStatusBus（account-manager.ts:119-121）、healthBus + errorBus（runtime.ts:96-97）。
- 公开事件面：`client.market.events.{all,l1BookUpdates,fundingRateUpdates,status}`、`client.order.events.*`、`client.account.events.*`、`client.events.{health,errors}`，均接收 filter 参数。
- `recomputeAndPublishStatus`（market-manager.ts:1042）每次重建 `record.status` 对象并无条件 `publishStatus` → statusBus + marketBus + healthBus 三路 + `cloneMarketStatus` 克隆。L1 onUpdate（:872）每 tick 调用。
- `lastReceivedAt`/`lastReadyAt`/`inactiveSince`/`ts` 属于"每 tick 必变"字段，不应参与变化比较。

## Open Questions

（已全部收敛）

## Decision (ADR-lite)

### ADR-1：订阅级 options + 按事件语义分流的默认模式（Q1 → A）

**Context**：背压策略挂在哪一层（订阅点 / client 全局 / 仅 opt-in），以及默认值是否改变现有行为。
**Decision**：所有公开事件流方法加可选第二参 `{ mode?: "conflate" | "buffer", maxBuffer? }`。默认：L1/funding 流 `conflate`（按 `venue:symbol` latest-wins）；订单/账户/status/health/errors 流 `buffer`。`market.events.all()` 混合流默认 `buffer`，显式 conflate 时按 `type+venue:symbol` 合并。
**Consequences**：L1 默认行为变更（慢消费者只见最新盘口，不见中间 tick）——对量化是正确语义，minor changeset + docs 显著说明；per-stream 粒度支持"策略热路径 conflate、录制器全量 buffer"共存。

### ADR-2：buffer 溢出 drop-oldest + 每 episode 一次 runtime error（Q2 → A）

**Context**：默认 buffer 的流积压到上限时的行为（只告警不丢 / 丢旧告警 / 关闭流）。
**Decision**：默认 `maxBuffer = 10_000`；超限丢最旧事件腾位，并向 errorBus 发布一条 `EVENT_BUFFER_OVERFLOW` runtime error（带 dropped 计数），同一积压 episode 只发一次，队列排空后重置。显式传超大值/关闭值可恢复无界行为（逃生口）。conflate 模式天然有界（每 key 最多 1 条），不适用 maxBuffer。
**Consequences**：消费者死循环时内存有界、有显式信号；丢的是事件流增量，状态恢复依赖快照 API（getOpenOrders 等）作为 source of truth。errorBus 自身溢出不能再向自己发告警（防递归），实现时跳过。

### ADR-3：status 去重比较字段集（代码推导，无需用户裁决）

**Context**：`MarketDataStatus` 含 9 个字段，需确定哪些参与"变化才发布"的比较。
**Decision**：比较 `activity` / `ready` / `freshness` / `reason` 四个字段；`lastReceivedAt`、`lastReadyAt`、`inactiveSince` 为每次 recompute 必变的时间戳不参与（`inactiveSince` 在 inactive 期间每次被重置为 now）；`venue`/`symbol` 对单条 record 恒定。首次发布（record 无已发布基线）必须发布。
**Consequences**：连续相同状态的 tick 不再产生 status 事件；`recomputeAndPublishStatus` 内部仍每 tick 更新 `record.status` 时间戳字段（`getMarketStatus` 等读路径语义不变），仅发布被门控。

## Requirements

- P1-B1：`AsyncEventBus.stream(filter, options?)` 支持 `{ mode: "conflate" | "buffer", maxBuffer?, conflateKey?(event) }`；conflate 模式队列按 key latest-wins（Map 保序替换值）；buffer 模式超 maxBuffer 丢最旧 + 每 episode 一次 `EVENT_BUFFER_OVERFLOW` runtime error（含 dropped 计数）。
- 公开事件流方法（market.events.{all,l1BookUpdates,fundingRateUpdates,status}、order.events.*、account.events.*、client.events.{health,errors}）增加可选第二参透传 mode/maxBuffer；conflateKey 由 SDK 内部按流类型决定，不对外暴露。
- 默认模式：l1BookUpdates/fundingRateUpdates → `conflate`（key=`venue:symbol`）；其余全部 → `buffer`（maxBuffer 默认 10_000）；`market.events.all()` 显式 conflate 时 key=`type:venue:symbol`。
- 溢出告警经 errorBus 发布；errorBus 自身的订阅溢出不发告警（防递归），只丢弃。
- P1-B2：`recomputeAndPublishStatus` 按 ADR-3 字段集与上次已发布状态比较，变化才调用 `publishStatus`（三路：statusBus + marketBus + healthBus 一并门控）。

## Acceptance Criteria

- [ ] 单测：conflate 流发布 1000 个同 symbol L1 tick、消费 1 次只得最新一条；不同 symbol 各得最新一条且保持先来先出顺序
- [ ] 单测：buffer 流超 maxBuffer 后丢最旧、errorBus 收到恰好一次 EVENT_BUFFER_OVERFLOW；排空后再次溢出可再告警
- [ ] 单测：消费者 pending 等待时事件直接 hand-off，不进队列（两种模式行为一致）
- [ ] 单测：连续 N 个不改变状态的 L1 tick 仅产生 1 次 status 事件（首次）+ N 次 l1 事件；freshness/ready/activity/reason 任一变化即发布
- [ ] 单测：status 去重不影响 `getMarketStatus()` 读到的 lastReceivedAt 持续更新
- [ ] `bun run lint` / `bun run type-check` / `bun run test` 通过

## Definition of Done

- 单测/集成测试覆盖新行为
- lint / type-check / test 全绿
- docs/api.md（事件 API options、默认 conflate 行为说明）与 `.trellis/spec/backend/` 相关 spec 同步更新
- minor changeset（公开 API 新增 + L1 默认行为变更说明）

## Technical Approach

1. `src/internal/async-event-bus.ts`：`stream()` 加第二参 options；listener 内部队列按 mode 分流——buffer 用现有数组 + maxBuffer 检查（shift 丢旧 + onOverflow 回调），conflate 用 `Map<string, U>`（存在即替换、保插入序），消费时取首个 entry。溢出告警通过构造期注入的 `onOverflow` 回调上抛到 manager/runtime 层（bus 自身不依赖 errorBus，runtime 装配时接线，errorBus 实例不接）。
2. 各 manager 的 events 工厂（market-manager.ts:155-174 等）把公开 options 映射为 stream options + 内部 conflateKey。
3. `market-manager.ts` `recomputeAndPublishStatus`：record 上记录 `lastPublishedStatusKey`（四字段序列化或逐字段比较），变化才 `publishStatus`。
4. 类型导出：`EventStreamOptions` 加入公开类型（src/types/ + index.ts 导出）。
5. 收窄（实现期细化）：conflate 模式仅 market 流（l1BookUpdates/fundingRateUpdates/all/status）开放；order/account/health/errors 流的 options 类型仅含 `maxBuffer`（conflate 会吞订单中间状态/错误事件，类型层面不提供）。

## Out of Scope (explicit)

- P1-B3 限流分层（批次④）
- P2-12 中 AsyncEventBus 并发 `next()` 覆盖 pendingResolve 的问题（除非顺手 1 行可修，单列确认）
- L2/trades 流（P2-2）

## Technical Notes

- 来源条目：docs/improvement-todo.md P1-B1（:99）、P1-B2（:106）
- review 基线 commit `2b04f8e`，行号可能漂移
