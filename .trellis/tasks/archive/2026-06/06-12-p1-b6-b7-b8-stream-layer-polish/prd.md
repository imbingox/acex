# P1-B6 + P1-B7 + P1-B8 流层打磨（hot-path 分配 / stale 语义 / 重连 jitter）

## Goal

把行情流层从"LFT 够用"提到"HFT 可用"：消除每 tick 的稳定 GC 压力（B6）、修正低流动性 symbol 被误判 stale 的语义失真（B7）、消除网络抖动后的重连风暴（B8 jitter）。三项同在 stream 热路径/连接层，打包成一个任务；其中 B8 的"双连接冗余热备"工作量大且是增强性质，**拆为后续独立任务**，本批只做 jitter。

来源：2026-06-10 全库 review（批次规划 ⑦，见 `docs/improvement-todo.md`）。批次 ①~⑥ 已代码完成，本批是 P1-B 的收尾。

## What I already know（代码勘察 @ commit d93eb97）

### B6 行情热路径分配偏重（性能）
- `src/internal/decimal.ts:13-18`：`toCanonical` 无条件 `new BigNumber(value).toFixed()`，**无字符串快速路径**。Binance 推送本就是 decimal string 且绝大多数已是 canonical 形态。
- `src/managers/market-manager.ts:1045-1048`：每个 L1 tick `toCanonical` ×4（bid/ask price/size）；funding `:1072` ×1。
- 发布/读取路径每次浅克隆：`cloneL1Book`/`cloneStreamStatus`/`cloneFundingRate`（`:139-145`），publish 时 `:934` 再 `cloneL1Book(record.l1Book)`，getter（`:459/468`）也各自克隆。
- `src/internal/subscription-multiplexer.ts:430`：每条消息 `for (const s of [...sub.subscribers])` 复制订阅者数组；循环体内已有 `if (!sub.subscribers.has(s)) continue`（:431/443）防迭代中删除。

### B7 低流动性 symbol 被误判 stale（正确性/语义）
- `subscription-multiplexer.ts:9`：`StaleReason = "heartbeat_timeout"`，**仅此一种**。
- per-sub `staleTimer`（`:488-495`）基于**该 symbol 自身消息间隔**，超 `staleAfterMs` 即 `markSubStale(sub, "heartbeat_timeout")`（`:592` 设 `freshness="stale"` 并回调 `onFreshnessChange`）。
- 连接级 watchdog 已存在且语义更准：`markAllStale(connection, "heartbeat_timeout")` 在 messageWatchdog（`:293-295`，同样用 `staleAfterMs`）与断连（`:375`）触发。
- **关键映射**（`market-manager.ts:1113-1125`）：`ready = l1Ready || fundingRateReady`，**不依赖 freshness**；freshness 由 `resolveFreshness` 决定，`reason = freshness==="stale" ? staleReason : undefined`。→ 冷门币不会变 `ready=false`，但会 `freshness="stale" + reason="heartbeat_timeout"`，刷三条总线。按 `freshness==="fresh"` 门控的策略会把"连接健康、盘口未变"误判为不可交易。
- bookTicker 仅在盘口变化时推送：无推送 == 无变化 == 缓存盘口仍是当前盘口，标 stale 语义错误；真正的断流由连接级 watchdog 负责。
- **公开类型影响**：`reason` 同时出现在 **adapter SPI**（`adapters/types.ts:42/60/230`，`onFreshnessChange(freshness:"stale", reason:"heartbeat_timeout")`）和 **market 公开类型**（`types/market.ts:66`，`reason?: "ws_disconnected" | "heartbeat_timeout" | "reconciling"`）。新增 `no_update` 枚举值 → **minor changeset**。

### B8 重连无 jitter（可靠性）
- `src/internal/managed-websocket.ts:148-150`：`delay = Math.min(initialDelayMs * multiplier ** attempts, maxDelayMs)`，**纯指数退避无抖动** → 网络抖动后多连接同步重连（thundering herd）。
- 仓内已有成熟 jitter 注入范式可直接复用：`http-client.ts:570-573`（`jitterRatio` 默认值 + `random = retryPolicy.random ?? Math.random`，`baseDelay + baseDelay*jitterRatio*(random()*2-1)`）、`rate-limiter.ts:89`（`random ?? Math.random`）。→ 注入 `random` 即可确定性单测。
- `stream-protocol.ts:63-100`：`connectionKey` 按 `descriptor.market.family`，一 family 一连接 → 单连接断开该 family 全行情中断。**双连接冗余热备拆为后续任务（见 Out of Scope）**。

### 通用约束
- decimal 统一走 `toCanonical`；公开类型扩展须回写 `docs/api.md` + `.trellis/spec/backend/`（market-data / adapter-contract 相关 spec）。
- changeset：B6 纯内部 perf = patch；B7 方案 B 无公开类型变更 = patch；B8 jitter = patch。**整批 patch。**

## Open Questions

- ~~Q1（B7 语义）~~ → **已定：方案 B**（连接健康时 per-sub 不标 stale，仅连接级 watchdog 负责）。
- ~~Q2（bench）~~ → **已定：是**，随 PR 提交一个 bench 脚本作回归基线。

## Decision (ADR-lite)

**Q1 B7 freshness 语义 → 方案 B（连接健康时 per-sub 不标 stale）**
- Context：per-sub `staleTimer`（multiplexer.ts:488-496）基于单 symbol 自身消息间隔，超 `staleAfterMs` 即标 `freshness="stale", reason="heartbeat_timeout"`。但 bookTicker 仅在盘口变化时推送——多路复用共享连接下，连接活着就意味着"无推送 == 无变化 == 缓存盘口即当前盘口"，标 stale 是语义错误，会让按 `freshness==="fresh"` 门控的策略误判健康连接上的冷门币不可交易。
- 核实（@ d93eb97）：连接级 watchdog 已真实生效——`managed-websocket` 的 `messageWatchdog`（multiplexer.ts:292-297）在整条连接 `staleAfterMs` 无任何消息时 `markAllStale(connection,"heartbeat_timeout")`；重连 `handleOpen`（:375）亦补标。即真正的断流/僵连由连接级负责，无遗漏。
- Decision：**移除 per-sub 独立 stale 机制**——删 `scheduleSubStaleTimeout`(:480-496) 调用与定义、`markSubStale`(:592，移除后无调用方)、`SubState.staleTimer` 字段及 `clearSubTimers` 中的清理、以及死状态 `SubState.lastMessageAt`(:69/192/427，仅写不读)。freshness 仅由连接级 watchdog/断连驱动。
- Consequences：朴素 `freshness==="fresh"` 门控被修正；`StaleReason` 公开类型**不变**（仍仅 `heartbeat_timeout`）→ **B7 为 patch，非 minor**。失去 SDK 内建 per-symbol"多久没动"信号 → 迁移给下游按现有 `lastReceivedAt` 自算（属"活跃度/age"维度，本不应混入 freshness）。需更新/删除断言 per-sub 独立 stale 的既有单测。
- 已弃方案：A（加 `no_update` 公开枚举 = minor，且 freshness 仍 stale 救不了朴素门控）；C（freshness 不翻+另出 age 指标，公开面过大、超出打磨范围）。

**Q2 bench 脚本 → 是**
- B6 随 PR 提交一个 bench 脚本（`scripts/` 下，Bun 内存/分配统计）作为每-tick 分配回归基线，避免性能改造被后续无声回退。

## Requirements (evolving)

### B6（性能，patch）
- `toCanonical` 加字符串快速路径：仅当入参是**已证明等于 `BigNumber.toFixed()` 输出**的 canonical 字符串时原样返回（保守正则 + 对 BigNumber 做 fuzz 等价测试，杜绝 `"1.50"`/`".5"`/`"1e5"`/`"+1"`/`"01"` 等误判）。
- `subscription-multiplexer.ts:430`：`sub.subscribers.size === 1` 时跳过 `[...]` 拷贝，直接迭代（保留 `.has()` 守卫语义）。
- market snapshot 改为**每次变更构建一个冻结对象并复用引用**，发布与 getter 共享该冻结引用而非每次克隆（`Object.freeze`，内部不得再 mutate → 单测兜底）。
- 提交 bench 脚本（`scripts/` 下，Bun 内存/分配统计）对比改造前后每 tick 分配；行为单测不回归。

### B7（语义，patch）
- 实现方案 B：移除 per-sub 独立 stale（删 `scheduleSubStaleTimeout` 调用+定义、`markSubStale`、`SubState.staleTimer` 与 `clearSubTimers` 中清理、死状态 `lastMessageAt`）。freshness 仅由连接级 watchdog/断连驱动。
- `StaleReason` 公开类型不变；更新 freshness 语义文档（spec + docs/api.md：明确"连接活着即 fresh，per-symbol 活跃度走 lastReceivedAt"）。
- 单测：连接持续有其他 symbol 消息时，静默 symbol 的 freshness 保持 `fresh`；整条连接静默 `staleAfterMs` 仍正确 `markAllStale("heartbeat_timeout")`；重连补标不变。更新/删除断言 per-sub 独立 stale 的既有单测。

### B8 jitter（可靠性，patch）
- `managed-websocket` 退避加 ±20% jitter，复用 http-client 范式：新增可选 `random?: () => number`（默认 `Math.random`）+ `jitterRatio`（默认 0.2），`delay = clamp(base ± base*ratio*(random()*2-1), 0, maxDelay)`。
- 单测：注入确定性 `random` 断言 jitter 边界与不超过 `maxDelayMs`。

## Acceptance Criteria (evolving)

- [ ] B6：bench 显示每 L1 tick 分配数显著下降（toCanonical 快速路径命中 + 单订阅免拷贝 + 免克隆）；所有 market 行为单测不回归。
- [ ] B6：`toCanonical` 快速路径输出与原 `BigNumber.toFixed()` 对一组 fuzz 输入逐一字节相等。
- [ ] B7：连接健康、仅某 symbol 静默 `staleAfterMs` 时，其 `freshness` 保持 `fresh`（不再误标 stale）；整条连接静默 `staleAfterMs` 仍 `markAllStale("heartbeat_timeout")`，重连补标不变。
- [ ] B8：注入递增 attempts，退避带 ±20% 抖动且 `<= maxDelayMs`，`random` 可注入确定性测试。
- [ ] lint / type-check / test 全绿。
- [ ] changeset = **patch**（B6/B7/B8 均无公开类型变更）+ 相关 spec + docs/api.md 同步。

## Definition of Done

- 单测覆盖三项核心路径（含 B6 fuzz 等价、B7 选定语义、B8 jitter 边界）。
- lint / type-check / test 全绿。
- changeset = **patch**（B6/B7/B8 均无公开类型变更）。
- 行为变更回写 spec（market-data / adapter-contract）+ docs/api.md。

## Out of Scope

- **B8 双连接冗余热备（`redundancy: 2`）**：工作量大、增强性质，拆为后续独立任务。
- **单流死亡而连接存活的检测**（方案 B 取舍）：多路复用共享连接下，仅当整条连接静默才标 stale；交易所只停推单个 stream 而其他 stream 仍活的罕见情形不再经 freshness 反映（连接为 liveness 单元）。下游如需可按 `lastReceivedAt` 自行计算 per-symbol age。
- B6 之外的更激进重写（如零拷贝 ring buffer、SharedArrayBuffer）。
- P1-C 系列（适配器可插拔、venue 配置命名空间、symbol 归一化、心跳钩子）。

## Technical Notes

- 行号为 commit `d93eb97` 时点。
- jitter 注入范式参照：`src/internal/http-client.ts:570-573`、`src/internal/rate-limiter.ts:89`。
- B7 公开类型触点：`src/adapters/types.ts:42/60/230`、`src/types/market.ts:66`。
- freshness→ready 映射：`src/managers/market-manager.ts:1113-1125`（ready 不依赖 freshness）。
- 关联未修项：P2-12（`AsyncEventBus` 并发 `next()` 覆盖 `pendingResolve`）不在本批。
