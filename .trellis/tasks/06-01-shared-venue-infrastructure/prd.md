# Shared venue infrastructure (REST skeleton, rate limiter, time provider)

> 路线图 step 3（`docs/multi-venue-roadmap.md` §3）。定位：「接原型 = P1，发稳定 SDK / 接第一个新所 = P0」的共享基础设施。

## Goal

在接入第二个中心化交易所之前，补齐 venue-agnostic 的三件共享基础设施：
1. **统一 REST 骨架** —— timeout / retry / 错误归一，替换各 adapter 各写一份的 HTTP。
2. **REST 限流器** —— 当前只有类型壳、零实现。
3. **统一 time provider** —— 签名时间目前直接 `Date.now()`，缺 server-time 校准；OKX/Bybit/Gate 私有 REST/WS 对时钟漂移敏感。

## What I already know（auto-context 已核实，截至分支 `feat/shared-venue-infrastructure`）

- **3 份独立 HTTP 实现，行为不一致**：
  - `src/adapters/binance/private-adapter.ts:524` `readJson` —— 裸 `fetch`，**无 timeout / 无 retry**，`!ok` 抛裸 `Error`（带 status+body）。
  - `src/adapters/binance/market-catalog.ts:215` `fetchJson` —— 另一份。
  - `src/adapters/juplend/private-adapter.ts:263` `readJson` —— **有** `AbortController` timeout（`DEFAULT_HTTP_TIMEOUT_MS`）、处理 upstream signal，但**无 retry**。
- **签名时间**：`private-adapter.ts:874-876` 直接 `params.set("timestamp", ... ?? Date.now())`；`recvWindow` 默认在 `:880`。
- **错误契约**（`adapter-contract.md:152`）：**adapter 不得自己构造 `AcexError`**，错误码归 manager/runtime（`src/errors.ts`）。交易命令 REST 失败 adapter 抛裸 `Error`，manager 包成 `ORDER_*_FAILED`（`:147`）。→ 共享 REST 层做「错误归一」只能产出 **transport 级**错误，不能越界产业务 `AcexError`。
- **限流**：`src/types/shared.ts:134` 有 `"rate_limited"` 状态类型，**零实现**。WS 控制帧限流（5/sec）已在 multiplexer（§3.10），但 **REST 限流**（Binance weight `X-MBX-USED-WEIGHT-*` / `429` / `418` + `Retry-After`）未覆盖。
- **时间契约**（`adapter-contract.md:160-164` §3.8）：`receivedAt` 必须本地时间、「不信任交易所时钟」；`exchangeTs` 缺失不可伪造。→ 该契约管 **freshness 时间**，**未覆盖签名时间**的 server-time 校准（新地盘）。
- `src/internal/managed-websocket.ts:50` 已有 `now = options.now ?? Date.now` 注入点 —— time provider 在 WS 侧已有注入位，但无统一 provider。
- `AcexErrorCode`（`errors.ts`）当前无 transport / network / rate-limit 码。

## Assumptions (temporary)

- 暂无第二个 venue 落地；本任务以 **venue-agnostic 抽象 + 用 Binance/Juplend 现状回归验证** 为主，默认**不改对外行为**（除非显式决定把 server-time 校准纳入 MVP）。
- 运行时为 Node（`fetch` / `AbortController` 可用，juplend 已在用）。

## Open Questions（仅 blocking / preference，待与用户逐条对齐）

- ~~Q1 范围/交付粒度~~ → **已定**：方案 2，单任务 + 3 个顺序 PR（见 Decision D1 / Implementation Plan）。
- ~~Q2 server-time 校准~~ → **已定**：方案 A，只抽 `TimeProvider` 接口、默认本地时钟，server-time 校准延后到 step 5（见 D3；路线图 §2.1 已相应放宽）。
- ~~Q3（PR3）限流器强制 vs 观测~~ → **已定**：方案 C，`RateLimiter` 做成可插拔 seam、默认实现为 reactive（观测+反应），proactive 权重桶留作同 seam opt-in/后续（见 D4）。
- ~~Q4 错误归一落点~~ → **已定**：方案 A，`src/internal/` 出 typed transport error，adapter 冒泡、manager 归一到现有 `AcexError` 码（见 D2）。

## Requirements (evolving)

- venue-agnostic 共享 HTTP 客户端（`src/internal/`，Layer 0 领域无关原语）：timeout（`AbortController`）、可配重试 + 退避、统一非 2xx 处理 → 失败抛 **typed transport error**（见 D2）。重试按**每次调用显式幂等声明**（`idempotent` / `retryPolicy`，**不靠 method 猜**）：可重试＝catalog / account / openOrders 等只读 GET；默认不重试＝createOrder / cancelOrder / cancelAllOrders、listenKey start·close；listenKey keepalive PUT 可有限重试（见 codex 审核 #4）。
- **错误 redaction（D5）**：对外错误 message 不得包含 `signature` / API key / 完整 signed query；典型迁移点 `private-adapter.ts:527-529`、`private-subscription-coordinator.ts:682-687`。
- binance（private + catalog）与 juplend 迁移到共享 HTTP，删掉 3 份重复 `readJson`/`fetchJson`。
- REST 限流器：venue-agnostic 的可插拔 `RateLimiter` seam（见 D4），默认实现为 reactive —— 读响应头（`X-MBX-USED-WEIGHT-*`）跟踪用量、暴露 `rate_limited` 状态、遇 `429`/`418` honor `Retry-After` 退避；不主动排队/节流。proactive 权重桶留作同 seam 下的 opt-in/后续。
- 统一 time provider：抽 `TimeProvider` 接口、把签名处 `Date.now()` 收口为可注入 `now()`，默认本地时钟（**server-time 校准不在本任务**，见 D3）。接口须**区分「签名/请求时间」与「本地 receivedAt/freshness 时间」**，命名与穿透路径预留分离，避免 step 5 server-time 校准污染 §3.8 freshness 契约（codex 审核 #7）；`accountOptions.timestamp` 继续优先于 provider、`recvWindow` 语义不变。

## Acceptance Criteria (evolving)

- [ ] binance/juplend REST 全部走同一 HTTP 客户端；旧 `readJson`/`fetchJson` 删除。
- [ ] 所有 REST 调用具备 timeout；重试按每次调用显式幂等声明，下单/取消/listenKey start·close 默认不重试。
- [ ] 对外错误不泄漏 `signature` / API key / 完整 signed query（含单测覆盖 redaction）（见 D5）。
- [ ] `clock?: TimeProvider` / `rateLimiter?: RateLimiter` 作为 public `CreateClientOptions` 选项，接口导出为公共类型 + 附 changeset；HTTP 客户端不公共可替换（见 D6）。
- [ ] `RateLimiter` 为可插拔 seam；默认 reactive 实现：跟踪响应头用量、暴露 `rate_limited` 状态、遇 `429`/`418` 按 `Retry-After` 退避（不主动排队/节流）。
- [ ] 签名时间走 `TimeProvider.now()`（默认本地时钟；不含 server-time 校准）。
- [ ] 不破坏现有 manager 错误码契约（adapter 仍抛 transport 错误、manager 仍归一）。
- [ ] lint / type-check / test 全绿；新增单测覆盖 timeout / retry / 限流 / time provider。

## Definition of Done

- 单元/集成测试覆盖新路径（timeout、retry-or-not、限流、time provider 注入）。
- lint / type-check / CI 全绿。
- `adapter-contract.md` 补 REST 骨架 / 限流 / time provider 契约段；`docs/` 视行为变化更新。
- 回滚/风险：迁移 Binance 私有 REST 属高敏感路径，需保证行为等价 + 可灰度——PR1 须**可独立 revert、不与 PR2/PR3 混改**；下单命令建议合并前保留新旧双路径对比测试。仅 `bun run test` 不足以证明签名路径，签名/下单回归须跑（或 reviewer 手动跑）live smoke（`test:live:account:smoke`、`test:live:order:smoke`）（codex 审核 测试与回滚段）。

## Decision (ADR-lite)

### D1 — 交付粒度（Q1）

- **Context**：step 3 捆了 REST 骨架 / time provider / 限流器三块独立组件，且 PR1 触及高敏感的 Binance 签名 REST 路径。
- **Decision**：留在单一任务内，按 **HTTP 客户端 → time provider → 限流器** 出 **3 个顺序 PR**（方案 2）。
- **Consequences**：每个 PR 小而可审；PR1 以行为等价为主、**唯一有意例外是 redact 签名 URL / API secrets**（见 D5）、风险隔离；time/限流均建于 PR1 的响应/重试钩子之上；共享设计上下文留在同一 PRD。代价：3 个 PR 的流程开销。

### D2 — 错误归一落点（Q4）

- **Context**：`adapter-contract.md:152` 禁止 adapter/internal 构造 `AcexError`；现有 `AcexErrorCode` 无传输码。
- **Decision**：方案 A —— `src/internal/` 定义 typed transport error（`kind: timeout | http | network | rate_limited`、`status?`、`retryable`、交易所原始 body）。adapter 让其冒泡；manager/runtime 仍按现契约归一到现有业务码。**本任务不扩公共 `AcexErrorCode`**。
- **Consequences**：守住 `:152`；typed 字段（`retryable` / `rate_limited`）直接服务 PR1 重试与 PR3 限流。**修正（codex 审核已核验）**：现状 manager/coordinator 并非「sniff string」，而是按 venue 硬编码 reason（`private-subscription-coordinator.ts:679` `venue === "juplend" ? "http_failed" : "auth_failed"`）+ 静态 message 包装（`order-manager.ts:674-683`）；typed 字段让这些 reason 从硬编码升级为按 `kind` 精确派生（区分 `rate_limited` / `http_failed` / `auth_failed`），**公共 `AcexErrorCode` 不变**。若日后消费者需稳定传输码，另开 PR 扩。

### D3 — time provider 校准范围（Q2）

- **Context**：路线图 §2.1 原要求「含 server-time 校准」并视时钟漂移为新所系统性失败点；但宿主机一般 NTP 同步、Binance `recvWindow` 吸收常规漂移。
- **Decision**：方案 A —— PR2 只抽 `TimeProvider` 接口（`now()`），把签名处 `Date.now()` 收口为可注入；**默认本地时钟**，不实现 server-time 拉取/offset。server-time 校准延后到 step 5 接第一个时钟敏感的新所时按 venue 补。
- **Consequences**：PR2 行为等价、风险低、立好注入桩。代价：时钟漂移兜底缺口留到 step 5。已据此**放宽路线图 §2.1**（校准从硬性要求降为延后项）。

### D4 — 限流器强制 vs 观测（Q3）

- **Context**：Binance REST 为 weight 制（响应头 `X-MBX-USED-WEIGHT-1m`，超限先 `429`、再 `418` 封禁带 `Retry-After`），下单另有独立 count 限制。当前仅有 `src/types/shared.ts:134` 的 `"rate_limited"` 状态类型、零实现。proactive 权重桶需维护 per-endpoint 权重表，易与交易所变更脱节且对当前低 QPS 的 SDK 消费方过度。
- **Decision**：方案 C —— `RateLimiter` 做成可插拔 seam，**默认实现为 reactive**（观测+反应：读响应头跟踪用量、暴露 `rate_limited` 状态、遇 `429`/`418` honor `Retry-After` 退避，不主动排队/节流）；proactive 权重桶留作同 seam 下的 opt-in，等真实用量/telemetry 佐证再上。
- **Consequences**：先发「发布必做」的 Retry-After + `rate_limited` 暴露（reactive 即发布门槛），点亮已存在的 `rate_limited` 类型；直接复用 D2 的 typed transport error 字段（`kind: rate_limited` / `retryable` / `Retry-After`）。seam 一次做对，proactive 扩展位预留给 step 5 接限流敏感新所时按 venue 补。代价：reactive 挡不住突发下的第一发 `429`（由退避兜底）；多一点 seam 接口设计。

### D5 — PR1 错误 redaction（codex 审核 #2，已核验）

- **Context**：现状 Binance private 非 2xx 把**完整签名 URL** 拼进 `Error.message`（`private-adapter.ts:527-529`；URL 含 `signature`/`timestamp`/`recvWindow`，见 `:882-884`），account bootstrap 失败再把原始 `error.message` 拼进 public `AcexError`（`private-subscription-coordinator.ts:682-687`）——签名/密钥可达对外错误，是安全 footgun。
- **Decision**：方案 A —— PR1 把「redact 签名 URL / API key / 完整 signed query」列为**明确的、受测的、可接受行为变化**（非严格等价）。typed transport error 内部可留 redacted request metadata 供调试，对外 message 不含 `signature` / API key / 完整 signed query。
- **Consequences**：泄漏不被固化进共享基础设施契约；PR1 的「行为等价」明确为「行为等价 + 这一处有意 redaction」，等价矩阵须把它单列为 intended diff 并加 redaction 测试。代价：PR1 不再是 100% 纯重构。

### D6 — 注入入口公共面边界（#8）

- **Context**：clock / rate limiter / HTTP client 的注入入口该不该进 public `CreateClientOptions`（现仅 sandbox/logger/logLevel/market/account，`shared.ts:49-55`）。public 面是契约承诺；step 4 另有 venue runtime options registry，过早暴露 venue-specific 选项会致 step 4 返工（codex #8）。
- **Decision**：public 注入，但按「**venue-agnostic 横切 seam 才上公共面**」划界：
  - **Public**（top-level `CreateClientOptions`，与既有 `logger`/`logLevel` 同类横切）：`clock?: TimeProvider`（默认本地时钟）、`rateLimiter?: RateLimiter`（默认 reactive）——`RateLimiter` 公共化正是 D4「proactive opt-in」可达的前提；两接口导出为 `src/types/*` 公共类型。
  - **Internal-only**：共享 HTTP 客户端**不**公共可替换（保签名 + D5 redaction 不被绕过）；timeout/retry 如需可调走普通 config，不暴露可替换 client；测试经 internal/adapter constructor 注入 fake `fetch`。
  - **延后 step 4**：任何 venue-specific 限流/权重/运行时配置不进本任务公共面，归 venue runtime options registry。
- **Consequences**：消费方可注入自定义时钟/限流器（含 proactive），与 `logger` 注入范式一致；公共面最小且稳定。代价：`TimeProvider`/`RateLimiter` 成为公共契约 → 触发 type-safety / doc / changeset 义务（`release-publishing`）；签名传输保持封闭，安全边界不被公共注入打穿。

## Implementation Plan（small PRs）

- **PR1 — 共享 HTTP 客户端**：venue-agnostic HTTP（timeout / retry / 错误归一）+ 迁移 binance private、binance catalog、juplend 三处（**含 binance listenKey POST/PUT/DELETE 路径**，`private-adapter.ts:931-953`），删除重复 `readJson`/`fetchJson`。**行为等价 + 一处有意 redaction（D5）**；须附**行为等价矩阵**（catalog / signed GET / order POST·DELETE / listenKey / juplend 逐项列迁移前后差异，标出 intended diff）作为「等价」证明物（codex 审核 #1）。
- **PR2 — time provider**：抽 `TimeProvider` 接口、替换签名处 `Date.now()` 为可注入 `now()`，默认本地时钟（**不含 server-time 校准**，见 D3）。
- **PR3 — REST 限流器**：可插拔 `RateLimiter` seam，默认 reactive 实现（读头跟踪用量 + 暴露 `rate_limited` + honor `Retry-After`），接 PR1 的响应头/重试钩子与 D2 的 typed error 字段；proactive 权重桶留 opt-in（见 D4）。
- **PR1↔PR3 职责契约（429/Retry-After，codex 审核 #5）**：PR1 负责**暴露 response headers**、把 `429`/`418` typed 成 `kind: "rate_limited"`、解析 `Retry-After` 到 `retryAfterMs`（`418` 标更长 blockedUntil），但**是否 sleep/重放交给 retry policy 或 PR3 limiter**；PR3 reactive limiter 经 `afterResponse()`/`onError()` 钩子统一更新状态与退避。**非幂等请求遇 429/418 默认不自动重放**，只暴露 rate-limited 状态 + retry metadata。

## 设计约束（codex 审核已 fold；全文 file:line 见 [`codex-prd-review.md`](codex-prd-review.md)，已注入 implement.jsonl）

🟡 实现前须在设计中落实（此处记**取向**，字段级细节在 review 文件）：

- **typed transport error 字段具体化**（#3）：补齐 request / response / error 三组字段（error 含 `parse` kind、`retryAfterMs`、`attempts`、redacted url）；manager/coordinator 只经 **type-guard** 读，不跨 bundle `instanceof`。
- **RateLimiter seam**（#6）：定义 hook 形（`beforeRequest` / `afterResponse` / `onTransportError` / `getSnapshot`）与 scope 粒度（`venue` / `accountId?` / `endpointKey`；weight 是 IP 维度、order-count 另算）；`418` 区别于 `429`（更长 blockedUntil）；状态映射到 `PrivateRuntimeReason: "rate_limited"`（`shared.ts:130-135`）。
- **注入入口（#8，已定 → 见 D6）**：`clock?: TimeProvider` / `rateLimiter?: RateLimiter` 上 public `CreateClientOptions`（与 `logger` 同类横切）；共享 HTTP 客户端不公共可替换；venue-specific 配置延后 step 4。
- **manager/coordinator 迁移表**（#9）：列各 call site（`market-manager.ts:472-484`、`order-manager.ts:661-683`、`private-subscription-coordinator.ts` 多处）的 typed→reason/code 映射；公共 `AcexErrorCode` 保持不变。
- **契约文档段落职责**（#10）：`adapter-contract.md` 新增段覆盖 Layer 0 定位、adapter 注入 venue URL/signing/normalization、不构造 `AcexError`、签名时间 vs receivedAt 分离、retry 幂等 call-site 显式、limiter hook venue-agnostic（Binance header 解析在 venue 层）。

## Out of Scope (explicit)

- step 5 接第一个新所（OKX/Bybit）。
- step 4 capability 化分派 + 清 4 处 venue 字面量 + per-adapter credential validator + venue runtime options registry。
- §2.4 symbol 共享边界、§2.6 `AsyncEventBus` 事件背压（未排期松散点）。
- §6 数值契约（已完成）。

## Technical Notes

- 锚点：见 `What I already know`。
- 契约对齐：`adapter-contract.md` §3.6（错误，`:141-152`）、§3.8（时间戳，`:160-164`）、§3.9/§3.10（WS，已落地）。
- 复用参考：juplend `readJson` 的 timeout/abort 写法（`:263-309`）是共享 HTTP timeout 的现成蓝本。
- Binance 官方限流口径已部分记录在 `adapter-contract.md:191-194`（WS 侧），REST weight 口径需新增。
