# 改进待办（2026-06-10 全库 Review）

> 来源：2026-06-10 对 acex 全库的代码 review（覆盖订单/行情/账户三条链路、private-subscription-coordinator、HTTP/限流/时钟/错误基础层、Binance market + private 适配器、测试夹具；juplend 适配器与部分 types 为抽样阅读）。
> 评估标准：项目定位为 **crypto 多交易所量化策略底层 SDK（HFT + LFT）**，因此按 HFT 标准衡量热路径、延迟与可靠性。
>
> 使用方式：每个条目是一个独立可立项的修复单元。开工时建 Trellis 任务并在条目后追加 `→ .trellis/tasks/<dir>`；完成后打勾。行号为 review 时点（commit `2b04f8e`）的位置，后续可能漂移。

## 状态总览

| 优先级 | 含义 | 数量 |
|---|---|---|
| P0 | 实盘资金/状态安全，先于一切 | 3 |
| P1-A | 正确性收尾 | 3 |
| P1-B | HFT 基础能力 | 8 |
| P1-C | 多交易所扩展性 | 5 |
| P2 | 功能缺口与工程项 | 12 |

## P1 批次规划（2026-06-11 梳理，按此顺序执行）

| 批次 | 条目 | 说明 | 状态 |
|---|---|---|---|
| ① 错误体系统一 | A3 + C5 | C5 归一码是 A3 orderState 判定的输入，合并一个任务、一个 minor changeset | 代码完成 → .trellis/tasks/06-11-orderstate-venue-p1-a3-p1-c5 |
| ② 订单生命周期收尾 | A1 + A2 | 都是"订单查不到/claim 悬挂"的终态化处理，共享 fetchOrder 回查模式与测试场景 | 代码完成 → .trellis/tasks/06-11-open-pending-claim-ttl-p1-a1-p1-a2 |
| ③ 事件流质量 | B1 + B2 | 同在事件总线/状态发布路径；B2 是小修可捎带 | 代码完成 → .trellis/tasks/06-11-conflation-status-p1-b1-p1-b2 |
| ④ 限流分层 | B3 | 工作量偏大，独立任务 | |
| ⑤ 时钟自动同步 | B4 | 独立任务；消费批次①的 `timestamp_out_of_sync` 归一码作为 -1021 重校触发信号 | 代码完成 → .trellis/tasks/06-12-p1-b4-clock-resync |
| ⑥ 成交明细字段 | B5 | 公开类型扩展，独立 minor changeset | 代码完成 → .trellis/tasks/06-12-p1-b5-fee-realized-pnl |
| ⑦ 流层打磨 | B6 + B7 + B8 | 三个小项打包成一个任务（B8 仅做 jitter，冗余热备拆后续） | 代码完成 → .trellis/tasks/archive/2026-06/06-12-p1-b6-b7-b8-stream-layer-polish（PR #79；B8 双连接冗余热备待后续任务） |
| ⑧ 多交易所开放点 | C1 + C2 + C3 + C4 | SPI/配置抽象；C3 有正确性成分（交割合约映射已错） | C2/C3/C4 代码完成 → .trellis/tasks/archive/2026-06/06-12-venue-extensibility-foundation-p1-c2-c3-c4（PR #81）；C1 仅内部 venue registry 已做，公开第三方 SPI 按 YAGNI 待真实需求 |

---

## P0 — 实盘正确性（必须先修）

### - [x] P0-1 `cancelAllOrders` 按数组解析 PAPI 的 `{code,msg}` 响应，live 必抛错

- **位置**：`src/adapters/binance/private-adapter.ts:857-878`
- **问题**：代码将 `DELETE /papi/v1/um/allOpenOrders` 响应当作订单数组执行 `responses.flatMap(...)`。Binance 官方文档（Portfolio Margin → Cancel All UM Open Orders）给出的响应是对象：`{"code": 200, "msg": "The operation of cancel all open order is done."}`。运行时 `flatMap is not a function` → 被包装成 `ORDER_CANCEL_ALL_FAILED` 抛出，**而交易所侧实际已全撤成功**，造成"撤单失败"假象与本地状态分歧。
- **为什么测试没拦住**：集成测试夹具按数组 mock（`tests/support/exchanges/binance.ts:632-644`），live smoke 脚本未覆盖 cancelAll（`scripts/live-order-smoke.ts` 无调用）。
- **修复方案**：
  1. 适配器改为按 `{code,msg}` 解析；命令成功后通过本地 open orders（按 symbol 过滤）+ `fetchOpenOrders` 回查合成 `RawOrderUpdate[]`，保持公开契约 `Promise<OrderSnapshot[]>` 不变（契约见 `.trellis/spec/backend/order-execution.md`，修复时同步更新该 spec）。
  2. 修正测试夹具为真实响应形状，新增按对象响应的集成测试。
  3. live-order-smoke 增加 `--cancel-all` 步骤（挂 2 个远端 GTX 单 → cancelAll → 断言 openOrders 为空）。
- **验证方式**：文档级已核实（官方响应示例）；live 验证步骤见[附录 A](#附录-a-cancelallorders-live-验证步骤)。
- **状态**：代码已修复（→ .trellis/tasks/06-10-cancel-all-response-shape）并完成 live 复核（2026-06-10，`ETH/USDC:USDC`，2 笔 GTX 挂单全部由 `cancelAllOrders` 撤成 `canceled`，`remainingOpenOrders.count = 0`，`errors = []`）。

### - [x] P0-2 REST 下单回包与 WS 成交竞态：已成交订单被回退成 `open`

- **位置**：`src/managers/order-manager.ts:1512`（`applyCommandUpdate`）、`src/managers/order-manager.ts:1356`（`mergeOrderStatus`）、`src/internal/watermark.ts:9`
- **问题**：`applyCommandUpdate`（REST 命令回包入库）不经过 `shouldApplyWatermarkedUpdate`。当 WS `ORDER_TRADE_UPDATE`（FILLED，`exchangeTs=T1`）先于 REST ack（NEW，`exchangeTs=T0 < T1`）到达时，`mergeOrderStatus` 仅在 exchangeTs **相等**时保留高优先级状态、`filled` 的 max 合并同样只在相等时生效——时间戳不等则直接覆盖。结果：本地订单回退为 `open` / `filled=0`，事件序列出现 `order.filled` → `order.updated(open)`，幽灵挂单最长存活到下一次 60s reconcile。策略可能据此重复对冲或重复撤单。
- **佐证**：`watermark.ts:10` 已定义 `source: "command"` 但 `shouldApplyWatermarkedUpdate` 没有对应分支——设计上预留了命令源水位，未实现。
- **修复方案**：`createOrder`/`cancelOrder`/`cancelAllOrders` 在发起 REST 前记录 `requestStartedAt`，`applyCommandUpdate` 以 `source: "command"`（或复用 `"rest"`）走 watermark 门控；同时把 `filled` 回退保护从"相等时取 max"放宽为"不小于已知值"。
- **验证方式**：单测构造"WS FILLED 先到、REST ack 后到"序列，断言状态不回退、不发布回退事件；现有 `tests/unit/watermark.test.ts` 增补 command 源用例。
- **状态**：代码已修复（→ .trellis/tasks/06-10-order-command-watermark），`bun run lint` / `bun run type-check` / `bun run test` 通过；该项无需 live 验证。

### - [x] P0-3 `listenKeyExpired` 被丢弃 + 私有流无 watchdog → 私有数据流静默死亡

- **位置**：`src/adapters/binance/private-adapter.ts:530`（`parsePrivateMessage` 只放行 `ACCOUNT_UPDATE`/`ORDER_TRADE_UPDATE`）、`:942`（`createManagedWebSocket` 未配置 `messageWatchdog`，重连固定复用旧 listenKey URL）
- **问题**：listenKey 失效后（keepalive 连续失败、Binance 主动作废、`listenKeyExpired` 事件），重连的 socket 能 open（`readyWhen: "open"` 即视为就绪）但永远无事件。SDK 不报错、不重建 listenKey，订单/账户实时性**静默退化**为 60s 一次的 REST reconcile。对挂单密集策略是严重风险。
- **修复方案**：
  1. `parsePrivateMessage` 放行 `listenKeyExpired`，收到后重建 listenKey 并以新 URL 重建 WS（触发 `onReconnected` → reconcile）。
  2. keepalive（PUT）重试耗尽后同样走重建路径，而非仅 `callbacks.onError`。
  3. 私有流配置 `messageWatchdog`（PAPI 用户流静默期可较长，建议 staleAfterMs 设为分钟级，stale 时主动断开重建并上报 `heartbeat_timeout`）。
- **验证方式**：单测用 fake WS 模拟 `listenKeyExpired` 与 keepalive 失败；live 复核用 `bun run test:live:order:listen-key` 主动作废 listenKey（DELETE listenKey 后观察自动恢复）。
- **状态**：代码已修复（→ .trellis/tasks/06-10-private-stream-listenkey-recovery），`bun run lint` / `bun run type-check` / `bun run test` 通过；`bun run scripts/live-order-smoke.ts --duration 60 --expire-listen-key-after 5` 已用真实凭证复核，DELETE listenKey 后进入 `reconnecting/ws_disconnected`，新 listenKey WebSocket 上线并恢复 `healthy`。

---

## P1-A — 正确性收尾

### - [x] P1-A1 幽灵 open 订单缺少最终驱逐路径

- **位置**：`src/client/private-subscription-coordinator.ts:1050`（backfill 返回 `undefined` 仅报错）
- **问题**：reconcile 发现"本地 open 但交易所快照缺失"的订单走 `fetchOrder` backfill；若交易所已查不到（-2011/-2013 → `undefined`），订单永远留在 open 表，每 60s 重复报错。
- **修复方案**：对连续 N 次（建议 3 次）backfill 失败的订单强制终态化（标记 `expired` 或新增 `unknown` 终态语义）移入 closed，并发布一次明确的 runtime error。
- **验证方式**：集成测试模拟 fetchOrder 持续 -2013，断言 N 轮后订单离开 `getOpenOrders()`。
- **状态**：代码已完成（→ .trellis/tasks/06-11-open-pending-claim-ttl-p1-a1-p1-a2，与 P1-A2 合并实现）：`OrderStatus` 新增 `unknown` 终态；仅"确认不存在"（fetchOrder 返回 undefined）计数，transport 错误不计数；连续 N 次（默认 3，`order.missingOrderEvictionThreshold` 可配）后置 `unknown` 移入 closed，发布终态事件 + 一次 runtime error；计数在 WS 更新/快照重现时清零。

### - [x] P1-A2 `createOrder` 超时后 pending claim 永不清理

- **位置**：`src/managers/order-manager.ts:1451`（`shouldRetainPendingClaimAfterCreateError`）
- **问题**：超时保留 claim 是正确的（订单可能已落地等 WS 认领），但订单实际未到达交易所时，claim 在 `pendingClientOrderIdIndex` 永久泄漏。
- **修复方案**：claim 加 TTL；到期后用 `fetchOrder(origClientOrderId)` 确认一次——查得到则入库，查不到则清理。
- **验证方式**：单测覆盖"超时 + 订单不存在"与"超时 + 订单实际成交"两条路径。
- **状态**：代码已完成（→ .trellis/tasks/06-11-open-pending-claim-ttl-p1-a1-p1-a2，与 P1-A1 合并实现）：claim 记录 `claimedAt`，TTL 默认 90s（`order.pendingClaimTtlMs` 可配），由 reconcile 周期驱动回查——查得到入库、确认不存在清理 + 一次 runtime error、transport 错误保留等下轮；无 fetchOrder 能力的 adapter 保守保留 claim。

### - [x] P1-A3 错误体系缺一等的"订单状态未知"语义

- **位置**：`src/errors.ts:35`（`AcexErrorTransportDetails`）
- **问题**：调用方必须自己理解 `details.transport.kind === "timeout"` 意味着"订单可能已成交"。这是交易 SDK 最关键的错误语义，目前是隐式约定（`.trellis/spec/backend/error-handling.md` 也未覆盖）。
- **修复方案**：`AcexError` 增加显式字段（如 `orderState: "not_placed" | "unknown"`）或提供 `isOrderStateUnknown(error)` 辅助函数；同步更新 error-handling spec 与 docs/api.md。
- **验证方式**：单测断言 timeout/网络中断/венue 拒绝三类错误的 `orderState` 取值。
- **状态**：代码已完成（→ .trellis/tasks/06-11-orderstate-venue-p1-a3-p1-c5，与 P1-C5 合并实现）：`details.orderState` + `isOrderStateUnknown()`，判定矩阵 timeout/network/parse/5xx → `unknown`，venue 拒单/输入校验/限流 → `not_placed`。

---

## P1-B — HFT 基础能力

### - [x] P1-B1 事件流无背压、无 conflation（无界队列）

- **位置**：`src/internal/async-event-bus.ts:58`（per-listener 无界 FIFO）
- **问题**：慢消费者无限积压过期 tick（内存 + 决策延迟双输）；L1 行情天然需要 latest-wins。
- **修复方案**：`stream()` 增加 `{ mode: "conflate" | "buffer", maxBuffer }` 选项；L1/funding 默认 conflate（按 venue:symbol 合并为最新），订单/账户事件默认 buffer + maxBuffer 告警。
- **验证方式**：单测：发布 1000 tick、消费 1 次，conflate 模式只得最新一条；soak 测试观察内存平稳。
- **状态**：代码已完成（→ .trellis/tasks/archive/2026-06/06-11-conflation-status-p1-b1-p1-b2，与 P1-B2 合并实现）：`AsyncEventBus.stream()` 支持 conflate（latest-wins、保插入序、天然有界）/ buffer（默认 maxBuffer=10_000、drop-oldest、每积压 episode 一次 `EVENT_BUFFER_OVERFLOW` 告警、排空重新武装）；公开事件流加 options 第二参，market 流（`EventStreamOptions` 含 mode）l1/funding 默认 conflate，order/account/health/errors 仅 `BufferedEventStreamOptions`；errorBus 自身溢出只丢弃防递归。

### - [x] P1-B2 每个 L1 tick 无条件发布 `market.status_changed` 到三条总线

- **位置**：`src/managers/market-manager.ts:872`（onUpdate → `recomputeAndPublishStatus`）、`:1183`（`publishStatus` 同时打 statusBus + marketBus + healthBus）
- **问题**：状态未变化也每 tick 发布，`events.health()`/`events.status()` 订阅者被刷屏；每秒数千次多余分发、克隆与过滤器调用。
- **修复方案**：`recomputeAndPublishStatus` 对新旧 status 做浅比较（freshness/ready/runtimeStatus/reason/activity），变化才发布；`lastReceivedAt` 类字段不参与比较。
- **验证方式**：单测：连续 N 个 tick 仅产生 1 次 status 事件 + N 次 l1 事件。
- **状态**：代码已完成（→ .trellis/tasks/archive/2026-06/06-11-conflation-status-p1-b1-p1-b2，与 P1-B1 合并实现）：`recomputeAndPublishStatus` 以 `activity/ready/freshness/reason` 四字段为去重 key，相同则跳过三路发布、首次必发；`lastReceivedAt`/`lastReadyAt`/`inactiveSince` 时间戳不参与比较但仍每 tick 更新 record，`getMarketStatus()` 读路径不变。

### - [x] P1-B3 限流器纯被动，scope 粒度与 Binance 语义不匹配

- **位置**：`src/internal/rate-limiter.ts:44`（仅 429/418 后阻塞）、`:153`（scope = venue+account+endpoint）
- **问题**：从不利用已知 endpoint weight 与 `X-MBX-USED-WEIGHT-*` 头做主动预算；429 后只 block 单 endpoint，但 Binance REQUEST_WEIGHT 是 per-IP 全局、订单数是 per-account——其他 endpoint 继续打会升级成 418 IP ban。无撤单优先通道。
- **修复方案**：分层 scope（venue 全局 weight 桶 + per-account order 桶 + endpoint 覆盖）；按响应头回填已用额度做主动节流；预留 cancel/风控请求的保留预算或优先队列。
- **验证方式**：单测模拟 weight 头递增逼近上限时主动延迟；429 后断言全 venue 阻塞而非单 endpoint。
- **状态**：代码已完成（→ `.trellis/tasks/06-11-p1-b3-scope`）：新增 optional rate-limit topology/plan SPI、bucket-level fixed-window budget admission、Binance host/request-weight 与 per-account order 桶、usage header 回填、request-not-sent refund、bucket-level 429/418 block、cancel-priority reserve headroom 与 fallback jitter；core 限流器保持 venue-agnostic，Binance 权重表和 header 解析留在 adapter 层。

### - [x] P1-B4 签名时钟无自动同步回路

- **位置**：`src/client/runtime.ts:116`（`signingClock: options.clock`，默认 `Date.now`）、`src/adapters/binance/server-time.ts`
- **问题**：`fetchBinanceServerTime` 实现质量很好（单调钟 RTT、中点 offset）但没人调度它：无周期重测、无多次采样、无 -1021 自动 resync。本地时钟漂移超过 recvWindow 时全部签名请求失败且无自愈。
- **修复方案**：内置 venue 级 TimeProvider：启动时 N 次采样取中位、周期性重测 + 漂移平滑、收到 -1021（venueError.code）触发立即重校；`options.clock` 保留为覆盖入口。
- **验证方式**：单测注入漂移时钟，断言 offset 收敛与 -1021 触发重校；live account smoke 观察长跑无 -1021。
- **状态**：代码已完成（→ .trellis/tasks/06-12-p1-b4-clock-resync）：新增 core 通用 `SyncingTimeProvider`（`src/internal/`，venue-agnostic，sampler 由 Binance 注入 `fetchBinanceServerTime`），`now()=本地墙钟+平滑 offset`；启动串行采样 5 次取中位、每 5min EMA(α=0.3) 周期重测、`TimeProvider.requestResync?()` 2s 去抖立即重校（直接采纳不走 EMA）；private adapter 归一到 `timestamp_out_of_sync` 时发信号、不持有任何 offset/timer 逻辑；offset 仅作用签名 timestamp，**不污染** freshness/`receivedAt`（隔离单测断言）；`options.clock` 注入时不创建 sampler/timer。失败/漂移经 runtime error stream 上报。`bun run lint`/`type-check`/`test`（245 pass）独立复核通过；patch changeset + adapter-contract spec §签名时钟 + docs/api.md 已回写。live account smoke 长跑复核待安排。

### - [x] P1-B5 成交明细字段全部丢弃（手续费 / 逐笔成交 / 已实现盈亏）

- **位置**：`src/adapters/binance/private-adapter.ts:562`（`mapOrderUpdate` 丢弃 `n/N/l/L/rp`）、`src/adapters/types.ts:160`（`RawOrderUpdate` 无 fee 字段）、`src/types/order.ts:96`
- **问题**：策略无法核算手续费成本、逐笔成交价量与 realized PnL——量化 SDK 的基本盘。
- **修复方案**：`RawOrderUpdate`/`OrderSnapshot` 增加 `fee { cost, asset }`、`lastFillPrice/lastFillQty`、`realizedPnl`（均 optional decimal string）；考虑独立 `order.trade` 事件承载逐笔成交。需要 minor changeset。
- **验证方式**：单测覆盖 ORDER_TRADE_UPDATE 带佣金字段的映射；live order smoke 打印 fee。
- **状态**：代码已完成（→ .trellis/tasks/06-12-p1-b5-fee-realized-pnl）：经核实 Binance per-order 查询接口不返回 fee（仅逐笔 WS/userTrades 有），故采方案 B——新增独立 `events.order.trades()` buffer 流承载 `OrderTrade { tradeId, price, qty, fee{cost,asset}, realizedPnl, maker, positionSide, ... }`，**`OrderSnapshot` 公开字段不变**（下游按 orderId 关联累加）。trade 发布独立于快照 watermark（乱序被拒仍发）；去重键 `(symbol, tradeId)` 有界 1024 FIFO（期货 tradeId 仅按 symbol 唯一）；`seq` 供 gap 检测。codex 实现 + Claude diff review + codex 对抗式二审（抓到去重漏 symbol 的 blocker 已修 + 补跨 symbol 回归）；`bun run lint`/`type-check`/`test`(256 pass) 独立复核通过；minor changeset + adapter-contract/order-execution spec + docs/api.md 已回写；live smoke 加逐笔 fee 打印，long-run live 复核待安排。既有 P2-12（AsyncEventBus 并发 next 覆盖）被高频 trades 流放大触发面，本 PR 未修。

### - [x] P1-B6 行情热路径分配偏重

- **位置**：`src/internal/decimal.ts:13`（每字段 new BigNumber + toFixed）、`src/managers/market-manager.ts:969`（每 tick 4× toCanonical + 2 次克隆）、`src/internal/subscription-multiplexer.ts:430`（每消息 `[...sub.subscribers]` 拷贝）
- **问题**：Binance 推送本就是 decimal string 且绝大多数已是 canonical 形态；逐 tick 的 BigNumber 往返与对象克隆构成稳定 GC 压力。
- **修复方案**：`toCanonical` 加字符串快速路径（正则判定已 canonical 则原样返回）；单订阅者时跳过数组拷贝；事件 snapshot 改为冻结对象复用而非每次克隆。
- **验证方式**：bench 脚本对比每 tick 分配数（Bun `--smol`/heap 统计）；行为单测不回归。
- **状态**：代码已完成（→ .trellis/tasks/archive/2026-06/06-12-p1-b6-b7-b8-stream-layer-polish，PR #79）：`toCanonical` 加 string canonical 快速路径（保守正则，property/fuzz 测试证明匹配串逐字节等于 `toFixed()`、无 false positive）；`subscription-multiplexer` 单订阅 fan-out 免数组拷贝（捕获唯一 subscriber、不迭代 live Set）；market L1/funding/status 改为变更时构建 `Object.freeze` 快照、发布与 getter 共享冻结引用替代每 tick 克隆。bench `scripts/bench-market-tick.ts` 实测稳态 ≈2.26 bytes/tick。codex 实现 + Claude diff review + codex 对抗式二审（抓到单订阅迭代 live Set 的 fan-out blocker，已修 + 补 stash 验证过的回归测试）；`bun run lint`/`type-check`/`test`（262 pass）独立复核通过；patch changeset。

### - [x] P1-B7 低流动性 symbol 被误判 stale（把"无变动"当"断流"）

- **位置**：`src/internal/subscription-multiplexer.ts:480`（per-sub staleTimer 基于该 symbol 自身消息间隔）
- **问题**：bookTicker 仅在盘口变化时推送；冷门币 15s 不动即被标 `stale`（reason 还是 `heartbeat_timeout`），策略侧"可交易性"信号失真。连接级 watchdog 已存在，语义重复且更准。
- **修复方案**：per-sub stale 仅在连接级也静默时触发，或区分 reason（`no_update` vs `heartbeat_timeout`）；文档明确 freshness 语义。
- **验证方式**：单测：连接持续有其他 symbol 消息时，静默 symbol 不标 stale（或 reason 为 no_update）。
- **状态**：代码已完成（→ 批 ⑦ 同一任务，PR #79）：采方案 B——移除 per-subscription 独立 stale 定时器，freshness 仅由连接级 watchdog/断连驱动；连接健康时静默 symbol 保持 `fresh`（bookTicker 无推送=盘口未变=缓存盘口仍有效），真正断流仍标 `heartbeat_timeout`。`StaleReason` 公开类型不变（仍仅 `heartbeat_timeout`），无公开类型变更；per-symbol 活跃度迁移给下游按 `lastReceivedAt` 自算。freshness 语义已回写 adapter-contract spec + docs/api.md。

### - [x] P1-B8 重连无 jitter、单连接无冗余

- **位置**：`src/internal/managed-websocket.ts:148`（指数退避无抖动）、`src/adapters/binance/stream-protocol.ts:63`（connectionKey = base URL，一个 family 一条连接）
- **问题**：网络抖动后多连接同步重连（thundering herd）；单连接断开即该 family 全部行情中断，HFT 常用的双连接热备无入口。
- **修复方案**：退避加 ±20% jitter（一行）；多路复用器增加可选 `redundancy: 2`（同流双订阅、按 receivedAt 去重取先到）作为后续增强。
- **验证方式**：jitter 单测；冗余模式 soak 验证断一条连接行情不中断。
- **状态**：jitter 已完成（→ 批 ⑦ 同一任务，PR #79）：`managed-websocket` 指数退避加默认 ±20% jitter（可注入 `random`，复用 http-client/rate-limiter 范式），消除 thundering herd；单测注入确定性 RNG 断言抖动边界 + clamp，并补默认 `Math.random` fallback 路径测试。**双连接冗余热备（`redundancy: 2`）按原计划属后续增强，已从本批拆出、本 PR 未实现**，留作后续独立任务/roadmap 跟踪。

---

## P1-C — 多交易所扩展性

### - [ ] P1-C1 适配器不可插拔（硬编码 Binance + Juplend）

- **位置**：`src/client/runtime.ts:112-126`
- **问题**：SPI（`src/adapters/types.ts`）本身是交易所无关的，但 `CreateClientOptions` 没有注册自定义 adapter 的入口——新交易所/第三方只能改 SDK 源码。"多交易所 SDK"的核心承诺没有开放点。
- **修复方案**：`createClient({ adapters: { market?: MarketAdapter[], private?: PrivateUserDataAdapter[] } })` 注入口 + SPI 类型从入口导出并标注稳定性（experimental）。需要 minor changeset。
- **验证方式**：集成测试注册一个 fake venue adapter 走通 market + order 全链路。
- **状态**：仅"内部 venue→工厂 registry"部分实现（→ 批⑧ 同任务，PR #81）：runtime 构造改 venue 工厂映射、Binance 工厂注入共享 catalog + 时钟生命周期、工厂收静态类型 per-venue options。**公开第三方 adapter 注入（`createClient({ adapters })`）+ SPI 导出按 YAGNI 未做、待真实需求**（评审判定：典型下游用内置 venue，第三方注入小众，导出 SPI 有 semver 成本）。

### - [x] P1-C2 venue 专属配置泄漏进通用协调器

- **位置**：`src/client/private-subscription-coordinator.ts:119-127`（`binanceRiskPollIntervalMs`/`binancePrivateReconcileIntervalMs` 被用作所有 venue 的调度参数）
- **修复方案**：配置改为 per-venue 命名空间（`account: { [venue]: { riskPollIntervalMs, privateReconcileIntervalMs } }` 已有雏形），协调器按 record.venue 取值；旧字段保留兼容期。
- **验证方式**：单测两 venue 不同 interval 互不影响。
- **状态**：代码已完成（→ 批⑧ 同任务，PR #81）：删旧 `account.binance`/`account.juplend`/顶层 `listenKeyKeepAliveMs`，统一进 `account.venues.{binance,juplend}`（异构 per-venue，breaking minor，不留兼容别名）；协调器按 `record.venue` 取构造期快照，**Juplend 不继承 CEX reconcile/riskPoll 默认**；`privateReconcileIntervalMs:0` 关周期 reconcile。grep-gate 全仓迁移（含 docs/scripts/tests/spec，CHANGELOG 历史除外）。

### - [x] P1-C3 私有链路 symbol 归一化是字符串后缀 hack

- **位置**：`src/adapters/binance/private-adapter.ts:227`（`normalizeUmSymbol` 硬编码 quote 列表 endsWith 切割）vs `src/adapters/binance/market-catalog.ts:143`（exchangeInfo base/quote 正路）
- **问题**：两套归一化平行存在；交割合约（`BTCUSDT_250627`）私有链路产物与 catalog（`BTC/USDT:USDT-20250627`）已不一致。
- **修复方案**：私有适配器持有/查询 market catalog 的 venueId→unified 映射（注入或懒加载），删除后缀推断。
- **验证方式**：单测覆盖交割合约、`1000SHIBUSDT`、多 quote 资产符号双向映射。
- **状态**：代码已完成（→ 批⑧ 同任务，PR #81）：抽出共享 family-scoped `BinanceMarketCatalog`（single-flight 加载 / 原子 swap / delivery tombstone / miss-refresh cooldown+失败短 backoff）注入 market+private 两 adapter；私有 UM 归一改查 catalog、删后缀 hack，修交割合约错配（`BTCUSDT_250627`→`BTC/USDT:USDT-20250627`，family-scoped 防 spot/usdm 同名串）。miss 安全：命令 `toVenueId` miss→refresh+retry→`SymbolMappingError`/catalog 预热失败 preflight→`orderState:not_placed`+清 pending claim；入站 WS 帧 miss→有界 quarantine→refresh→replay（**不丢逐笔成交**），仅 replay 仍 drop 时触发一次 immediate reconcile；REST 路径 refresh 后 inline 重映射。只实现 UM，catalog 查找 family-scoped 为 spot/CM 留扩展。

### - [x] P1-C4 流协议层无客户端心跳钩子

- **位置**：`src/internal/subscription-multiplexer.ts:24`（`VenueStreamProtocol` 接口）
- **问题**：OKX/Bybit 要求客户端主动 ping（文本帧），当前协议接口没有位置，接入时必须改 multiplexer。
- **修复方案**：协议接口增加可选 `heartbeat?: { intervalMs, frame(): string, isPong(msg): boolean }`，multiplexer 通用调度。
- **验证方式**：fake 协议单测：按 interval 发 ping、pong 计入活性。
- **状态**：代码已完成（→ 批⑧ 同任务，PR #81）：`VenueStreamProtocol` 加可选 `heartbeat`（`intervalMs/mode(idle|fixed)/pongTimeoutMs/frame()/isPong(raw)/countAnyInboundAsActivity`，形状依 OKX/Bybit/Gate 协议调研——OKX 文本 ping idle<30s、Bybit JSON 固定 20s 且 linear pong 的 op 仍是 ping、Gate-futures 靠协议层 pong）。实现落 `managed-websocket`：raw `isPong` 先于 parse 消费、idle/fixed 调度、pong 超时复用 raw `socket.close()`→既有 reconnect+replay、timer 生命周期（close/重连清理、不重复 ping、pong 不清 initial timeout）。协议层 ping/pong 交 Bun WebSocket，未建模 `transportPingPong`。Binance 未配 heartbeat→零行为变化。

### - [x] P1-C5 venue 错误码不归一

- **位置**：`src/errors.ts:30`（`venueError.code` 直接透传原始码）
- **问题**：策略层想区分"余额不足/post-only 会吃单/订单不存在/价格超滤"必须写 Binance 专属逻辑。
- **修复方案**：定义小而稳的归一枚举（`insufficient_balance` / `would_take` / `order_not_found` / `filter_violation` / `rate_limited` / `timestamp_out_of_sync` / `unknown`），适配器提供映射表，原始码继续保留在 `venueError`。
- **验证方式**：单测覆盖 -2010/-2011/-2013/-4131 等常见码映射。
- **状态**：代码已完成（→ .trellis/tasks/06-11-orderstate-venue-p1-a3-p1-c5，与 P1-A3 合并实现）：`VenueErrorReason` 七成员枚举 + `details.venueError.reason`；映射表按官方文档核实（PAPI UM 余额/保证金不足是 -2018/-2019 而非 spot 的 -2010；-5022 GTX 拒单 → `would_take`；-2010 等语义不确定码归 `unknown`），依据见任务 research/binance-error-codes.md。

---

## P2 — 功能缺口与工程项

### 功能缺口（按量化 SDK 必备面）

- [ ] **P2-1 WS-API 下单**：Binance 支持 WebSocket API 下单，往返延迟显著低于 REST；HFT 标配。涉及新传输层，建议独立设计（`src/adapters/binance/private-adapter.ts` 当前 REST-only）。
- [ ] **P2-2 L2 增量深度 / trades 流 / K线**：`MarketAdapter`（`src/adapters/types.ts:74`）只有 L1 + funding 两种流；L2 需要 REST snapshot + diff 序列号拼接的有状态 assembler 抽象，是"LFT→HFT"主线中工作量最大的一项。
- [ ] **P2-3 testnet/sandbox**：base URL 全部硬编码主网（private-adapter.ts:157、stream-protocol.ts:45-48、market-catalog.ts:62-67）；`sandbox` 选项是预留位。建议 adapter 构造参数支持 endpoint 覆盖。
- [ ] **P2-4 可观测性**：logger/logLevel 预留位未实现；无下单 RTT/WS 消息延迟打点、无指标钩子。建议先做最小事件钩子（`onMetric(name, value, tags)`）。
- [ ] **P2-5 查询面**：closed orders 内部存了 500/symbol（order-manager.ts:75）却无 `getClosedOrders()`；无成交历史/资金费历史 API。
- [ ] **P2-6 交易操作面**：改单（amend）、条件单、杠杆/持仓模式设置、资金划转均缺失（与 capabilities 声明一致，属 roadmap 性缺口）。
- [ ] **P2-7 账户配置事件**：`ACCOUNT_CONFIG_UPDATE`（杠杆变更）、`MARGIN_CALL` 被 `parsePrivateMessage` 丢弃（private-adapter.ts:530）；风控视角应至少透传 MARGIN_CALL。
- [ ] **P2-8 分发产物**：package.json 只发布裸 `.ts`（`exports: "./index.ts"`）——Node 消费者无法直接使用、无 `.d.ts`。若目标用户含非 Bun 环境，需要构建产物（tsup/bun build + types）。

### 工程小项

- [ ] **P2-9 读取 API 克隆策略不一致**：`getAccountSnapshot`/`getBalances` 返回内部对象引用（account-manager.ts:185-196），market 侧每次克隆——统一为冻结或克隆，防调用方改坏内部状态。
- [ ] **P2-10 `stop()` 语义**：不等待 in-flight 命令/reconcile，`StopOptions` 被忽略（runtime.ts:262）；`activeClients` 只增不减（runtime.ts:61,109）。明确 graceful stop 语义（排空 vs 立断）并修泄漏。
- [ ] **P2-11 `order.snapshot_replaced` 事件过重**：每 60s reconcile 发布 open+closed 全量数组（order-manager.ts:608-630）；建议只含 open 或提供增量形态。
- [ ] **P2-12 杂项**：`resumeStreams` 串行恢复订阅慢（market-manager.ts:1187，可并发）；`AsyncEventBus` 迭代器并发 `next()` 覆盖 `pendingResolve` 悬挂前一个 promise（async-event-bus.ts:78）；本地 cid 双进程同毫秒可碰撞（order-manager.ts:1394，可加进程随机前缀）；`OrderSnapshot.type` 是 venue 原始大写字符串与输入侧 `"limit"` 不一致（types/order.ts:103）。

---

## 不需要动的（review 确认的良好实践）

watermark 双时钟水位设计（`watermark.ts`）；下单/撤单严格不重试 + 只读幂等重试的区分（private-adapter.ts:162-169）；订阅复用器控制帧 5/s 节流 + 批量合并 + 退订排空再关连接（subscription-multiplexer.ts:694）；HTTP 层全面密钥脱敏（http-client.ts:152）；`normalizeOrderInput` 步长/最小名义值校验（market-manager.ts:316）；coordinator 的 generation 防竞态模式；unit/integration/soak/live 测试分层。

---

## 附录 A：cancelAllOrders live 验证步骤

**已完成**：文档级验证。Binance 官方文档（Derivatives → Portfolio Margin → Trade → Cancel All UM Open Orders，`DELETE /papi/v1/um/allOpenOrders`）响应示例为：

```json
{ "code": 200, "msg": "The operation of cancel all open order is done." }
```

即对象而非订单数组，与 `private-adapter.ts:863` 的 `signedRequest<BinancePapiOpenOrder[]>` + `flatMap` 假设矛盾。

**live 复核步骤**（需要开通 Portfolio Margin 的真实账户；PAPI 无公开 testnet）：

1. 选低价合约（如 `ETHUSDT`），下一笔**远离盘口的 GTX（post-only）限价买单**：价格 ≈ 现价 × 0.5（不会成交、不吃单），数量满足 minNotional（约 20 USDT 名义值）。可用现有 `bun run test:live:order:smoke` 流程或手动 REST。
2. 确认 `GET /papi/v1/um/openOrders` 中可见该订单。
3. **直接打原始接口观察响应体**（绕过 SDK，10 行脚本）：

   ```ts
   // scripts/tmp-cancel-all-probe.ts — 用后即删，或并入 live-order-smoke --cancel-all
   import { createHmac } from "node:crypto";
   const key = process.env.BINANCE_PAPI_API_KEY!;
   const secret = process.env.BINANCE_PAPI_SECRET!;
   const qs = `symbol=ETHUSDT&timestamp=${Date.now()}&recvWindow=5000`;
   const sig = createHmac("sha256", secret).update(qs).digest("hex");
   const res = await fetch(
     `https://papi.binance.com/papi/v1/um/allOpenOrders?${qs}&signature=${sig}`,
     { method: "DELETE", headers: { "X-MBX-APIKEY": key } },
   );
   console.log(res.status, await res.text()); // 预期: 200 {"code":200,"msg":"The operation of cancel all open order is done."}
   ```

4. 记录原始响应体（这就是夹具应有的形状）；再 `GET openOrders` 确认为空。
5. 修复后用 SDK 路径重复 1-2-4：`client.order.cancelAllOrders(...)` 应返回被撤订单的 `OrderSnapshot[]` 且不抛错。

**风险控制**：全程只挂 far-from-market 的 post-only 单，不会产生成交与手续费；验证完确认无残留挂单。

## 附录 B：review 覆盖范围

- 通读：managers/（order/market/account 前 400 行）、client/（runtime、context、private-subscription-coordinator）、internal/ 全部、adapters/binance/ 全部、adapters/types.ts、errors.ts、types/order.ts、相关测试夹具。
- 抽样：account-manager 后半、adapters/juplend/、types/ 其余文件、docs/api.md。
- 未做：依赖审计（bignumber.js/@solana/web3.js 版本与供应链）、性能基准实测、juplend 链路深审。
