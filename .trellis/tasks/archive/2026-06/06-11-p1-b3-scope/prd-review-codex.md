# PRD 逆向预审：P1-B3 限流分层

审查对象：`/workspace/projects/acex/.trellis/tasks/06-11-p1-b3-scope/prd.md`

结论：方向正确，但 PRD 目前还不能直接进入实现。几个关键点仍处于“口号级”：SPI 注册生命周期、固定窗口边界、并发预扣原子性、host/endpoint 成本变体、PR1 中间状态和撤单工作流。若按当前文本实现，存在破坏现有 `CreateClientOptions.rateLimiter` 注入契约、错扣 Binance 权重、窗口 rollover 后长时间误阻塞或提前放量、以及 cancelAll 在真正撤单前被普通查询 gate 住的风险。

## Blocker

### B1. SPI 注册入口没有可实现的兼容契约，可能破坏或绕过现有自定义 `RateLimiter`

**参考**：PRD `R5` 与 Approach B（`prd.md:49-54`, `prd.md:88-90`）；现有 public `RateLimiter` 只有四个必需方法（`src/types/shared.ts:71-82`，`docs/api.md:670-681`）；runtime 只做 `options.rateLimiter ?? new ReactiveRateLimiter()` 后注入两个 Binance adapter（`src/client/runtime.ts:127-137`）；spec 明确 `RateLimiter` 是 public seam，经 `CreateClientOptions.rateLimiter?` 注入（`.trellis/spec/backend/adapter-contract.md:554-564`）。

**问题**：PRD 只说“限流器新增注册入口；自定义 limiter 该方法可选”，但没有定义：

- 注册方法的 public 形状、是否属于 `RateLimiter` 接口、是否 optional。
- runtime / adapter 是否会 feature-detect；如果无条件调用，会让当前所有只实现四个方法的自定义 limiter 在构造阶段崩溃。
- 如果用户传入不支持注册的 custom limiter，adapter 仍传 `{ planId, priority }` 后，主动预算、分桶和撤单 reserve 是否全部失效；失效时是否仍保留当前 reactive 行为。
- Binance market adapter 和 private adapter 共享同一个 limiter，二者构造时重复注册同一 topology 应如何处理。

**建议修改**：

- 在 PRD 中明确新增一个独立 optional 扩展接口，例如 `RateLimitTopologyRegistry { registerRateLimitTopology(topology): void }`，不要把注册方法作为 `RateLimiter` 必需成员。
- `RateLimitRequestContext` 扩展为 `scope + optional planId/priority`，缺失或 limiter 不支持注册时必须回退到当前 endpoint-scope reactive 行为，不得静默丢掉 429/418 阻塞。
- 注册入口放在 adapter-owned helper 中，例如 `registerBinanceRateLimitTopology(rateLimiter)`，由 `BinanceMarketAdapter` / `BinancePrivateAdapter` 构造时 feature-detect 调用；默认 limiter 必须对相同 topology id 做幂等注册，并对冲突 descriptor 报错或拒绝覆盖。
- Acceptance Criteria 增加：传入只实现现有四方法的 custom limiter 时，构造 client、loadMarkets、serverTime、private signed request 仍不抛；同时 default limiter 能注册 Binance topology 并使用 plan。

### B2. `planId = endpointKey` 无法表达当前 Binance 成本变体，会导致 admission 账本错扣

**参考**：PRD 把 endpoint plan 定义为 `planId(=endpointKey)`（`prd.md:77-80`, `prd.md:88-90`）；研究确认 `GET /papi/v1/um/openOrders` 带 `symbol` 成本 1、不带 `symbol` 成本 40（`research/binance-papi-rate-limits.md:67`）；当前代码中 `fetchOpenOrders()` 不传 symbol，用于 bootstrap/reconcile（`src/adapters/binance/private-adapter.ts:760-772`），而 `cancelAllOrders()` 的预查询传 symbol（`src/adapters/binance/private-adapter.ts:891-900`）；当前 `loadBinanceMarkets()` 同时请求 spot、USDM、COINM 三个 exchangeInfo（`src/adapters/binance/market-catalog.ts:295-317`），研究里 spot exchangeInfo 成本是 20，fapi/dapi 是 1（`research/binance-papi-rate-limits.md:77`）。

**问题**：同一个 `endpointKey` 对应多个成本：

- `GET /papi/v1/um/openOrders`：无 symbol 是 40，有 symbol 是 1。
- `GET /api/v3/exchangeInfo`、`GET /fapi/v1/exchangeInfo`、`GET /dapi/v1/exchangeInfo` 分属不同 host/product，且 spot 成本不是 1。

如果 plan 表只按 `"<METHOD> <path>"` 查，active gate 会在 bootstrap/reconcile 时低估 40 倍，或在 cancelAll 预查询时高估，二者都不可接受。

**建议修改**：

- `planId` 必须是 adapter 选择的语义 plan，而不是固定等于 `endpointKey`。例如：
  - `binance:papi:GET /um/openOrders#all`
  - `binance:papi:GET /um/openOrders#symbol`
  - `binance:spot:GET /exchangeInfo`
  - `binance:fapi:GET /exchangeInfo`
  - `binance:dapi:GET /exchangeInfo`
- `endpointKey` 可继续用于 diagnostics/scope，`planId` 用于预算。
- Acceptance Criteria 增加 openOrders 两种成本和 spot/fapi/dapi exchangeInfo 三个 host bucket 的单测。

### B3. PRD 的 server-time bucket 与当前代码/spec 矛盾

**参考**：PRD 写“server-time 走 papi 桶”（`prd.md:95-96`）；当前 `fetchBinanceServerTime()` 实际调用 `https://fapi.binance.com/fapi/v1/time`，scope 是 `GET /fapi/v1/time`（`src/adapters/binance/server-time.ts:29-47`）；adapter-contract 也明确 Binance 当前测量 USD-M REST 集群 `/fapi/v1/time`（`.trellis/spec/backend/adapter-contract.md:137-151`）；研究只把 PAPI `/papi/v1/time` 作为 live observation，官方文档仍是 gap（`research/binance-papi-rate-limits.md:75-77`, `research/binance-papi-rate-limits.md:93`）。

**问题**：如果按 PRD 把 server-time header 回填到 PAPI weight bucket，会把 fapi host 的 `x-mbx-used-weight-1m` 写入 PAPI bucket，直接污染主动预算。反过来，如果实现时顺手把 server-time URL 改到 PAPI，又会触碰 server-time spec 和潜在时间源语义，超出本任务。

**建议修改**：

- PRD 明确选择其一：
  - 保持当前实现：`fetchBinanceServerTime()` 属于 fapi host bucket，PAPI bucket 不消费它。
  - 或显式把 server-time endpoint 从 fapi 改为 papi，并同步更新 adapter-contract/docs/tests；这应作为单独 scope，不要混在限流 PR 中。
- 同时补上 spot exchangeInfo host bucket；当前 catalog 不只有 fapi/dapi。

### B4. 固定窗口与 header `max(local, header)` 的 rollover 语义不足，可能误阻塞或提前放量

**参考**：PRD 算法（`prd.md:82-86`）；研究说明 header 是当前 interval 的 used count，且 rejected/unsuccessful orders 不保证包含 order-count header（`research/binance-papi-rate-limits.md:35-42`）。

**问题**：PRD 说“固定窗口计数（对齐 Binance per-minute 窗口）”和“`max(local, header)`”，但没有定义窗口如何对齐：

- 如果本地窗口是 first-request-aligned，它天然不对齐 Binance 的分钟边界；header 在交易所 rollover 后变小，`max(local, header)` 会保留上一分钟的大数，可能整整多阻塞一个本地窗口。
- 如果本地窗口按本机 wall clock 对齐，机器时钟相对 Binance 偏快会提前清零并放量，偏慢会无谓等待。当前时钟同步任务 P1-B4 明确 out of scope。
- 只用 `max(local, header)` 没有“header 降低表示新 exchange window”的规则；但若简单允许降低，又可能被乱序响应覆盖较新的本地预扣。

**建议修改**：

- 在 PRD 中定义每个 bucket 的 `windowStartMs/windowEndMs` 规则，以及 header 降低时的 rollover 处理。
- 建议策略：本地 admission 使用保守 wall-clock 边界加 safety margin；响应 header 若在同一 bucket/interval 中低于已知 header，视为 exchange window rollover，开启新窗口而不是 `max` 保留旧值；乱序响应用 response/admission timestamp 防止旧窗口覆盖新窗口。
- Acceptance Criteria 增加：窗口边界前后并发请求、header 从高值降到低值、乱序 afterResponse 三类测试。

### B5. 并发 `beforeRequest` 预扣没有原子性设计，当前代码存在大量并发 REST 调用

**参考**：PRD “`beforeRequest` 按 plan costs 预扣”（`prd.md:84`）；当前 Binance bootstrap 三个 signed GET 并发发起（`src/adapters/binance/private-adapter.ts:687-713`）；market catalog 三个 host 并发发起（`src/adapters/binance/market-catalog.ts:299-318`）。

**问题**：Bun/JS 单线程不等于 admission 原子。多个 async `beforeRequest()` 可在同一 tick 或 sleep/recheck 间交错。如果实现为“读 bucket used -> 判断 -> 写 used”，会出现：

- 多个请求同时看到可用容量并全部通过，超过 bucket cap。
- 一个请求要扣多个 bucket 时，先扣 A 后发现 B 不足，产生部分预扣。
- 普通请求和 cancel 请求同时竞争 reserve，普通请求可能在 cancel 之前占掉本应保留的 headroom。

**建议修改**：

- PRD 必须要求默认 limiter 维护 admission critical section/queue：多 bucket check+reserve 是 all-or-none 原子操作。
- 推荐流程：进入 admission mutex，rollover/reconcile bucket，若所有 bucket 可用则一次性预扣并返回；否则计算 delay，释放 mutex 后 sleep，到期重新进入并重查。
- 每次预扣要有 request reservation id 或等价 in-flight record，供 afterResponse / onTransportError 做同一次请求的 reconciliation/refund。
- Acceptance Criteria 增加并发测试：同 bucket 多请求同时进入时不会超过 cap；多 bucket 预扣失败不会留下部分扣减。

### B6. 三 PR 拆分没有定义 PR1 的正确中间状态

**参考**：PRD Q1：PR1 分桶模型+SPI 扩展+429/418 落对桶层级，PR2 才主动预算，PR3 才撤单优先（`prd.md:42`）；研究要求 418 block per-IP，429 在不能判断时可能要 block both affected buckets（`research/binance-papi-rate-limits.md:49-56`）；现有 limiter 当前按 endpoint scope reactive block（`src/internal/rate-limiter.ts:44-98`）。

**问题**：PR1 若只扩展 SPI 和 bucket model，但没有完整 topology/cost/header mapping，就无法可靠判断 429 应落到 IP bucket、order bucket、还是两者。更糟的是，若 PR1 改掉 `scopeKey` 但未完成 fallback，可能让当前 endpoint-level reactive 保护也退化。

**建议修改**：

- PRD 为 PR1 明确“correct intermediate state”：
  - 未注册 topology / unknown plan / custom limiter 不支持 registry 时，保留当前 endpoint reactive block。
  - 已知 Binance topology 下，418 必须 block 对应 host 的 IP request-weight bucket。
  - 429 若 endpoint 只消耗一个 bucket，则 block 该 bucket；若 endpoint 消耗多个 bucket或无法区分，则 conservatively block all plausible buckets。
  - PR1 不做 proactive admission，但必须有 bucket-level block 和 snapshot 表达。
- PR1 tests 必须覆盖：custom limiter fallback、unknown plan fallback、418 per-host block、429 order endpoint ambiguous block。

### B7. Cancel reserve 只覆盖 DELETE 不够；`cancelAllOrders()` 可能在真正撤单前被预查询 gate 住

**参考**：PRD cancel reserve（`prd.md:52`, `prd.md:92-93`）；研究确认 cancel/cancelAll 消耗 IP request weight，不是 order count（`research/binance-papi-rate-limits.md:66-68`, `research/binance-papi-rate-limits.md:87`）；当前 `cancelAllOrders()` 先执行 `GET /papi/v1/um/openOrders?symbol=...`，再执行 `DELETE /papi/v1/um/allOpenOrders`（`src/adapters/binance/private-adapter.ts:885-913`）。

**问题**：reserve 放在 IP weight bucket 是正确方向，但当前工作流里 `cancelAllOrders()` 的第一步是查询。如果这一步按普通 priority 走，query burst 已把 normal budget 用完时，cancelAll 会卡在预查询，根本到不了 DELETE。即使单笔 cancel 没有预查询，缺少并发原子性时普通查询也可能越过 reserve。若外部进程已经把实际 exchange bucket 打满，cancel 仍会被交易所限制，PRD 也没有定义 bounded wait / 诊断语义。

**建议修改**：

- 将整个风险控制工作流标为 `priority:"cancel"` 或 `risk"`，包括 cancelAll 的 prefetch；或者改 cancelAll 顺序/能力，使真正 DELETE 不依赖普通-priority 查询。
- 明确 reserve 只保护本进程 admission，不保证外部流量耗尽 exchange bucket 时仍能成功；这种情况下应暴露可诊断的 rate-limited/banned snapshot。
- Acceptance Criteria 增加：普通查询用完 normal headroom 后，`cancelOrder` 和 `cancelAllOrders` 的 prefetch+DELETE 均能进入 reserve；cancel 自身仍按 IP weight 计费且不能无限 bypass。

### B8. “transport error 退款”没有可实现信号，且与订单状态安全语义冲突

**参考**：PRD “仅确认未离开本进程的本地失败退预扣”（`prd.md:86`）；`RateLimitTransportErrorContext` 当前没有 `kind`，只有 status/headers/retryAfter/usage（`src/types/shared.ts:55-60`）；`httpRequest()` 把 timeout/network/parse/http/rate_limited 统一抛为 `TransportError`（`src/internal/http-client.ts:342-405`）；OrderManager 把 timeout/network/parse 判为 `orderState:"unknown"`，rate_limited 判为 `not_placed`（`src/managers/order-manager.ts:1312-1348`）；spec 要求写操作 `NO_RETRY_POLICY` 且非幂等请求遇 429/418 不自动重放（`.trellis/spec/backend/adapter-contract.md:524-528`, `.trellis/spec/backend/adapter-contract.md:561-563`）。

**问题**：adapter 在 catch 中调用 `onTransportError()` 时，limiter 无法知道错误是 timeout、network、parse、HTTP 5xx、还是本地 abort；即使扩展了 `kind`，`fetch()` 抛 network/timeout 也不等于“请求未离开进程”。对下单而言，OrderManager 已把这些状态视为 exchange 执行状态未知；如果 limiter 退款 order bucket，本地预算会低估真实 order count，后续继续放单更容易触发 429/418。

**建议修改**：

- 默认策略改为：成功 pre-deduct 后，除非 adapter 明确传 `requestNotSent: true`，否则任何 `onTransportError` 都不退款，只做 header reconciliation 和 block。
- 若需要退款，只允许发生在 `beforeRequest` 内部预扣后、实际 HTTP 未开始前的本地失败；这应由 limiter 自己处理，或由 adapter 在调用 `httpRequest()` 前的同步错误路径显式标注。
- 如果扩展 `RateLimitTransportErrorContext`，加入 `kind` 主要用于 observability/block policy，不应被用作“network/timeout 可退款”的依据。

## Should-fix

### S1. Header usage 到 bucket 的映射仍不清楚，容易把 Binance 知识塞进 core

**参考**：PRD `afterResponse` header 回填（`prd.md:85`）；研究指出当前 `RateLimitUsage.weight["1m"]` 没有 bucket identity（`research/proactive-throttle-patterns.md:137-148`）；spec 要求 core 不出现 Binance header 常量，Binance header 解析只在 adapter 层（`.trellis/spec/backend/adapter-contract.md:558-560`）。

**问题**：`RateLimitUsage` 只有 `weight` / `orderCount`，没有 bucket id。core 如果硬编码“weight -> request_weight bucket、orderCount -> orders bucket”还算通用勉强可接受，但如果要根据 Binance endpoint/host 推断，就会越界。多 host bucket 下，`weight["1m"]` 必须只回填当前 request 的 host bucket，不能回填所有 Binance weight buckets。

**建议修改**：Topology descriptor 增加 venue-agnostic reconciliation metadata，例如 bucket `kind:"request_weight" | "orders"` + interval + host/product encoded in bucket id；core 只更新当前 plan costs 中 kind/interval 匹配的 bucket。若响应包含某种 usage 但当前 plan 没有匹配 bucket，按 PRD 明确是忽略、诊断告警，还是由 adapter 提供额外 mapping。

### S2. `scope:["ip"]` 维度没有来源字段

**参考**：PRD bucket descriptor 有 `scope:[...]`（`prd.md:77-79`）；现有 `RateLimitScope` 只有 `venue/accountId/endpointKey`（`src/types/shared.ts:32-36`）。

**问题**：如果 descriptor 允许 `scope:"ip"`，core 无法从 request context 派生真实 IP。若实际 intent 是“同一 host 的所有请求共享一个 bucket”，则应由 bucket id/topology 表达 host/product，而不是假装有 IP 维度。否则未来多出口 IP、代理、sandbox/prod host 都无法表达清楚。

**建议修改**：PRD 把 scope dimensions 改成现有上下文可提供的字段，或显式扩展 `RateLimitScope` 加 `hostKey` / `egressKey`。MVP 可以定义：per-IP bucket instance key = `bucketDescriptor.id`（host/product 已编码）+ optional account dimension omitted。

### S3. `plan.priority` 和 per-request `priority` 的优先级规则未定义

**参考**：PRD endpoint plan 表包含 `priority`（`prd.md:77-80`），同时 per-request 传 `{ scope, planId, priority }`（`prd.md:88-90`）。

**问题**：同一 endpoint 在不同 workflow 中可能需要不同 priority（例如 cancelAll 的 prefetch 是 `GET openOrders?symbol`，但作为 cancel workflow 的一部分应享受 reserve）。如果 plan priority 和 request priority 都存在，未定义谁覆盖谁会造成实现分歧。

**建议修改**：定义 `plan.priority` 为默认值，`ctx.priority` 为 workflow-level override；limiter 取 `ctx.priority ?? plan.priority ?? "normal"`。Acceptance Criteria 覆盖 cancelAll prefetch override。

### S4. `utilizationTarget` 与 reserve 的叠加规则不明确

**参考**：PRD 默认 `utilizationTarget=0.9`（`prd.md:49`）和 cancel reserve 5%（`prd.md:52`, `prd.md:92-93`）。

**问题**：若 bucket limit=6000，target=90%，reserve=300：

- normal cap 是 5400，还是 5700，还是 `min(5400,5700)`？
- cancel 可用到 6000，还是也只能到 5400？
- header 回填显示 used=5600 时，normal 是否阻塞、cancel 是否仍可过？

这些决定 reserve 是否真实可用，以及普通吞吐损失是多少。

**建议修改**：PRD 明确计算公式。建议：`normalCap = floor(limit * utilizationTarget) - reserve.units`，`priorityCap = floor(limit * priorityUtilizationTarget)`，cancel/risk 默认 `priorityUtilizationTarget=1.0`。若不想引入第二目标值，也要写清 cancel 可动用 reserve 到 published limit。

### S5. “可配”没有 public 配置路径

**参考**：PRD 说 `utilizationTarget` 和 cancel reserve 可配（`prd.md:49`, `prd.md:52`）；现有 `CreateClientOptions` 只有 `rateLimiter?: RateLimiter`，没有 rate-limit options（`src/types/shared.ts:114-124`，`docs/api.md:598-631`）；默认 `ReactiveRateLimiter` 是 internal 类（`src/internal/rate-limiter.ts:29-42`）。

**问题**：如果默认 limiter 不从 public options 接收配置，“默认 target/reserve 可配”实际上只对内部测试或深 import 用户成立。HFT/LFT 用户常需要根据多进程共享 IP 调整 target/share，这不能只靠替换整个 limiter。

**建议修改**：PRD 明确配置面：

- 要么新增 public `CreateClientOptions.rateLimit?: { utilizationTarget?, cancelReserve? ... }`。
- 要么明确本任务不提供默认 limiter public tuning，用户通过自定义 `rateLimiter` 实现；删除“可配”表述或限定为 constructor/test-only。

### S6. 主动限流等待与 `PrivateRuntimeStatus.reason = "rate_limited"` 的关系未定义

**参考**：现有 `transportReason()` 只在 `TransportError.kind === "rate_limited"` 时映射 runtime reason（`src/client/private-subscription-coordinator.ts:79-86`）；PRD 提到 `getSnapshot` 零消费方但没有新增 consumer（`prd.md:16-21`，`prd.md:56-63`）。

**问题**：PR2 后大量请求可能在 `beforeRequest()` 主动等待，但没有 transport error，也不会把 private account/order 状态置为 `degraded/rate_limited`。这可能是正确的，但 PRD 没说。用户看到健康状态 `healthy`，实际 REST reconcile/keepalive 正在被 limiter 长时间排队，会产生观测盲区。

**建议修改**：明确状态策略：

- 主动 admission wait 不改变 runtime status，避免把健康降级；但 limiter snapshot/metrics 必须可观测。
- 429/418 仍通过 `TransportError.kind:"rate_limited"` 映射现有 reason。
- 对超过阈值的 limiter wait，可选发布 internal diagnostic event 或在 `RateLimitSnapshot` 中暴露 `queued/nextAvailableAt/lastWaitMs`，并说明是否接入 health。

### S7. `getSnapshot` 的目标消费者和新 snapshot 形状缺失

**参考**：PRD指出 `getSnapshot` 在 src 内零消费方（`prd.md:20`），但 Acceptance Criteria 未要求任何 observability consumer（`prd.md:56-63`）；现有 snapshot 只能表达单 scope 的 usage/block，不表达 bucket/queue/reserve（`src/types/shared.ts:62-69`）。

**问题**：主动多桶 limiter 如果仍只按 `RateLimitScope` 查询 snapshot，无法回答 HFT 必需问题：哪个 bucket 阻塞、剩余多少、reserve 是否被动用、队列多长、下一次可用时间。没有 consumer 时，生产上只能从延迟猜 limiter 状态。

**建议修改**：PRD 至少定义内部 snapshot 的目标形状和消费者：

- 保持 public API 不增加也可以，但 default limiter 应有测试覆盖 `getSnapshot()` 能返回 bucket-level 诊断。
- 若沿用 `getSnapshot(scope)`，需要说明它如何聚合 plan 涉及的 buckets；更建议新增 optional `getSnapshots()` / `getBucketSnapshot(bucketKey)` 扩展接口。

### S8. 429/418 无 `Retry-After` 时的 fallback 仍太模糊

**参考**：研究说 PAPI REST `Retry-After` 不保证存在，418 ban 从 2 分钟到 3 天（`research/binance-papi-rate-limits.md:49-56`, `research/binance-papi-rate-limits.md:97`）；现有默认 429 fallback 是 0ms，418 fallback 是 60s（`src/internal/rate-limiter.ts:26-27`, `src/internal/rate-limiter.ts:83-98`）。

**问题**：PRD 只说 429/418 落到正确桶层级，没有定义无 header 时的冷却长度。继续沿用 429=0ms 会在 header 缺失时立刻重打；418=60s 低于研究记录的最短 ban 2 分钟。

**建议修改**：PRD 明确 fallback：

- 429：block affected bucket 到下一 interval boundary + jitter；未知 bucket 时 conservative block plausible buckets。
- 418：block host IP bucket 至 `Retry-After`，缺失时至少 2 分钟，并对连续 418 做指数延长且 never shorten。

### S9. Binance order bucket 用 SDK `accountId` 可能不等于交易所账户/UID

**参考**：研究说 `ORDERS` 是 per account，并由同账户 API keys 共享（`research/binance-papi-rate-limits.md:28-29`, `research/binance-papi-rate-limits.md:85`）；runtime 传给 adapter 的 `accountId` 是 SDK 注册 id（`src/client/runtime.ts:380-427`）。

**问题**：如果同一 Binance Portfolio Margin 账户用两个 API key 注册为两个 SDK accountId，本地 limiter 会拆成两个 order buckets，各自允许 1200/min，合计会超 exchange account limit。反过来，如果一个 SDK accountId 代表多个 exchange accounts，也会过度保守。

**建议修改**：PRD 说明 MVP 默认用 SDK `accountId` 作为 account bucket key，并记录限制；最好提供 `accountOptions.rateLimitAccountKey` / `uid` override，让同一交易所账户的多个 API key 共享 order bucket。

### S10. Acceptance Criteria 缺少会暴露上述风险的测试

**参考**：PRD 当前测试只覆盖主动延迟、429/418 全 venue、cancel reserve、per-account order 隔离、core 无 Binance 字面量（`prd.md:56-63`）。

**问题**：这些测试不足以证明 Approach B 可用，也不足以防止错误 cost/topology。

**建议修改**：补充至少以下测试：

- custom limiter 只实现现有四方法时不破坏 client 构造和 REST 调用。
- topology 重复注册幂等，冲突 descriptor 被拒绝。
- `openOrders` 无 symbol=40、有 symbol=1。
- spot/fapi/dapi/papi host buckets 独立，server-time 按当前 host。
- 并发 admission 不超 cap，多 bucket all-or-none。
- window rollover header 降低不会多阻塞，也不会提前放量。
- `cancelAllOrders` prefetch 在 normal budget exhausted 时仍按 cancel/risk priority 通过。
- order timeout/network 不退款 order bucket。

## Nice-to-have

### N1. 默认实现命名应避免继续叫 `ReactiveRateLimiter`

PRD 将默认实现从 reactive 改成主动预算引擎后，`ReactiveRateLimiter` 名称会误导。可以保留旧类名作兼容 alias，但内部实现/测试命名建议用 `BudgetRateLimiter` 或 `BucketRateLimiter`。

### N2. jitter/random/sleep/now 必须可注入，避免测试不稳定

当前 `ReactiveRateLimiterOptions` 已支持 `now` 和 `sleep`（`src/internal/rate-limiter.ts:11-42`）。新算法引入窗口 jitter 后，也应注入 `random` 或 deterministic jitter，以便边界测试稳定。

### N3. docs/spec 更新要包含行为矩阵，不只更新类型

PRD Definition of Done 提到 SPI 变化更新 docs/spec/changeset（`prd.md:65-70`）。建议在 adapter-contract 的 RateLimiter seam 中补充矩阵：registered default limiter、unregistered custom limiter、unknown plan、429、418、timeout/network、cancel priority、header rollover。这样后续 venue 接入不会重新猜规则。
