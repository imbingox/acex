# P2 批①：工程清理 + 分发产物（P2-7/8/9/10/12）

## Goal

P2 工程项批量收尾：修掉事件总线/生命周期/标识生成的小型正确性问题（P2-12/9/10），透传 MARGIN_CALL 风控事件（P2-7）。P2-8（分发产物）原计划在本批，brainstorm 中决定移除（自用、Bun-only，无 Node 兼容需求）。来源：`docs/improvement-todo.md` 2026-06-10 全库 review。

## What I already know（来自 research/code-context.md，2026-06-13 现状）

- **P2-12a AsyncEventBus**：单 `pendingResolve` 槽位，并发两次 `next()` 时第二次覆盖第一次，前一个 promise 永久悬挂（`close()` 也只解析当前槽位）；conflate/buffer 模式不防护此场景（`src/internal/async-event-bus.ts:47,139-152`）。
- **P2-12b resumeStreams**：逐 record 逐流串行 `await`，慢流阻塞后续恢复；并行化需保留 per-stream try/catch 错误隔离（`src/managers/market-manager.ts:1298-1328`）。
- **P2-12c cid 碰撞**：`acex-<Date.now base36>-<seq base36>`，无进程熵；两进程同毫秒首单同 id（`src/managers/order-manager.ts:1139-1155`）。venue 约束 `^[.A-Z:/a-z0-9_-]{1,32}$`。
- **P2-12d OrderSnapshot.type**：公开类型为裸 `string`，Binance 透传原始大写（`LIMIT`/`MARKET`，外部下的条件单可能出现 `STOP_MARKET` 等）；输入侧是 `"limit" | "market"`，不一致（`src/types/order.ts:98-106`、`src/managers/order/snapshot.ts:23-31`）。
- **P2-9 account getters**：`getAccountSnapshot`/`getBalance(s)`/`getPositions`（元素）/`getRiskSnapshot` 返回内部可变引用，调用方可改坏 manager 状态；market 侧已是冻结共享快照模式（PR #79）（`src/managers/account-manager.ts:197-225`）。
- **P2-10 stop()**：同步流程，忽略 `StopOptions{graceful,timeoutMs}`（docs/api.md 已注明 reserved）；不 await in-flight 命令/reconcile（coordinator 靠 generation 丢弃迟到结果）；`activeClients` 构造时 add、普通 stop 不 delete（`src/client/runtime.ts:421-440,71,249`）。
- **P2-7 MARGIN_CALL**：`parsePrivateMessage` 只放行 `ACCOUNT_UPDATE`/`ORDER_TRADE_UPDATE`/`listenKeyExpired`；被丢消息也不计 watchdog 活性。候选公开通道：`account.events.updates()` 新增类型化事件（推荐）vs errors 流（语义错位）（`src/adapters/binance/private-adapter.ts:568-575`）。
- **P2-8 分发**：`exports: { ".": "./index.ts" }`，发布 `src/**` 源码，无 `types`/`engines`；tsconfig `noEmit` + `allowImportingTsExtensions`（`.ts` 后缀 import，tsc 直接 emit 受限）；无构建工具；CI 已有 changesets 自动 beta 发布 + 手动 stable 发布；npm 上 latest=0.3.0、beta=0.4.0-beta.21；README/docs 均 `bun add`，未承诺 Node 支持。

## Assumptions (temporary)

- 批内各项相互独立，可一个任务内分多个 commit/changeset 完成。
- changeset 拆分：行为修复（P2-12/9/10/7 中无公开类型变化的部分）= patch；公开类型/事件新增与分发形态变化 = minor。

## Open Questions

- [x] Q1 已决：真 graceful drain（见 Requirements / Decision）
- [x] Q2 已决：**P2-8 整项移出本批不做**——包目前自用、Bun-only，无 Node 兼容需求（2026-06-13 用户决策）
- [x] Q3 已决：`OrderSnapshot.type` 窄化为小写 `OrderType` union + 新增 `rawType?: string` 留底原始串，未知映射归 `"unknown"`（minor changeset）
- [x] Q4 已决：仅透传 MARGIN_CALL（`account.events.updates()` 新增类型化事件）；ACCOUNT_CONFIG_UPDATE 不做，等 P2-6 杠杆操作面一起设计。被识别但不透传的私有消息要计入 WS watchdog 活性。

## Requirements (evolving)

- AsyncEventBus 支持并发 `next()` 不悬挂（pending resolver 队列化，`close()` 全部解析 done）。
- `resumeStreams` 并行恢复，保留 per-stream 错误隔离与防重复启动。
- cid 生成加进程级熵，保持 venue 约束（≤32 字符）与现有前缀识别（`acex-`）。
- `OrderSnapshot.type`（含 `RawOrderUpdate.type`）归一为小写 `OrderType` union（`"limit" | "market" | "stop" | "stop_market" | "take_profit" | "take_profit_market" | "trailing_stop_market" | "unknown"`），新增 `rawType?: string` 保留 venue 原始串；Binance adapter 提供映射表，未知值归 `unknown`。
- account 读取面与 market 统一为冻结共享快照模式。
- `stop()` 实现真 graceful drain（Q1 已决）：`graceful` 默认 true——runtime 登记 in-flight 订单命令 promise，stop 时等其落定（含 coordinator 在途 reconcile/refresh），`timeoutMs`（默认 5000）超时后强制断；`graceful: false` 立断。修复 `activeClients` 泄漏（stop 后 delete）。
- MARGIN_CALL 透传（Q4 已决，仅此一项）：adapter 新增 `RawMarginCallEvent` + `PrivateStreamCallbacks.onMarginCall`，公开侧 `account.events.updates()` 新增 `account.margin_call` 类型化事件（载荷含持仓明细、归一 decimal string 字段）；ACCOUNT_CONFIG_UPDATE 不做。被 `parsePrivateMessage` 识别但不透传的私有消息计入 WS watchdog 活性。

## Technical Approach

按改动面分四块，互相独立、可分 commit：

1. **事件总线/流层（patch）**：AsyncEventBus pending resolver 队列化（FIFO，`close()` 全量 resolve done）；`resumeStreams` 改 per-(record,stream) 并行 + `Promise.allSettled` 语义（保留各自 try/catch 与防重复启动检查）。
2. **订单标识与类型（minor）**：cid 加进程级熵（manager 构造时一次性随机段，保持 `acex-` 前缀与 ≤32 字符约束）；`OrderType` union + `rawType` 字段 + Binance 映射表（`RawOrderUpdate.type` 同步收窄，REST openOrders 与 WS ORDER_TRADE_UPDATE 两条入口都过映射）。
3. **生命周期与读取面（patch + minor 视 StopOptions 行为变化定级）**：account 侧改冻结共享快照（复用 market 的 freeze helper 模式，注意未变更嵌套对象跨快照复用时的冻结时机）；`stop()` graceful drain（in-flight 命令登记簿 + coordinator 在途 promise 等待 + timeoutMs 强断）+ `activeClients` 泄漏修复。
4. **MARGIN_CALL（minor）**：adapter raw 类型 → callbacks → coordinator/consumer → account-manager 发布 → 公开事件类型与 docs。

## Decision (ADR-lite)

**Context**：P2 工程项批量收尾，5 个条目 4 个设计点需要拍板。
**Decision**（2026-06-13，与用户逐项确认）：
- Q1 `stop()` 做真 graceful drain（默认 graceful、timeoutMs 默认 5000，`graceful:false` 立断）——公开的 `StopOptions` 必须兑现而非继续 reserved。
- Q2 P2-8 整项移除：包自用、Bun-only，无 Node 兼容需求。
- Q3 `OrderSnapshot.type` 窄化为小写 union + `rawType` 留底；为将来 P2-6 条件单铺路。
- Q4 仅透传 MARGIN_CALL；ACCOUNT_CONFIG_UPDATE 等 P2-6 一起设计。
**Consequences**：minor changeset（OrderType 收窄 + rawType + margin_call 事件 + stop 行为）+ patch changeset（纯内部修复）；`OrderSnapshot.type` 收窄对把它当任意 string 用的下游是行为变化，beta 阶段可接受；drain 登记簿给下单热路径加一次 Map set/delete，成本可忽略。

## Acceptance Criteria (evolving)

- [ ] 单测：并发两次 `next()` 后 publish 两条事件，两个 promise 均按序 resolve；close() 时全部 pending resolve done。
- [ ] 单测：resumeStreams 一条流失败不阻塞/不影响其他流恢复。
- [ ] 单测：两个独立 manager 实例注入相同时钟，生成 cid 不相同。
- [ ] 单测：OrderType 映射覆盖 `LIMIT`/`MARKET`/`STOP_MARKET`/未知串（→ `unknown` 且 `rawType` 留底），REST 与 WS 两条入口一致。
- [ ] 单测：mutate getter 返回值不影响 manager 后续快照/事件。
- [ ] 单测：stop() 后 client 不在 activeClients；graceful 等待 in-flight 命令落定、timeoutMs 超时强断、`graceful:false` 立断。
- [ ] 集成测试：fake 私有流推 MARGIN_CALL，公开事件流收到类型化事件；该消息计入 watchdog 活性。
- [ ] `bun run lint` / `type-check` / `test` 全绿；changeset 按 patch/minor 拆分。

## Definition of Done (team quality bar)

- 单测/集成测试覆盖新行为
- lint / type-check / test 全绿
- docs/api.md 与相关 spec（adapter-contract / order-execution / error-handling 如涉及）回写

## Out of Scope (explicit)

- **P2-8 分发产物（构建 + `.d.ts`）——本批移除不做**：包自用、Bun-only，无 Node 兼容需求；将来要分发给非 Bun 用户时再立项
- P2-11（snapshot_replaced 过重）——本批不做
- 条件单/改单等交易操作面（P2-6）
- ACCOUNT_CONFIG_UPDATE（若 Q4 决议为否）
- 浏览器/Deno 支持承诺

## Technical Notes

- 调研详见 [research/code-context.md](research/code-context.md)
- venue cid 约束：`^[.A-Z:/a-z0-9_-]{1,32}$`（src/managers/order/identity.ts:4）
- tsconfig `allowImportingTsExtensions` + `verbatimModuleSyntax`：tsc 直接 declaration emit 需 TS 5.7 `rewriteRelativeImportExtensions` 或改用 bundler（tsup）
- release.yml 已有 provenance + beta/stable 双通道，构建步骤需插入 publish 前
