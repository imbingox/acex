# P1-B3 限流分层：主动预算 + scope 分桶 + 撤单优先

## Goal

把当前**纯被动**（仅 429/418 后阻塞）、scope 粒度与交易所语义不匹配的限流器，升级为
**主动预算 + 分层桶 + 撤单优先**的通用限流引擎；并守住"限流值/权重表归 adapter、
预算引擎归 core"的边界，使其天然支持后续多交易所接入（P1-C 铺路）。

定位：crypto 多交易所量化 SDK（HFT + LFT），限流是热路径基础能力，按 HFT 标准衡量。

## What I already know（已探查，commit 当前 HEAD）

- **SPI 已解耦**：`src/types/shared.ts:32-82` 定义 `RateLimiter` /
  `RateLimitScope{venue,accountId,endpointKey}` / `RateLimitUsage{weight,orderCount}` /
  `RateLimitSnapshot`，全部 venue 无关。
- **通用实现** `src/internal/rate-limiter.ts`（`ReactiveRateLimiter`，零 Binance import）：
  - `beforeRequest` 仅在 `blockedUntil` 未过期时 sleep（`:44-51`）——纯被动。
  - `afterResponse` 把 `usage`（已用 weight/order）存进 state（`:57-67`）**但从没人读它做节流**。
  - `onTransportError` 仅对 429/418 设 `blockedUntil`（`:79-98`）。
  - `getSnapshot` 在 src 内**零消费方**（仅测试用）——主动节流要靠它/内部状态。
  - `scopeKey = venue + accountId + endpointKey`（`:153-155`）——三者混在一个 key。
- **Binance 胶水**（仅两处）：
  - header 解析 `src/adapters/binance/rate-limit.ts`（`X-MBX-USED-WEIGHT-*` /
    `X-MBX-ORDER-COUNT-*` → 通用 `RateLimitUsage`）。
  - scope 构造（`endpointKey = "${method} ${path}"`）+ 三钩子调用：
    `private-adapter.ts:1212`（`signedRequest`）/`:1334`（`userStreamRequest`）/`:1401`（`rateLimitScope`）、
    `market-catalog.ts:239`、`server-time.ts:42`。
- **装配** `runtime.ts:130`：`options.rateLimiter ?? new ReactiveRateLimiter()`，注入所有 adapter；
  用户今天就能注入自定义 limiter。
- **代码库无 endpoint weight 成本表**（grep 无结果）——这是新增物，须落在 adapter。

## Assumptions（待 research 确认）

- Binance PAPI `REQUEST_WEIGHT` 是 **per-IP 全局**桶（跨 endpoint、跨 account 共享）；
  order count 是 **per-account** 桶；二者上限/interval 与 spot/futures 可能不同（参考 P1-C5 教训：
  PAPI 错误码就与 spot 不同）。
- 撤单/风控请求是**安全攸关**：weight 预算耗尽时仍须能挤出（reserve headroom 或优先级）。
- 429 后正确做法是**按 IP/venue 级**阻塞（而非单 endpoint），否则其他 endpoint 继续打 → 418 IP ban。

## Open Questions（仅 Blocking / Preference）

- [x] **Q1 MVP 边界**：✅ 决议=一任务三 PR。PR1 分桶模型+SPI 扩展+429/418 落对桶层级（含正确性止血）；PR2 主动预算（weight 表+used-weight 头回填）；PR3 撤单优先+重连 jitter。
- [x] **Q2 主动节流策略**：✅ 固定窗口计数（对齐 per-minute 窗口与 used-weight 头，O(1)）+ `afterResponse` header 回填校正。否决纯 token bucket（连续退桶与固定窗口语义不符）与纯 header 驱动（头只在响应后到，gate 不住首请求）。
- [x] **Q3 撤单优先机制**：✅ 先做 reserve headroom（cancel 可动用保留区）；优先队列留作后续增强，不在本任务。
- [x] **Q4 SPI 扩展形状**：✅ Approach B——adapter 注册 plan/topology 表，每请求只传 `{scope, planId, priority}`，热路径 O(1) 查表。

## Requirements（evolving）

- R1 主动节流：逼近 weight/order 上限时在 `beforeRequest` 主动延迟，而非等 429。默认 `utilizationTarget=0.9`。
- R2 分层桶：per-host IP weight 桶（key 不含 accountId）+ per-account order 桶；429/418 阻塞落在正确的桶层级。
- R3 撤单优先：cancel/风控请求保留预算，默认 cancel reserve = IP weight 桶 5%（300/6000）。**整个撤单工作流（含 `cancelAllOrders` 的 prefetch GET）都标 `priority:"cancel"`**（B7）。
- R4 解耦：core 引擎零 venue 常量；Binance 权重表/桶拓扑/上限/header→bucket 映射只在 `adapters/binance/`。
- R5 向后兼容：注册入口为 **optional 扩展接口**（非 `RateLimiter` 必需成员）；未实现/未注册 topology → 回退当前 endpoint-scope reactive 行为，不得静默丢 429/418 阻塞（B1）。
- R6 plan 为 adapter 选的**语义 id**（非 `=endpointKey`）：同 endpoint 不同成本分不同 plan（`openOrders` 无 symbol=40 / 有 symbol=1；spot/fapi/dapi/papi 各 host 各 plan）（B2）。
- R7 host 分桶：papi / fapi / dapi / spot 各自独立 IP weight 桶；**server-time 归 fapi 桶（不改 URL）**、catalog 三 host 各归各桶（B3）。
- R8 固定窗口 + rollover：header 低于已知值视为交易所新窗口→开新窗（非 `max` 保留旧值）；乱序 `afterResponse` 按时间戳防旧窗覆盖新窗（B4）。
- R9 admission 原子：多桶 check+reserve 为 all-or-none 临界区；预扣带 reservation id 供 `afterResponse`/`onTransportError` 对账（B5）。
- R10 transport error **默认不退款**（订单可能已落地，与 OrderManager `unknown` 语义一致）；仅 adapter 明确标 `requestNotSent` 的 pre-HTTP 本地失败可退（B8）。
- R11 公开配置：新增 `CreateClientOptions.rateLimit?: { utilizationTarget? }`；cancel reserve 暂为内部默认（S5）。
- R12 priority 覆盖 `ctx.priority ?? plan.priority ?? "normal"`；容量公式 `normalCap = floor(limit×target) − reserve`，cancel/risk 可用到 published limit（S3、S4）。
- R13 fallback 冷却：429 无 `Retry-After` → block 到下一窗口边界+jitter；418 → `Retry-After` 缺失时 ≥2min 且连续 418 指数延长、never shorten（S8）。

## Acceptance Criteria（evolving）

- [ ] 主动延迟：used-weight 头逼近上限 → `beforeRequest` 可观测 sleep。
- [ ] 桶层级：429（单桶）只 block 该桶、不可辨/多桶保守 block；418 block 对应 **host IP 桶**而非单 endpoint。
- [ ] 自定义 limiter 兼容：只实现现有 4 方法的 limiter → 构造 client / loadMarkets / serverTime / signed request 均不抛；default limiter 能注册 Binance topology 并用 plan。
- [ ] topology 注册幂等；冲突 descriptor 被拒绝/不覆盖。
- [ ] 成本变体：`openOrders` 无 symbol=40 / 有 symbol=1；spot/fapi/dapi/papi host 桶独立、server-time 计入 fapi 桶。
- [ ] 并发 admission：同桶多请求并发不超 cap；多桶预扣失败不留部分扣减（all-or-none）。
- [ ] 窗口 rollover：header 从高降低不多阻塞、不提前放量；乱序 `afterResponse` 不覆盖新窗。
- [ ] 撤单优先：normal 预算耗尽时，`cancelOrder` 与 `cancelAllOrders`（prefetch+DELETE）仍走 reserve 通过；cancel 仍计 IP weight、不无限 bypass。
- [ ] order count 桶 per-account 隔离，两 account 互不影响。
- [ ] 退款语义：order 请求 timeout/network 不退 order 桶预扣。
- [ ] core 限流器零 Binance 字面量。
- [ ] `bun run lint` / `type-check` / `test` 全绿；公开 SPI 变更带 minor changeset。

## Definition of Done

- 单测覆盖主动节流 / 分桶 / 撤单优先 / per-account 隔离。
- lint / type-check / test 全绿。
- 若 `RateLimiter` SPI 形状变化 → 更新 docs/api.md + 相关 spec + changeset。
- 在 `docs/improvement-todo.md` 勾选 P1-B3。

## Technical Approach

**核心边界**：weight 表 / 桶上限 / plan 映射 / header→bucket 映射归 `src/adapters/binance/`；core
`src/internal/rate-limiter.ts` 只做通用分桶预算引擎，零 venue 常量。默认实现更名 `BudgetRateLimiter`
（保留 `ReactiveRateLimiter` 兼容 alias，N1）。

**桶模型（抄 Hummingbot linked_limits）**：adapter 声明
- 桶表 `RateLimitBucketDescriptor{ id, kind:"request_weight"|"orders", limit, intervalMs, utilizationTarget?, reserve? }`
  ——host/product 编码进 `id`（`binance:papi:request-weight:1m`、`binance:fapi:request-weight:1m`、
  `binance:spot:request-weight:1m`、`binance:papi:orders:1m`），**不引入伪 `ip` scope 维度**（S2）。
- plan 表 `{ <semanticPlanId>: { costs:[{bucketId,cost}], priority? } }`，planId 由 adapter 选（非 endpointKey，R6）。
一个请求可同时扣多桶：查询扣 host IP weight 桶；**下单扣 account order 桶、IP weight=0**。

**算法 = 固定窗口计数 + header 回填**：
- 每桶按 `intervalMs` 固定窗口计数，O(1)。
- `beforeRequest`：进 admission 临界区 → rollover/reconcile 各桶 → plan 全部 costs 在各桶可用则**一次性
  all-or-none 预扣**并返回 reservation；否则算 delay、出临界区 sleep、到期重进重查（R9）。
- `afterResponse`：按 plan costs 中 `kind/interval` 匹配的桶回填权威头；header **低于已知值视为新窗口→开新窗**
  （非死守 `max`），乱序按时间戳防覆盖（R8、S1）。
- 退款：默认不退；仅 `requestNotSent` 的 pre-HTTP 本地失败退（R10）。

**SPI 形状 = Approach B + optional 注册**：per-request 传 `{ scope, planId?, priority? }`；新增 optional 扩展接口
`RateLimitTopologyRegistry{ registerRateLimitTopology(topology) }`，**非 `RateLimiter` 必需成员**。adapter
经 host helper `registerBinanceRateLimitTopology(limiter)` 在装配期 feature-detect 注册（幂等、冲突报错）；
不支持注册或 unknown plan → 回退 endpoint-scope reactive（R5、B6）。`sleep`/`now`/`random` 均可注入（N2）。

**Reservation 对账契约 + 窗口边界（闭合 pass2 B4/B5/N1）**：
- SPI 扩展：`beforeRequest(ctx)` 返回 opaque `RateLimitReservation | void`（`void` = 不预算的 reactive / 自定义 limiter）；
  adapter 把它原样回传给 `afterResponse` / `onTransportError`（经其 context 新增的可选 `reservation?` 字段）。
  现有 `beforeRequest():void` 仍合法 → 向后兼容；`reservation` 缺失时两钩子按 scope 走 reactive 回退。
- token 关联：`admittedAt`、`planId`、`priority`、各桶 reserved costs、各桶 **window version**（= 该桶预扣时的 windowStart）。
- 固定窗口：wall-clock 对齐，`windowStart = floor(now / intervalMs) × intervalMs`、`windowEnd = windowStart + intervalMs`；
  window version 即 `windowStart`。
- 回填对账：`afterResponse` 仅当 reservation 的桶 window version == 该桶当前 version 时 `used = max(used, header)`；
  version 更旧（乱序、桶已滚动）则忽略，不复活旧窗（闭合 B4 乱序防覆盖）。
- 429 fallback block = 受影响桶的 `windowEnd + jitter`（闭合 B4“下一窗口边界”歧义）。
- 退款：`requestNotSent` 时按 token 的 reserved costs 精确回退本次 all-or-none 预扣（闭合 B5 对账）。

**撤单优先 = reserve headroom**：桶描述符带 `reserve:{priority:"cancel", units}`；普通请求只能用到 `normalCap`，
`priority:"cancel"` 可用到 published limit。**整个撤单工作流（含 cancelAll 的 prefetch GET）标 cancel**（R3、B7）。
reserve 只护本进程 admission，外部流量打满 exchange 桶时仍会被交易所限流 → 暴露可诊断 snapshot。优先队列后续增强。

**PR1 正确中间态**（B6）：扩展 SPI + 桶模型 + 429/418 落对桶层级；未注册/unknown plan/旧 limiter 一律回退
endpoint reactive；**PR1 不做主动预扣**，但要有 bucket-level block 与 snapshot。PR2 加固定窗口预扣 + 回填，PR3 加 reserve + jitter。

**可观测性**：主动 admission wait **不改 runtime status**（避免误降级），但 default limiter 的 `getSnapshot`/内部
snapshot 要能回答 bucket 级——`getSnapshot` 扩展 optional `buckets[]{ id, used, limit, windowEndMs, reserveUsed }`（剩余/阻塞/reserve 动用/nextAvailableAt 由此派生，S7）；429/418 仍经 `TransportError.kind="rate_limited"`
映射现有 `PrivateRuntimeStatus.reason`（S6、S7）。

## Decision (ADR-lite)

- **Context**：限流器纯被动（仅 429/418 后阻塞）+ `scopeKey` 含 endpointKey 与 Binance per-IP/per-account
  语义错配 → 429 只 block 单 endpoint，其余继续打升级成 418 IP ban；多桶/主动/撤单优先均无落脚点。
- **Decision**：一任务三 PR；分层桶（adapter 声明拓扑、core 通用引擎）；固定窗口计数 + header 回填；
  SPI 用 Approach B（plan 注册）；撤单优先先做 reserve headroom。
- **Consequences**：core 保持 venue 无关，为 P1-C 多交易所铺路；reserve 略降普通吞吐；10s/1d order 桶未经官方
  核实 → 先只做 1m；新增 optional 注册扩展接口（向后兼容，自定义 limiter 不实现则回退 reactive）+ 公开
  `rateLimit.utilizationTarget`；SDK `accountId` 作 order 桶 key——同交易所账户多 API key 注册成多 accountId
  会各算 1200/min（MVP 文档化，UID override 留后续，S9）；默认实现更名 `BudgetRateLimiter`（保留 alias）。

## Out of Scope（explicit）

- WS-API 下单限流（P2-1，新传输层，独立任务）。
- 其他 venue（OKX/Bybit/Gate）的实际接入（P1-C 批次）——本任务只保证 SPI 不挡路。
- 时钟同步 -1021（P1-B4，批次⑤）。
- 把 server-time URL 从 fapi 改到 papi（属 server-time/时间源 scope，不在本任务）。
- 优先队列（先 reserve）；cancel reserve 的公开配置（暂内部默认）；order 桶 UID override（先用 accountId + 文档化限制）。
- 10s/1d order 桶（官方未核实，不硬编码）。

## Research References

- [`research/binance-papi-rate-limits.md`](research/binance-papi-rate-limits.md) — PAPI 官方核实：`REQUEST_WEIGHT` 6000/min **per-IP**、`ORDERS` 1200/min **per-account**；**下单只扣 order 桶、IP weight=0**，查询才扣 IP weight；balance/account=20、positionRisk=5、openOrders=1(单)/40(无symbol)、order/cancel/listenKey=1；无 PAPI exchangeInfo（用 fapi/dapi，404 已实测）；10s/1d order 桶未核实勿硬编码。
- [`research/proactive-throttle-patterns.md`](research/proactive-throttle-patterns.md) — ccxt(单标量 cost + leaky/rolling，主动排队)、**Hummingbot(linked_limits 多桶=最佳拓扑)**、官方 connector(仅 header 解析、无 admission)、freqtrade(转包 ccxt)；**撤单优先各家都没有 → 需自建**；header 回填是多进程共享 IP/account 时的必需校正。

## Technical Notes

- 关键不变量：**weight 表/上限归 adapter，预算引擎归 core**（守不住 → 引入 Binance 强耦合）。
- `scopeKey` 当前把 venue/account/endpoint 混在一个 key，分桶需按"桶类型"拆出不同 key
  （weight 桶 key 不含 accountId；order 桶 key 含 accountId）。
- 热路径成本：`beforeRequest` 在每个 signed request 前调用，不节流时必须极廉价。
