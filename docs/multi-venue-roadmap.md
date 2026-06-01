# 多 Venue 就绪度评估与路线图

> 内部规划文档（不随 npm 包发布，`package.json#files` 仅含 `index.ts`、`src/`、`docs/api.md`）。
> 与 `docs/architecture.md` 同级，记录"接入第二个中心化交易所之前真正欠缺的基础设施"这一结论。
>
> - **基线 commit**：`8dc5118`
> - **结论来源**：主分析 + codex 子智能体独立对抗性复核（逐条进代码核行号）
> - **代码锚点状态**：标 ✓ 的为本文档撰写时在 `8dc5118` 重新核实；标 ⟂ 的为复核引用、本次未重核（同一 commit，未改动）

---

## 0. 一句话结论

真正欠的不是"再写一个 adapter"，而是 **「连接复用 + 共享 REST/限流/时钟」这层通用基础设施 + 行情侧多 venue 改造**。

用户最初点名的 "Binance 多 symbol 各开一条 WS" 问题，本质就是**连接复用层缺失**的症状，而不是一个孤立 bug。两轮 AI 分析结论一致；复核额外纠正了"私有侧并非完全 venue-agnostic"，并补出 time provider、credential validator、symbol 边界、事件背压几个容易在接所中途才踩到的坑。

---

## 1. 复核修正：主体成立，但有 7 处原表述需收敛

codex 逐条进代码核实，确认 P0-1、P0-2、P1-4、P2 成立，并修正了以下表述：

| 原表述 | 复核后的修正 |
|---|---|
| "私有链路已是**真正的**多 venue 架构" | ⚠️ **夸大**。adapter 路由确实 Map 化了，但仍残留多处 venue 特判（见 §4），不能算完全 venue-agnostic。 |
| "OKX/Bybit/Gate **接不进来**" | ⚠️ **过绝对**。准确说：基线 `createManagedWebSocket` 缺少 `send()`、subscription state tracking、订阅 ACK handling 与重连后 replay hooks；若遵守 adapter-contract §3.9「所有 WS 必须走 `createManagedWebSocket`」(`adapter-contract.md:168` ✓)，adapter 无法实现 OKX/Bybit 这类 JSON-subscribe 模型。adapter 技术上能绕开契约自己 `new WebSocket`，只是违规。 |
| "带行情的新所会被 MarketManager 拒掉" | ⚠️ 应精确为「**不能与 Binance 并存**」——若把单 adapter 换成单个 OKX adapter，理论上能只跑 OKX。 |
| Binance REST fetch "2 处" | ❌ **漏了** `market-catalog.ts:215` (✓ `fetchJson`)；实际为 catalog + signed (`private-adapter.ts:885` ⟂) + listenKey (`:946` ⟂) **三处**。 |
| "无统一 timeout" | ⚠️ Juplend 自己的 `readJson` **已实现 timeout**(`juplend/private-adapter.ts:263` ⟂)；缺的是*共享*的 timeout/retry/错误归一。 |
| "grep 不到限流" | ⚠️ 字面不准——能 grep 到 `rate_limited` **状态类型**(`shared.ts:134` ⟂)，但**没有任何实现**。 |
| venue 硬编码只列了 runtime + coordinator | ⚠️ **还漏两处**：`OrderManager.subscribeOrders()` 也硬拒 juplend (`order-manager.ts:104` ⟂)、`hasPrivateCredentials()` 对 juplend 特判 (`context.ts:106` ⟂)。 |

---

## 2. 遗漏的 6 个基础组件（复核补充，价值高）

1. **时钟同步 / timestamp provider** — Binance 签名直接 `Date.now()`(`private-adapter.ts:874` ⟂)。OKX/Bybit/Gate 的私有 REST/WS 对时钟漂移敏感，这是系统性失败点。应抽统一 time provider（含 server-time 校准）。
   - 注：`ManagedWebSocket` 已有 `now = options.now ?? Date.now` 注入点(`managed-websocket.ts:50` ✓)，adapter-contract §3.8 也已写明"不信任交易所时钟"(`adapter-contract.md:160-163` ✓)——基础位已留，但没有统一 provider。
2. **credentials 验证契约不通用** — `hasPrivateCredentials()` 只认 `apiKey+secret`(`context.ts:106` ⟂)，但 OKX 需要 **passphrase**。`AccountCredentials` 虽有 `password/extra`(`shared.ts:57` ⟂) 却没有 per-adapter 的 credential validator。
3. **`PrivateStreamOptions` 已被 venue-specific 字段污染** — `juplendPollIntervalMs` 直接进了通用 adapter 类型(`adapters/types.ts:208` ⟂)，`AccountRuntimeOptions` 也按 `binance/juplend` 写死(`shared.ts:34` ⟂)。每加一个所就继续膨胀，需改为 venue runtime options registry。
4. **symbol encode/decode 没有共享边界** — Binance 内部有 `normalizeUmSymbol/encodeUmSymbol`(`private-adapter.ts:181,191` ⟂)，但 order 命令把用户 symbol **原样下传、不校验 catalog**(`runtime.ts:327` ⟂)。新所各写一份映射，且下单不做 market 校验。
5. **WS 复用会牵动 ready/freshness 状态机（对 P0-1 的关键深化）** — 当前 ready 是每个 `StreamHandle` 等首条消息(`market-manager.ts:555` 区域，`ensureL1BookStream` 内 `await record.l1BookStream.ready` ✓)、freshness 按 record 独立维护(`l1Freshness/fundingRateFreshness` 为 record 级字段 `:56/:58` ✓)。改成「单物理连接 + 多 logical subscription」后，需要 **per-subscription ready、unsubscribe ack、重连重放订阅、单 channel 级 stale 判断**——**不能只给 `ManagedWebSocket` 加个 `send()` 就完事**，要同时设计 logical stream 契约。
6. **事件背压缺失** — `AsyncEventBus` 每个 listener queue 无上限(`async-event-bus.ts:25` 的 `const queue: U[] = []`、`:58` 的 `queue.push` ✓，架构文档 §6.3 亦自承)。多 venue 高频 L1 会放大内存风险。

> 另：`FakeWebSocket.send()` 目前是空实现(`test-utils.ts:50` ✓)。P0-1 改造后，测试需要它能断言 subscribe payload。

---

## 3. 更新后的优先级与顺序

复核采纳的两点调整：

- **顺序**：先 **P0-2**（MarketManager 多 adapter 分派 + logical stream 契约），再 **P0-1**（`ManagedWebSocket` send/订阅池）。否则 WS 池的 ready/freshness 语义会返工（见 §2.5）。
- **分级**：REST/签名/timeout/错误归一 与 rate limit 是「**接原型 = P1，发稳定 SDK = P0**」——能复制粘贴接通第一个所，但不能作为发布基础。

```text
1. P0-2  MarketManager 多 adapter 分派 + 定义 logical stream 契约
            （连带：per-subscription ready / freshness 重设计）
2. P0-1  ManagedWebSocket 加 send + 重连重放；在其上做订阅多路复用器
3. 共享基础设施一篮子（接第一个所前必须，发布前算 P0）：
       REST 骨架 + 错误归一 + timeout/retry  ·  rate limiter  ·  time provider
4. capability 化改造（不只是清硬编码）：
       orderCapabilities 判别下单  ·  per-adapter credential validator
       ·  venue runtime options registry
       —— 顺手清掉 runtime / coordinator / order-manager / context 4 处 venue 字面量
5. 接第一个新所（建议 OKX/Bybit，正好压测 WS 复用层 + passphrase credential）
```

---

## 4. 已知 venue 硬编码点（step 4 清理目标）

| 位置 | 现状 | 锚点状态 |
|---|---|---|
| `src/client/runtime.ts` | venue 字面量分派 | ⟂ |
| `src/client/private-subscription-coordinator.ts` | venue 字面量 | ⟂ |
| `src/managers/order-manager.ts:104` | `subscribeOrders()` 硬拒 juplend | ⟂ |
| `src/client/context.ts:106` | `hasPrivateCredentials()` 对 juplend 特判 | ⟂ |
| `src/adapters/types.ts:208` | `juplendPollIntervalMs` 污染通用类型 | ⟂ |
| `src/internal/shared.ts:34` | `AccountRuntimeOptions` 按 `binance/juplend` 写死 | ⟂ |
| `src/internal/shared.ts:134` | `rate_limited` 状态类型存在但无实现 | ⟂ |
| `src/adapters/binance/private-adapter.ts:874` | 签名直接 `Date.now()` | ⟂ |

---

## 5. 本路线图首个落地任务：steps 1 + 2

steps 1 与 2 耦合最紧（行情侧多 venue 改造 + WS 复用层），作为**第一个 Trellis 任务**一起做：

- **范围内**：MarketManager 多 adapter 分派；logical stream 契约（per-subscription ready / unsubscribe ack / 重连重放 / 单 channel stale）；`ManagedWebSocket` 增加 `send()` 与重连重放；在其上构建订阅多路复用器；`FakeWebSocket.send()` 可断言 payload。
- **范围外**（后续任务）：共享 REST/限流/时钟（step 3）、capability 化与硬编码清理（step 4）、接第一个新所（step 5）。
- **顺序**：先 P0-2 定契约，再 P0-1 做复用层。

> 详细 PRD 见对应 Trellis 任务的 `prd.md`。本文件保留全局路线图，供 steps 3–5 后续参考。

---

## 6. 公共数值契约：BigNumber → string（发布前 P0，独立项）

> 与 §3 的 venue 基础设施**正交**：连接复用 / logical stream / 多 adapter 分派都不依赖数值表示，因此**不是 multi-venue 的硬前置**。但它是**破坏性公共 API 改动**，须在 1.0 / 接第一个新所之前落地。

### 6.1 现状

- `src/index.ts:1` ✓ 直接 `export { BigNumber } from "bignumber.js"` —— 第三方类进入公共类型面。
- **输出全 BigNumber**：`L1Book.{bidPrice,bidSize,askPrice,askSize}`(`market.ts:95-98` ✓)、`FundingRateSnapshot.{fundingRate,markPrice,indexPrice}`(`market.ts:109-112` ✓)、`OrderSnapshot.{price,amount,filled,…}`(`order.ts:105-112` ✓)、`BalanceSnapshot/PositionSnapshot/RiskSnapshot` 及 lending facets 全家桶(`account.ts` ⟂)。
- **输入已是 string**：`CreateOrderInput.{amount,price}`(`order.ts:60,68` ✓)、`NormalizedOrderInput` 全 string(`market.ts:69-81` ✓)。→ 现状是「**收 string、吐 BigNumber**」的不对称。

### 6.2 为什么要改（三个具体问题，非审美）

1. **跨实例 / 全局配置 footgun（对库最尖锐）** — bignumber.js 的 `DECIMAL_PLACES / ROUNDING_MODE / EXPONENTIAL_AT` 是挂在构造器上的**全局可变配置**。消费者自带的版本 / dedupe 对不上 → 返回对象 `instanceof` 其 BigNumber 为 false；同实例下消费者一句 `BigNumber.config(...)` 即可改变你返回对象的除法 / 舍入 / 科学计数行为。当前 re-export 只缓解了 `instanceof`，没解决版本绑定，且坐实「公共面塞第三方类」。
2. **序列化 / IPC / worker 不友好** — string 可 `JSON` 往返、`structuredClone`、`postMessage`、直接日志；BigNumber `JSON.stringify` 出的是无损串但 `JSON.parse` 回来是 string（非 BigNumber），`structuredClone` 丢原型。高频行情跨边界会放大此差异。
3. **行业惯例** — Binance / OKX / Bybit / Gate 的 REST+WS 数字字段**皆 string**；canonical 类型应为无损十进制 **string**。**不要改 number(float)** —— 对 crypto 精度是退步。

### 6.3 方案

- 输出由 BigNumber 改为 **canonical 十进制 string**，与输入侧对齐（对称契约）。
- **保留 `BigNumber` re-export 作可选工具** —— 消费者 `new BigNumber(field)` 自取，文档给出推荐姿势。代价：消费者若图省事用 `parseFloat` 会重引精度 bug，靠文档 + 保留工具缓解。
- **内部运算不变** —— `floorToStep`、风控除法等照旧用 BigNumber，仅在 manager 出口 stringify。
- **必须定 canonical 格式** —— 统一 `.toFixed()`（或全局 `EXPONENTIAL_AT`），杜绝 `1e-7` 科学计数。`scripts/` 已在 stringify 前 `.toFixed()`，可佐证。

### 6.4 改动面与成本

- 转换集中在三处出口：`market-manager.ts:739-770` ⟂、`account-manager` 的 `getBigNumber` 区域 ⟂、`order-manager.ts:532-564` ⟂；adapter 本就吐 string（`Raw*`，`adapters/types.ts` ✓）。→ 本质是**删一层包装**，而非加层。
- 噪声主要在：所有 snapshot 类型定义改 string、各 manager builder 出口、`README` / `docs/api.md` 示例、以及大量测试断言。
- 风险低、机械化，但 diff 大且横切 —— **适合作为独立 PR**，不与 venue 改造混提。

### 6.5 顺序建议

- **不是 multi-venue 的硬前置**（正交），也**不建议插在当前 06-01 之前** —— 06-01 是关键路径且已在 planning，前置大破坏性 type-churn 会拖慢它并迫使 rebase。
- 建议：**06-01 先走，本项紧随其后作为独立任务**；**硬截止 = step 5「接第一个新所」之前** —— 每多接一个所、多写一份 adapter / manager，BigNumber 迁移面就增大一截。趁 `beta`、1.0 未锁契约时改最便宜。
