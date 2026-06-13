# P2 批①：工程清理 + 分发产物（P2-7/8/9/10/12）

## Goal

P2 工程项批量收尾：修掉事件总线/生命周期/标识生成的小型正确性问题（P2-12/9/10），透传 PAPI 账户风控事件并回填风险快照（P2-7）。P2-8（分发产物）原计划在本批，brainstorm 中决定移除（自用、Bun-only，无 Node 兼容需求）。来源：`docs/improvement-todo.md` 2026-06-10 全库 review。

## What I already know（来自 research/code-context.md，2026-06-13 现状）

- **P2-12a AsyncEventBus**：单 `pendingResolve` 槽位，并发两次 `next()` 时第二次覆盖第一次，前一个 promise 永久悬挂（`close()` 也只解析当前槽位）；conflate/buffer 模式不防护此场景（`src/internal/async-event-bus.ts:47,139-152`）。
- **P2-12b resumeStreams**：逐 record 逐流串行 `await`，慢流阻塞后续恢复；并行化需保留 per-stream try/catch 错误隔离（`src/managers/market-manager.ts:1298-1328`）。
- **P2-12c cid 碰撞**：`acex-<Date.now base36>-<seq base36>`，无进程熵；两进程同毫秒首单同 id（`src/managers/order-manager.ts:1139-1155`）。venue 约束 `^[.A-Z:/a-z0-9_-]{1,32}$`。
- **P2-12d OrderSnapshot.type**：公开类型为裸 `string`，Binance 透传原始大写（`LIMIT`/`MARKET`，外部下的条件单可能出现 `STOP_MARKET` 等）；输入侧是 `"limit" | "market"`，不一致（`src/types/order.ts:98-106`、`src/managers/order/snapshot.ts:23-31`）。
- **P2-9 account getters**：`getAccountSnapshot`/`getBalance(s)`/`getPositions`（元素）/`getRiskSnapshot` 返回内部可变引用，调用方可改坏 manager 状态；market 侧已是冻结共享快照模式（PR #79）（`src/managers/account-manager.ts:197-225`）。
- **P2-10 stop()**：同步流程，忽略 `StopOptions{graceful,timeoutMs}`（docs/api.md 已注明 reserved）；不 await in-flight 命令/reconcile（coordinator 靠 generation 丢弃迟到结果）；`activeClients` 构造时 add、普通 stop 不 delete（`src/client/runtime.ts:421-440,71,249`）。
- **P2-7 风控事件**：`parsePrivateMessage` 只放行 `ACCOUNT_UPDATE`/`ORDER_TRADE_UPDATE`/`listenKeyExpired`；被丢消息也不计 watchdog 活性。**我们连的是 PAPI `wss://fstream.binance.com/pm/ws`，其账户风控事件是 `riskLevelChange`（账户级聚合，无 per-position），不是 USDM/CM 独立合约流的 `MARGIN_CALL`**（见 [[binance-papi-risklevelchange-not-margincall]]，官方文档核实）。`riskLevelChange` 字段 `u/eq/ae/m` 与既有 `RiskSnapshot.{riskRatio,netEquity,riskEquity,maintenanceMargin}` 同源（后者由 `mapAccountRisk` 经 REST reconcile 周期填充）。
- **P2-8 分发**：（本批移除，见 Out of Scope）

## Open Questions

- [x] Q1 已决：真 graceful drain（见 Requirements / Decision）
- [x] Q2 已决：**P2-8 整项移出本批不做**——包目前自用、Bun-only，无 Node 兼容需求（2026-06-13 用户决策）
- [x] Q3 已决：`OrderSnapshot.type` 窄化为小写 `OrderType` union + 新增 `rawType?: string` 留底原始串，未知映射归 `"unknown"`（minor changeset）
- [x] Q4 已决（**2026-06-13 二次修订**）：透传 PAPI `riskLevelChange` 为公开事件 `account.risk_level_change`（三态 `margin_call`/`reduce_only`/`force_liquidation` 全透传），**并回填 `RiskSnapshot`**（新增 `riskLevel` 字段 + 用 `u/eq/ae/m` 实时刷新 riskRatio/netEquity/riskEquity/maintenanceMargin，走 watermark）。首版按 USDM `MARGIN_CALL` 形状实现（带 positions 数组）——经独立二审 + 官方文档核实判定为 live 死代码（PAPI 不推 `MARGIN_CALL`），已 `git reset --hard` 回退重做。ACCOUNT_CONFIG_UPDATE 仍只放进 parser 白名单计 watchdog 活性、不转发为事件（等 P2-6 一起设计）。

## Requirements (evolving)

- AsyncEventBus 支持并发 `next()` 不悬挂（pending resolver 队列化，`close()` 全部解析 done）。【Block 1，已实现保留】
- `resumeStreams` 并行恢复，保留 per-stream 错误隔离与防重复启动。【Block 1，已实现保留】
- cid 生成加进程级熵，保持 venue 约束（≤32 字符）与现有前缀识别（`acex-`）。【Block 2，已实现保留】
- `OrderSnapshot.type`（含 `RawOrderUpdate.type`）归一为小写 `OrderType` union，新增 `rawType?: string` 保留 venue 原始串；Binance adapter 提供映射表，未知值归 `unknown`。【Block 2，已实现保留】
- account 读取面与 market 统一为冻结共享快照模式。【Block 3，已实现保留】
- `stop()` 实现真 graceful drain（Q1 已决）：`graceful` 默认 true——runtime 登记 in-flight 订单命令 promise，stop 时等其落定（含 coordinator 在途 reconcile/refresh），`timeoutMs`（默认 5000）超时后强制断；`graceful: false` 立断。修复 `activeClients` 泄漏。【Block 3，已实现保留】
- **风控事件透传 + 风险快照回填（Q4 已决，Block 4 重做）**：
  - parser 放行 `e === "riskLevelChange"`；保留 `ACCOUNT_CONFIG_UPDATE` 进白名单仅计活性、不转发。
  - adapter 新增 `RawRiskLevelChange`（`riskLevel: "margin_call"|"reduce_only"|"force_liquidation"`、`riskRatio`(uniMMR)、`netEquity`(eq)、`riskEquity`(ae)、`maintenanceMargin`(m)，均 optional decimal string，含 exchangeTs/receivedAt）+ `PrivateStreamCallbacks.onRiskLevelChange`。
  - 公开事件 `account.risk_level_change`（`RiskLevelChangedEvent`，载于 `account.events.updates()`），承载上述归一字段。
  - `RiskSnapshot` 新增 `riskLevel?: "normal" | "margin_call" | "reduce_only" | "force_liquidation"`；REST reconcile/bootstrap 若 PAPI account 接口返回账户状态则一并填（codex 核实字段）。
  - 回填：riskLevelChange 到达时用 `u/eq/ae/m` 刷新 RiskSnapshot 对应字段 + riskLevel，走既有 watermark/exchangeTs 时序保护（不覆盖更新的 reconcile 值），发 `risk.updated`；事件本身独立于回填，乱序也发。
  - 被识别但不转发的私有消息计入 WS watchdog 活性。

## Technical Approach

按改动面分四块，互相独立、可分 commit。**Block 1/2/3 已实现并通过双重 review（保留 commit 86fa011/c2f07a3/7e95c58）；Block 4 重做。**

1. **事件总线/流层（patch）**：AsyncEventBus pending resolver 队列化（FIFO，`close()` 全量 resolve done）；`resumeStreams` 改 per-(record,stream) 并行 + `Promise.allSettled`。
2. **订单标识与类型（minor）**：cid 进程熵；`OrderType` union + `rawType` + Binance 映射表（REST openOrders 与 WS ORDER_TRADE_UPDATE 两入口）。
3. **生命周期与读取面（minor）**：account 冻结共享快照；`stop()` graceful drain + `activeClients` 修复 + 下单命令 `assertStarted` 门控。
4. **PAPI riskLevelChange 风控事件 + 风险快照回填（minor）**：parser 放行 `riskLevelChange` → `onRiskLevelChange` callback → coordinator/consumer → account-manager：①发 `account.risk_level_change` 公开事件；②用事件值回填 RiskSnapshot（含新 `riskLevel`，走 watermark）发 `risk.updated`。REST 路径补 riskLevel。夹具用真实 PAPI `riskLevelChange` 形状。docs/api.md + adapter-contract spec 回写 PAPI 事件语义。

## Decision (ADR-lite)

**Context**：P2 工程项批量收尾，5 个条目 4 个设计点需要拍板。
**Decision**（2026-06-13，与用户逐项确认）：
- Q1 `stop()` 做真 graceful drain（默认 graceful、timeoutMs 默认 5000，`graceful:false` 立断）——公开的 `StopOptions` 必须兑现而非继续 reserved。
- Q2 P2-8 整项移除：包自用、Bun-only，无 Node 兼容需求。
- Q3 `OrderSnapshot.type` 窄化为小写 union + `rawType` 留底；为将来 P2-6 条件单铺路。
- Q4 透传 PAPI `riskLevelChange` 三态为 `account.risk_level_change` 事件 + 回填 RiskSnapshot（新增 riskLevel）。不只发孤立事件——风险度量沉淀为可查询状态，让 `getRiskSnapshot()` 在风险骤变瞬间即反映最新值（不等下个 reconcile 周期）。SDK 不替策略做自动风控（撤单/锁仓），那是策略决策权。
**Consequences**：minor changeset（OrderType 收窄 + rawType + risk_level_change 事件 + RiskSnapshot.riskLevel + stop 行为 + assertStarted）+ patch changeset（纯内部修复）；`OrderSnapshot.type` 收窄对把它当任意 string 用的下游是行为变化，beta 阶段可接受。**Q4 首版按 USDM `MARGIN_CALL` 形状实现 + 夹具同错 → 311 测试全绿但 live PAPI 永不触发（死代码）；主 review 漏掉、独立二审 + 官方文档核实抓到，已 reset 重做。教训见 [[binance-papi-risklevelchange-not-margincall]]。**

## Acceptance Criteria (evolving)

- [x] 单测：并发两次 `next()` 后 publish 两条事件，两个 promise 均按序 resolve；close() 时全部 pending resolve done。【Block 1 已过】
- [x] 单测：resumeStreams 一条流失败不阻塞/不影响其他流恢复。【Block 1 已过】
- [x] 单测：两个独立 manager 实例注入相同时钟，生成 cid 不相同。【Block 2 已过】
- [x] 单测：OrderType 映射覆盖 `LIMIT`/`MARKET`/`STOP_MARKET`/未知串（→ `unknown` 且 `rawType` 留底），REST 与 WS 两条入口一致。【Block 2 已过】
- [x] 单测：mutate getter 返回值不影响 manager 后续快照/事件。【Block 3 已过】
- [x] 单测：stop() 后 client 不在 activeClients；graceful 等待 in-flight 命令落定、timeoutMs 超时强断、`graceful:false` 立断。【Block 3 已过】
- [x] 集成/单测：fake 私有流推 `riskLevelChange`（三态，真实 PAPI 形状）→ 收到 `account.risk_level_change` 事件；`getRiskSnapshot()` 的 `riskLevel` 及 `riskRatio/netEquity/riskEquity/maintenanceMargin` 被回填；旧值更新的 reconcile 不被旧事件覆盖（watermark）；该消息计入 watchdog 活性。【集成测试含 stale 事件 watermark 回归】
- [x] 回归：夹具断言事件形状为 `e:"riskLevelChange"`（非 `MARGIN_CALL`），防止退回错误形状。
- [x] `bun run lint` / `type-check` / `test` 全绿（311 pass）；changeset 按 patch/minor 拆分（2 个 changeset）。

### 已知限制（本批不修，已记录跟踪）

- **bootstrap vs stream 竞态**（二审发现）：`onPrivateAccountBootstrap` 无条件全量替换、不走 watermark，先于 bootstrap 到达的 WS 增量（含 riskLevelChange 风控回填）会被较旧 REST 快照覆盖。低危（订阅初期窗口 + ≤5s riskPoll 自愈 + 事件不丢）。**这是既有竞态，非本批引入**；修复涉及 bootstrap 核心水位语义，独立任务处理。已写入 adapter-contract spec 已知限制 + improvement-todo P2-13。

## Definition of Done (team quality bar)

- 单测/集成测试覆盖新行为
- lint / type-check / test 全绿
- docs/api.md 与相关 spec（adapter-contract / order-execution / error-handling 如涉及）回写

## Out of Scope (explicit)

- **P2-8 分发产物（构建 + `.d.ts`）——本批移除不做**：包自用、Bun-only，无 Node 兼容需求；将来要分发给非 Bun 用户时再立项
- P2-11（snapshot_replaced 过重）——本批不做
- 条件单/改单等交易操作面（P2-6）
- **ACCOUNT_CONFIG_UPDATE 转发为事件**（仅放白名单计活性）；杠杆/保证金模式变更事件等 P2-6 杠杆操作面一起设计
- **SDK 侧自动风控**（收到 force_liquidation 自动撤单、reduce_only 拦截增仓单）——策略决策权，reduce_only 前置拦截可留 P2-6
- USDM/CM 独立合约流的 `MARGIN_CALL` 解析——我们只接 PAPI，不为假设的普通合约账户保留死代码
- 浏览器/Deno 支持承诺

## Technical Notes

- 调研详见 [research/code-context.md](research/code-context.md)
- PAPI riskLevelChange 事件形状与字段映射：见 [[binance-papi-risklevelchange-not-margincall]]
- venue cid 约束：`^[.A-Z:/a-z0-9_-]{1,32}$`（src/managers/order/identity.ts:4）
- 既有账户风险填充：`mapAccountRisk`（src/adapters/binance/private-adapter.ts:400，uniMmr→riskRatio / actualEquity→netEquity / accountEquity→riskEquity）
