# PRD 审核：Shared Venue Infrastructure

## 锚点核验结果

- 路线图状态属实：Step 3 明确是共享基础设施，范围含 REST 骨架、错误归一、timeout/retry、rate limiter、time provider（`docs/multi-venue-roadmap.md:21`、`docs/multi-venue-roadmap.md:81-83`）。§2.1 已把 server-time 校准从本任务硬要求降为 step 5 延后项（`docs/multi-venue-roadmap.md:57-59`）。
- Binance private `readJson` 锚点属实：`src/adapters/binance/private-adapter.ts:524-537` 读 `response.text()`，非 2xx 抛普通 `Error`，message 包含 status/statusText/url/body；无 timeout、无 retry。注意 url 是已签名 URL，`signedRequest()` 在 `src/adapters/binance/private-adapter.ts:884-892` 把含 `signature` 的 query 传入 `readJson()`。
- Binance private 不止 signed REST：listenKey 的 `POST`/`PUT`/`DELETE` 也裸 `fetch` 并复用同一 `readJson()`（`src/adapters/binance/private-adapter.ts:931-953`）。PRD 把它合在 private adapter 内是合理的，但 PR1 等价矩阵必须单列 listenKey 路径。
- Binance 签名时间锚点属实：`timestamp` 默认 `Date.now()`（`src/adapters/binance/private-adapter.ts:874-877`），`recvWindow` 默认 `DEFAULT_RECV_WINDOW`（`src/adapters/binance/private-adapter.ts:878-880`）。`accountOptions.timestamp` 当前优先级高于 `Date.now()`，PRD 需要求保留。
- Binance catalog `fetchJson` 锚点属实：`src/adapters/binance/market-catalog.ts:215-224` 使用可注入 `fetchFn`，无 timeout/retry；非 2xx 错误不含 body/url，成功直接 `response.json()`，空 body 行为不同于 Binance private。
- Juplend `readJson` 锚点属实：`src/adapters/juplend/private-adapter.ts:263-309` 有 `AbortController` timeout、传播 upstream `signal`、finally 清 timer/listener；但非 2xx 错误不带 body，AbortError 被重写成普通 `Error`，无 retry。
- `rate_limited` 类型存在但未实现属实：`src/types/shared.ts:130-135` 的 `PrivateRuntimeReason` 含 `"http_failed"`/`"rate_limited"`。
- WS 侧已有 clock 注入位属实：`createManagedWebSocket()` 使用 `options.now ?? Date.now`（`src/internal/managed-websocket.ts:48-52`）；`PrivateStreamOptions.now` 已存在（`src/adapters/types.ts:208-214`），Binance private WS 已透传 `options.now`（`src/adapters/binance/private-adapter.ts:804-809`）。
- `AcexErrorCode` 当前无 transport/network/rate-limit 码属实：`src/errors.ts:1-17` 仅有业务/领域错误码。
- “manager sniff string”表述不准确：当前主要是硬编码包装/状态 reason，而不是解析字符串。OrderManager 发布原始 adapter error 后返回业务 `AcexError`，不带原始 message（`src/managers/order-manager.ts:678-683`）；PrivateSubscriptionCoordinator 则在 bootstrap public message 中拼接原始 `error.message`（`src/client/private-subscription-coordinator.ts:682-687`），并在多处硬编码 `"http_failed"`/`"auth_failed"`（`src/client/private-subscription-coordinator.ts:432-439`、`src/client/private-subscription-coordinator.ts:550-563`、`src/client/private-subscription-coordinator.ts:673-680`、`src/client/private-subscription-coordinator.ts:724-735`）。

## 高优先补充（必补）

### 1. PR1 必须补“行为等价矩阵”，否则纯重构不可审

PRD 只说 PR1 “纯重构、行为等价”（`prd.md:88`），但三个现有 HTTP 实现行为差异很大：

- Binance private：`response.text()`、空 body 返回 `{}`、错误 message 包含 body 和完整 URL（`src/adapters/binance/private-adapter.ts:524-537`）。
- Binance catalog：可注入 `fetchFn`、成功直接 `response.json()`、错误 message 只含 status/statusText（`src/adapters/binance/market-catalog.ts:215-224`）。
- Juplend：固定 `DEFAULT_HTTP_TIMEOUT_MS`、upstream abort 传播、AbortError 被区分为 timeout/aborted 文案（`src/adapters/juplend/private-adapter.ts:263-309`）。

PRD 应增加一张矩阵，逐类列出迁移前后必须保持或有意改变的行为：Binance catalog、Binance signed GET、Binance order command POST/DELETE、Binance listenKey POST/PUT/DELETE、Juplend metadata/prices/vaults。列项至少包括 fetch 注入、method/header/query、empty body、JSON parse failure、non-2xx body、timeout、upstream signal、error message、raw body 保留、response header 暴露。

### 2. “行为等价”不能盲目保留签名 URL 泄漏

当前 Binance private 非 2xx 错误会把完整签名 URL 写进 `Error.message`（`src/adapters/binance/private-adapter.ts:527-529`），而 signed URL 来自 `src/adapters/binance/private-adapter.ts:884-892`，包含 `timestamp`、`recvWindow`、`signature`。账户 bootstrap 失败还会把原始 `error.message` 拼进 public `AcexError`（`src/client/private-subscription-coordinator.ts:682-687`）。

PRD 应明确这是“有意行为变化”还是“兼容保留”。建议必补：typed transport error 保存 redacted request metadata，public/runtime error message 不包含 `signature`、API key、完整 signed query；测试覆盖 redaction。否则 PR1 会把安全 footgun 固化成共享基础设施契约。

### 3. HTTP 客户端接口与 typed transport error 需要具体字段

D2 只列了 `kind/status/retryable/body`（`prd.md:68-72`），还不足以实现 retry、限流、manager 归一和调试。PRD 应指定 internal API 的最小形状：

- request：`method`、`url`/`URL`、`headers`、`body`、`signal`、`timeoutMs`、`parseAs`、`emptyBody` 策略、`idempotency`/`retry` 显式选项、`venue?`、`endpointKey?`。
- response：parsed body、raw text、status/statusText、headers、receivedAt/request metadata。
- error：`kind: "timeout" | "http" | "network" | "rate_limited" | "parse"` 是否纳入、`status?`、`statusText?`、`rawBody?`、`parsedBody?`、`headers?`、`retryAfterMs?`、`retryable`、`attempts`、`cause`、redacted URL。
- type guard：manager/coordinator 只能通过 guard 读取 typed 字段，避免 internal class 跨 bundle `instanceof` 脆弱。

同时应写明 `src/internal/` 是 Layer 0 领域无关原语（`.trellis/spec/backend/code-organization.md:94-99`），可以依赖 `src/types/*`，但不能依赖 manager/client 或构造 `AcexError`（`.trellis/spec/backend/adapter-contract.md:139-152`）。

### 4. 重试策略必须按“每次调用显式幂等”定义

PRD 只写“幂等感知，默认不重试下单等非幂等 POST”（`prd.md:39`），仍会让实现者靠 method 猜。交易命令里 `POST /papi/v1/um/order` 明显不应自动重试（`.trellis/spec/backend/order-execution.md:53-59`、`src/adapters/binance/private-adapter.ts:654-684`）；`DELETE /papi/v1/um/order`、`DELETE /papi/v1/um/allOpenOrders` 也有业务副作用，不能仅因 method 是 DELETE 就判定可重试（`src/adapters/binance/private-adapter.ts:696-738`）。listenKey `POST` 可能创建会话，`PUT` keepalive 可考虑重试，`DELETE` close 是 best-effort。

PRD 应要求每个 call site 显式传 `idempotent: true | false` 或 `retryPolicy: "none" | "safe-read" | ...`，并列出默认分类：

- 可安全重试：catalog GET、account bootstrap/refresh GET、openOrders GET、Juplend read-only GET。
- 默认不重试：createOrder、cancelOrder、cancelAllOrders、listenKey start/close，除非未来按 venue 证明安全。
- 可有限重试：listenKey keepalive PUT，需说明重复 PUT 的交易所语义。

还需定义 max attempts、per-attempt timeout vs total timeout、指数退避、jitter、AbortSignal 已 abort 时不重试、network/timeout/5xx/429/418/parse error 的不同处理，以及 `Retry-After` 优先级。

### 5. PR1 与 PR3 的 429/Retry-After 职责重叠需要拆清

PR1 负责 retry，PR3 又要求遇 `429`/`418` honor `Retry-After`（`prd.md:41`、`prd.md:90`）。如果 PR1 不解析 response headers，PR3 没有数据；如果 PR1 先实现 429 retry，又会提前引入限流行为。

PRD 应明确顺序契约：

- PR1 HTTP client 必须暴露 response headers，并把 429/418 typed 为 `kind: "rate_limited"`，解析 `Retry-After` 到 `retryAfterMs`，但是否 sleep/retry 由 retry policy 或 PR3 limiter 决定。
- PR3 reactive limiter 接入 `afterResponse()`/`onError()` 钩子，统一更新状态与退避。
- 非幂等请求遇 429/418 时是否自动等待后重试必须明示；建议默认不重放请求，只暴露 rate-limited 状态与 retry metadata。

### 6. RateLimiter seam 需要接口、粒度和状态传播契约

D4 的方向合理，但 PRD 没定义 seam 长什么样（`prd.md:80-84`）。应补：

- hook 形状：`beforeRequest(ctx)`, `afterResponse(ctx, response)`, `onTransportError(ctx, error)`, `getSnapshot(scope)` 或等价接口。
- scope 粒度：至少区分 `venue`、`accountId?`、`endpointKey`、可能的 IP/global bucket；Binance weight 是 IP 维度，order count 又可能与 account/order endpoint 相关，不能只存一个全局数字。
- Binance header：读取 `X-MBX-USED-WEIGHT-*` 与 `X-MBX-ORDER-COUNT-*`，保留 interval key（如 `1m`）和值；未知 interval 不丢弃。
- 429 vs 418：429 是限流，418 是 ban；418 应标记更长 `blockedUntil`/`retryAfterMs`，避免当普通 retryable 5xx 处理。
- 状态输出：明确如何把 typed `rate_limited` 映射到 `PrivateRuntimeReason: "rate_limited"`（`src/types/shared.ts:130-135`），替换 coordinator 里现有硬编码 `"http_failed"`/`"auth_failed"`（`src/client/private-subscription-coordinator.ts:432-439`、`src/client/private-subscription-coordinator.ts:673-680`、`src/client/private-subscription-coordinator.ts:724-735`）。

### 7. TimeProvider 语义要分清“签名时间”和“本地 receivedAt/freshness 时间”

PRD 说“统一 time provider”（`prd.md:42`），但 adapter-contract 规定 `receivedAt` 是 SDK 本地时间，不信任交易所时钟（`.trellis/spec/backend/adapter-contract.md:160-164`）。如果未来 server-time 校准复用同一个 `TimeProvider.now()` 并传入 ManagedWebSocket，会污染 freshness/receivedAt 语义。

PRD 应补语义边界：本任务可以只提供默认本地 clock，但接口命名和穿透路径必须避免未来歧义。建议区分：

- local clock：用于 `ClientContext.now()`、`receivedAt`、WS timeout/freshness（`src/client/runtime.ts:270-271`、`src/internal/managed-websocket.ts:48-52`）。
- signing/request time provider：用于 Binance signed REST `timestamp`（`src/adapters/binance/private-adapter.ts:874-877`）。

还应明确 `accountOptions.timestamp` 继续优先于 provider，`recvWindow` 默认和 override 不变（`src/types/shared.ts:64-67`、`src/adapters/binance/private-adapter.ts:878-880`）。

### 8. TimeProvider 和 RateLimiter 的注入入口不能留空

当前 public `CreateClientOptions` 只有 `sandbox/logger/market/account`（`src/types/shared.ts:49-55`），runtime 构造 adapter 时没有 clock/rest/limiter 注入点（`src/client/runtime.ts:102-132`）。PRD 应明确：

- 是否新增 public option；若新增，属于公共 API，需 type-safety/doc/tests。
- 或仅在 internal/adapter constructor 里注入，public 入口延后；那测试如何注入 fake clock/limiter 也要写清。
- 若 public venue runtime options registry 属 step 4 out of scope（`prd.md:94-96`），本任务不要临时塞一组 venue-specific option 导致 step 4 返工。

### 9. manager/coordinator 归一规则需要可测试迁移点

D2 说 manager catch-all 从 sniff string 升级为读 typed 字段（`prd.md:72`），但现状不是集中 catch-all，而是多个 call site：

- catalog load 包成 `MARKET_CATALOG_LOAD_FAILED` 并发布原始 adapter error（`src/managers/market-manager.ts:472-484`）。
- order command 包成 `ORDER_*_FAILED`，public `AcexError` 不带原始 message（`src/managers/order-manager.ts:661-683`）。
- account refresh/onError/bootstrap/order bootstrap 各自硬编码 reason（`src/client/private-subscription-coordinator.ts:420-439`、`src/client/private-subscription-coordinator.ts:550-563`、`src/client/private-subscription-coordinator.ts:673-680`、`src/client/private-subscription-coordinator.ts:724-735`）。

PRD 应要求列出这些 call site 的迁移表：typed timeout/http/network/rate_limited 分别映射到 runtime event、account/order status reason、public AcexError code/message。尤其要说明本任务不扩 `AcexErrorCode`（`src/errors.ts:1-17`），因此 public code 保持不变，但 internal event 的 error 对象和 status reason 会更精确。

### 10. 契约文档增补内容需要具体到段落职责

DoD 只写“`adapter-contract.md` 补 REST 骨架 / 限流 / time provider 契约段”（`prd.md:57`），不够指导实现。PRD 应指定新增契约至少覆盖：

- REST client 放在 `src/internal/`，adapter 注入 venue-specific URL/signing/normalization。
- adapter REST 失败必须抛 typed transport error 或普通同步构造错误，不得吞错，不得构造 `AcexError`。
- signing timestamp 与 `receivedAt` 的时钟语义分离。
- retry/idempotency 由 call site 显式声明。
- rate limiter hook 是 venue-agnostic，Binance header 解析在 venue adapter 或策略层提供，不能把 Binance header 常量写死到通用核不可扩展位置。

## 建议补充（可选）

- 给 HTTP client 加 `parseAs: "json" | "text" | "none"`，避免强迫所有调用统一成 `response.json()`；Binance private 当前空 body 返回 `{}`（`src/adapters/binance/private-adapter.ts:532-536`），listenKey keepalive/delete 可能依赖该行为。
- typed transport error 可实现 `toJSON()`/debug snapshot，但 public error message 保持短且 redacted。
- 明确 JSON parse failure 是否算 transport `parse` 错误；当前三个路径没有统一处理，PR1 后至少应有可测语义。
- RateLimiter snapshot 建议不进入 public API，先通过 internal event/status 暴露；否则会和 step 4 runtime options registry 产生公共面耦合。
- 对 Binance `X-MBX-USED-WEIGHT-*` header 名大小写做测试，使用 `Headers.get()` 的大小写不敏感能力即可，不要手写大小写匹配。
- 如果需要 sleep 退避，测试应允许注入 `setTimer`/fake timer，避免 `bun test` 慢和 flaky。

## 可挑战的决策

- 不挑战 D1/D2/D3/D4 的总体方向。真正需要挑战的是 D1 后果里的“PR1 纯重构、行为等价”（`prd.md:64-66`、`prd.md:88`）：如果完全保留 Binance private 错误 message，可能继续泄漏 signed URL；如果修正 redaction，则 PR1 不是严格行为等价。建议 PRD 把“redact signed URL/API secrets”列为 PR1 的明确、受测、可接受行为变化。
- D3 “统一 TimeProvider”不应被解释为单一 clock 覆盖全部 `receivedAt` 和 signing timestamp。server-time 校准延后是合理的，但接口命名和穿透路径必须预留“local clock vs signing clock”的分离，否则 step 5 会与 adapter-contract §3.8 冲突。

## 测试与回滚缺口

- HTTP client 单测：success JSON/text/empty body、non-2xx raw body、JSON parse failure、timeout、upstream abort、network error、per-attempt timeout、total attempts、AbortSignal 已 abort 不 retry、redacted error metadata、header 暴露、Retry-After 秒/HTTP date 解析。
- Retry 单测：GET 可重试、POST/DELETE order 默认不重试、listenKey PUT 策略、5xx/network/timeout/429/418 的分支、jitter/最大次数可控。
- Adapter 回归：用现有 fake Binance infra 记录 request（`tests/support/exchanges/binance.ts:302-358`），固定 `timestamp/recvWindow`（现有测试已断言 `tests/integration/account.test.ts:127-128`、`tests/integration/order.test.ts:246-247`），补签名、API key header、listenKey method/path、catalog fetchFn 注入、Juplend upstream signal。
- Manager/coordinator 集成：429/418 后 account/order status reason 变为 `"rate_limited"`，非限流 HTTP 仍为 `"http_failed"` 或既定 auth 语义；public `AcexErrorCode` 保持 `ACCOUNT_BOOTSTRAP_FAILED`/`ORDER_*_FAILED` 等现有码。
- Live/smoke：PR1 触及 Binance private signed REST，至少要求 `bun run test:live:account:smoke` 和 `bun run test:live:order:smoke` 的执行策略或明确由 reviewer 手动跑；仅 `bun run test` 不足以证明签名路径。
- 灰度/回滚：PRD 只写“可灰度”（`prd.md:58`），但没有方案。应明确 PR1 是否保留旧 HTTP 路径 behind internal flag、是否提供 per-adapter constructor 注入旧/new client、或至少保证 PR1 独立可 revert 且不与 PR2/PR3 混改。对于 Binance order command，建议 PR1 合并前先保持旧/新双路径测试对比，合并后再删除旧 helper。
