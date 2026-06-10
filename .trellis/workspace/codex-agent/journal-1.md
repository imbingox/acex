# Journal - codex-agent (Part 1)

> AI development session journal
> Started: 2026-04-20

---



## Session 1: Binance PAPI account read-only

**Date**: 2026-04-20
**Task**: Binance PAPI account read-only
**Branch**: `feat/order_account`

### Summary

(Add summary)

### Main Changes

## Summary

Implemented Binance Portfolio Margin PAPI account read-only support for the SDK.

## Completed Work

| Area | Details |
|------|---------|
| Private adapter | Added `PrivateAccountAdapter` contract and Binance PAPI implementation for signed REST, listenKey lifecycle, private WS, and `ACCOUNT_UPDATE` parsing. |
| Account manager | Replaced placeholder account snapshots with real REST bootstrap plus user data stream updates for UM-only balances, positions, and risk. |
| Runtime/options | Wired Binance private adapter into runtime and added account stream runtime options. |
| WebSocket infra | Extended managed websocket to support open-ready private streams and reconnect without requiring an initial message, while preserving market message-ready behavior. |
| Tests | Split large client test into lifecycle, market, account, and support files; removed 60s soak from regular `bun test`. |
| Live smoke | Added opt-in `test:live:account` smoke/soak scripts for real Binance PAPI account read-only validation. |
| Specs | Updated backend code organization and type safety specs with executable private account adapter contract and validation matrix. |

## Validation

- `bun run lint` passed
- `bun run type-check` passed
- `bun test` passed: 15 tests, 0 failures
- `bun run scripts/live-account-smoke.ts --help` passed
- Manual PAPI account live smoke passed with healthy status, USDT balance, and account equity observed

## Notes

- First slice intentionally covers Binance PAPI account read-only and UM positions only.
- Order tracking, trading mutations, CM positions, and Portfolio Margin Pro remain out of scope for this commit.
- Long-running L1/account stability checks now live under opt-in live smoke/soak commands instead of regular `bun test`.


### Git Commits

| Hash | Message |
|------|---------|
| `6429738` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Ship Binance private trading MVP and release automation

**Date**: 2026-04-21
**Task**: Ship Binance private trading MVP and release automation
**Branch**: `feat/order_account`

### Summary

Implemented Binance private account and order management with shared private subscription coordination, live smoke coverage for limit place/cancel, public docs/spec updates, and a Changesets plus npm Trusted Publishing release workflow.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `baeab15` | (see git log) |
| `f85a9b0` | (see git log) |
| `82ef26a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Stabilize npm release workflow after release PR rollout

**Date**: 2026-04-21
**Task**: Stabilize npm release workflow after release PR rollout
**Branch**: `fix/release-version-packages-formatting`

### Summary

Debugged the post-merge Release workflow, fixed the Changesets prerelease file formatting regression, switched package.json repository metadata to the canonical GitHub URL, and hardened version-packages so future release PRs auto-format generated metadata after changeset version. Human-side npm provenance/trusted publishing settings were then adjusted and publishing succeeded.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `678d760` | (see git log) |
| `fdcb892` | (see git log) |
| `0a4c717` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: 添加资金费率 market 数据

**Date**: 2026-04-25
**Task**: 添加资金费率 market 数据
**Branch**: `feat/funding`

### Summary

接入 Binance funding rate mark price websocket，新增 per-stream status、live smoke、文档和回归测试，并归档 Trellis 任务。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `62bea64` | (see git log) |
| `dbf5462` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: 补充 release changeset 规范并创建 PR

**Date**: 2026-04-25
**Task**: 补充 release changeset 规范并创建 PR
**Branch**: `feat/funding`

### Summary

为资金费率功能补充 minor changeset，更新 release spec 中按用户可见变更选择 changeset bump 的规则，并创建 GitHub PR #10。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5dcc3c1` | (see git log) |
| `d9e15d6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Funding 聚合接口与 Binance mark price 修复

**Date**: 2026-04-29
**Task**: Funding 聚合接口与 Binance mark price 修复
**Branch**: `feat/funding`

### Summary

新增 getMarkets/getL1Books/getFundingRates 严格 symbol 聚合接口，移除 findMarkets，修复 Binance USDⓈ-M funding mark price WS endpoint 并同步 README/docs/api 与测试。质量验证已通过 lint、type-check、market tests、全量 bun run test。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4ed0e0b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: 补充 funding 聚合 changeset

**Date**: 2026-04-30
**Task**: 补充 funding 聚合 changeset
**Branch**: `main`

### Summary

为已合并的 symbol-level market data aggregators 与 Binance funding mark price websocket 更新补充 minor changeset，并创建/合并 PR #13，确保后续 Changesets beta release 流程可生成新版本。质量验证通过 lint、type-check、全量 bun run test。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `680e315` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: Restructure test suites and CI

**Date**: 2026-04-30
**Task**: Restructure test suites and CI
**Branch**: `feat/test`

### Summary

拆分 unit/integration/soak 测试套件，新增 PR CI，补齐 public API 缺口测试，抽离通用测试工具与 Binance fixture，并更新 README、架构文档和 backend spec 测试规范。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0357dcc` | (see git log) |
| `97146d1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: 文档补充 market 订阅行为

**Date**: 2026-05-01
**Task**: 文档补充 market 订阅行为
**Branch**: `feat/market`

### Summary

补充了 Binance market 的订阅/退订行为说明，记录了当前 raw websocket 方案与 future combined 优化取舍，并完成质量检查。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2516e8a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: Post-only orders and input normalization

**Date**: 2026-05-03
**Task**: Post-only orders and input normalization
**Branch**: `feat/market`

### Summary

为下单链路新增 postOnly limit 支持，Binance PAPI UM 映射为 GTX；新增 market.normalizeOrderInput() 以按交易所 priceStep/amountStep 归一化下单价格和数量，并返回最小下单条件拒绝原因；补充 changeset、API 文档、集成测试并创建 PR #16。验证通过 lint、type-check、全量 bun run test。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9dad2f0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: Juplend lending account view

**Date**: 2026-05-05
**Task**: Juplend lending account view
**Branch**: `feat/new_account`

### Summary

Implemented venue-based account registration and Juplend read-only lending account support with lending facets, unified riskRatio, positionId filtering, serialized polling, live smoke coverage, docs/spec updates, and passing lint/type-check/tests.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c411b69` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: Venue capability queries and npm docs packaging

**Date**: 2026-05-06
**Task**: Venue capability queries and npm docs packaging
**Branch**: `feat/new_account`

### Summary

Added top-level venue capability queries, moved capability truth closer to adapters, documented constraints, and included docs/api.md in the published npm package.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ea9a4a7` | (see git log) |
| `46d1291` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 13: Refresh Binance Account Risk

**Date**: 2026-05-11
**Task**: Refresh Binance Account Risk
**Branch**: `docs/account-realtime-refresh-spec`

### Summary

为 Binance account risk 增加 REST polling 校准和 actualLeverage 补充指标，修复 PR review 中指出的状态覆盖与 stale 风险，并补充 adapter contract：实时账户字段不能假设 WS 会因行情变化持续推送，必要时必须用 polling/refresh/stale 语义保证时效性。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `50e4e09` | (see git log) |
| `9ee60cf` | (see git log) |
| `628cefe` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 14: 完成 Juplend lend-read 替换与收尾

**Date**: 2026-05-27
**Task**: 完成 Juplend lend-read 替换与收尾
**Branch**: `dev`

### Summary

用 @jup-ag/lend-read 替换 Juplend portfolio hack，补齐 wallet/direct read、RPC/Jup API 配置、风险与数量映射、CI/review 修复，以及 changeset 文案更新。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e47874a` | (see git log) |
| `99fb840` | (see git log) |
| `f997750` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: 行情多 venue 分派与 WS 连接复用

**Date**: 2026-06-01
**Task**: 行情多 venue 分派与 WS 连接复用
**Branch**: `feat/market-venue-ws-multiplex`

### Summary

完成 MarketManager 多 venue 分派、Binance 行情 WebSocket 订阅多路复用、文档与 review 修复；PR #32 已更新并通过 lint/type-check/test。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d99ac9a` | (see git log) |
| `343ac4b` | (see git log) |
| `19f60bc` | (see git log) |
| `a8328f6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: 公共数值契约：对外 BigNumber 改 canonical decimal string

**Date**: 2026-06-01
**Task**: 公共数值契约：对外 BigNumber 改 canonical decimal string
**Branch**: `feat/public-decimal-string-contract`

### Summary

将 9 个公共输出类型的数值字段由 BigNumber 改为 canonical 十进制 string，新增 src/internal/decimal.ts 的 toCanonical 统一出口、alias-safe 静态守卫测试；输入侧 DecimalInput 不变（宽进严出）。发布 bump=minor 并给 release-publishing spec 补 0.x carve-out。codex 分三阶段实现（核心 src→测试/脚本→文档/发布），Claude 审核规划并逐阶段验证（含发现 type-check≠测试 worklist、补全 PositionSnapshot.size 内部消费点）。PR review 收紧：toCanonical 对非有限值抛 RangeError 而非吐 NaN/Infinity sentinel，normalizeOrderInput 保留优雅拒绝。lint/type-check/test 全绿（85 pass），PR #34。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `adc9274` | (see git log) |
| `eb9a1a2` | (see git log) |
| `6219bee` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 17: 共享 venue 基础设施 PR1（REST 骨架 + 错误脱敏）

**Date**: 2026-06-02
**Task**: 06-01 共享 venue 基础设施（REST 骨架 / rate limiter / time provider）— PR1
**Branch**: `feat/shared-venue-infrastructure`

### Summary

PR1 由 codex 实现（新增 venue-agnostic 的 `src/internal/http-client.ts` + 三处 adapter 迁移 + 等价矩阵 + 全套单测），Claude 独立核验（重跑 lint/type-check/test、精读 http-client 错误构造与 coordinator redaction、逐条核对等价矩阵的可疑「保持」项），并派 trellis-check 做广度审，两路一致结论：质量高、无 blocker。用户裁定后由 Claude inline 补两处：(1) `patch` changeset「错误信息不再泄漏签名/密钥」；(2) http-client 单测补 rawBody 脱敏断言。随后把 PR1 契约固化进 `adapter-contract.md`（新增「共享 HTTP 传输客户端」Scenario，7 段齐全）。限流 / 统一 time provider 明确留给 PR3 / PR2。

### Main Changes

- `src/internal/http-client.ts`（新增）：`httpRequest` + typed `TransportError` + `isTransportError` 鸭子 guard + `redactSecrets` / `redactUrl` / `parseRetryAfterMs`。
- 迁移：binance market-catalog、binance private-adapter、juplend private-adapter 改走共享 client；coordinator bootstrap 错误经 `redactSecrets` 再进 public `AcexError`。
- per-call 幂等：`NO_RETRY_POLICY`（下单/撤单）、`SAFE_READ_RETRY_POLICY`（只读 GET）、`LISTEN_KEY_KEEPALIVE_RETRY_POLICY`。
- D5 脱敏：错误 url/message/rawBody 均不含签名密钥；venue 注入的 `messages` 回调只收到脱敏后的输入。
- 429/418 → `rate_limited` + 解析 Retry-After，但不重试不 sleep（退避属 PR3）。
- spec：`adapter-contract.md` 新增 Scenario §3.11–3.16 + backend `index.md` 同步。

### Git Commits

| Hash | Message |
|------|---------|
| `d9bacb6` | feat(internal): add shared HTTP transport with secret redaction; migrate binance/juplend adapters |
| `df49fa1` | docs(spec): document shared HTTP transport contract (REST skeleton, per-call idempotency, redaction) |
| `362b6b5` | chore(task): record 06-01 shared venue infrastructure PR1 |

### Testing

- [OK] `bun run lint`（biome）— 58 files, no fixes
- [OK] `bun run type-check`（tsc --noEmit）
- [OK] `bun run test` — 94 pass / 0 fail / 423 expect()

### Status

🚧 **PR1 完成并提交**（task 06-01 整体进行中）

### Next Steps

- PR2：统一 time provider（抽 `TimeProvider` 接口、签名时间从裸 `Date.now()` 收口为可注入 `now()`；server-time 校准延后到接时钟敏感新所时按 venue 补）
- PR3：rate limiter（消费 `retryAfterMs` 做退避 + 全局限流）
- 可选后续：juplend 只读 fallback 路径重试放大（best-effort enrichment/price 读可降到 `maxAttempts:1`）— 当前按 PRD「safe-read retry」收着


## Session 18: 共享 venue 基础设施 PR2（统一 TimeProvider / 可注入签名时钟）

**Date**: 2026-06-02
**Task**: 06-01 共享 venue 基础设施 — PR2（time provider）
**Branch**: `feat/venue-time-provider`

### Summary

PR1 合并后起 PR2。codex 实现（抽 `TimeProvider` 接口 + `CreateClientOptions.clock` public 选项 + `BinancePrivateAdapter.signingClock` 独立注入 + 签名 `timestamp` 收口）。Claude 独立核验：因 task_id 转写丢失，改以**工作树为准** + 自跑 `lint/type-check/test`（100 pass）+ 逐项验（#7 双时钟分离 / 公共类型导出 / 默认等价 / 范围纪律 / 签名点完整性），并派 **trellis-check** 做广度审。双轨一致：**零 blocker、可进 commit**。按用户判断（签名加密逻辑未动、默认字节等价、fake-infra 已断言签名参数）跳过 live smoke。

### Main Changes

- `src/types/shared.ts`：新增 public `TimeProvider { now(): number }` + `CreateClientOptions.clock?`（经 `types/index.ts → src/index.ts → 根 index.ts` 对外导出）。
- `src/client/runtime.ts`：`new BinancePrivateAdapter({ signingClock: options.clock })`。
- `src/adapters/binance/private-adapter.ts`：新增**独立** `signingClock?` 选项；签名优先级 `accountOptions.timestamp ?? signingClock?.now() ?? Date.now()`，`recvWindow` 不变。
- **#7 双时钟分离**：`signingClock` 只驱动签名时间，与 `receivedAt`/freshness（`context.now`、ManagedWebSocket `now`、各 adapter `receivedAt`）完全隔离；未来 server-time 校准只作用签名、不污染 §3.8。
- D3：仅抽接口 + 默认本地时钟，**不含 server-time 校准**；不做限流（PR3）。
- `tests/integration/account.test.ts` +4：clock 驱动签名 / accountOptions.timestamp 优先 / 默认本地 / **签名钟不污染 receivedAt**。
- changeset `minor`；spec `adapter-contract.md` §3.8 新增「签名/请求时间」+「签名时钟 ⟂ freshness 时钟」硬约束 + index 同步。

### Git Commits

| Hash | Message |
|------|---------|
| `c3c9460` | feat: injectable request signing clock (TimeProvider); default local clock |
| `2382b9e` | docs(spec): document signing-time vs freshness-time separation (TimeProvider) |

### Testing

- [OK] `bun run lint`（biome）/ `bun run type-check`（tsc）全绿
- [OK] `bun run test` — 100 pass / 0 fail / 454 expect()
- [SKIP] live smoke（沙箱无凭证；签名加密未动 + 默认等价，用户裁定可跳过）

### Status

🚧 **PR2 完成并提交**（task 06-01 整体进行中）

### Next Steps

- PR3：可插拔 `RateLimiter` seam，默认 reactive（读 `X-MBX-USED-WEIGHT-*` 跟踪用量 + 暴露 `rate_limited` + honor `Retry-After`），接 PR1 响应头/重试钩子与 D2 typed error 字段；proactive 权重桶留 opt-in（D4）。
- 可选 nit（非阻塞）：`account.test.ts:143-149` 既有测试内联 filter 可复用 `signedBootstrapRequests` 去重，留待后续。


## Session 19: 共享 venue 基础设施 PR3（REST 限流器 / 可插拔 RateLimiter seam）— 06-01 收尾

**Date**: 2026-06-02
**Task**: 06-01 共享 venue 基础设施 — PR3（rate limiter，收尾）
**Branch**: `feat/venue-rate-limiter`

### Summary

PR2 合并后起 PR3（三件里最复杂）。codex 实现：可插拔 `RateLimiter` seam + venue-agnostic `ReactiveRateLimiter` 默认实现，建于 PR1 已暴露的 response headers / `retryAfterMs` 之上。Claude 独立核验（工作树为准 + 自跑 `lint/type-check/test` 108 pass + 逐项验 seam 合规 / 分层 / reactive 行为 / **签名安全** / 公共面）并派 **trellis-check** 广度审。双轨一致：**0 blocker**。按用户裁定：defer should-fix#1（snapshot 边界，Binance 必带 Retry-After 且 user-facing reason 走 typed kind 不受影响）；补 nit#2 对照测试（openOrders 401 → `auth_failed`，证明 rate_limited 不误触发）；trellis-check 自修 `docs/api.md`（含补 PR2 遗漏的 `clock` 文档）；跳 live smoke（签名加密未动，与 PR2 决定一致）。**06-01 三件套（REST 骨架 / TimeProvider / RateLimiter）全部完成。**

### Main Changes

- `src/internal/rate-limiter.ts`（新）：`ReactiveRateLimiter`，venue-agnostic（零交易所常量），hook `beforeRequest`/`afterResponse`/`onTransportError`/`getSnapshot`，可注入 `now`/`sleep`。
- `src/adapters/binance/rate-limit.ts`（新）：`X-MBX-USED-WEIGHT-*`/`X-MBX-ORDER-COUNT-*` 解析（`Headers.get` 大小写不敏感、保留 interval、weight/orderCount 分轨），venue 层。
- `src/types/shared.ts`：public `RateLimiter` + `RateLimit*` 类型 + `CreateClientOptions.rateLimiter?`。
- 集成：`runtime.ts`（默认 `ReactiveRateLimiter` + 注入 market/private adapter）、`market-catalog.ts`/`private-adapter.ts`（REST 路径接 hook，scope=venue/accountId?/endpointKey）、`adapter.ts`、`coordinator.ts`（order bootstrap 补 accountId scope）。
- reactive：happy path 不主动节流（等价）；429→`rate_limited`、418→`banned`（更长 block）；**非幂等不重放**；签名退避在 timestamp 生成前。
- 测试：`rate-limiter.test.ts`（fake timer）+ 集成（429/418→reason `rate_limited`，401→`auth_failed`）+ fake infra 扩展；changeset `minor`；spec `adapter-contract.md` §3.17 + `docs/api.md`。

### Git Commits

| Hash | Message |
|------|---------|
| `0d99377` | feat: pluggable RateLimiter seam with reactive default (REST rate limiting) |
| `f48c061` | docs(spec): document RateLimiter seam contract (reactive default, venue-agnostic core) |

### Testing

- [OK] `bun run lint` / `type-check` 全绿
- [OK] `bun run test` — 108 pass / 0 fail / 470 expect()
- [SKIP] live smoke（沙箱无凭证；签名加密未动 + beforeRequest 为 happy-path no-op，用户裁定跳过）

### Status

🚧 **PR3 完成并提交**；06-01 三个 PR（REST 骨架 / TimeProvider / RateLimiter）全部完成，待 PR3 合并后整个 task 可归档。

### Next Steps

- PR3 合并后归档 06-01 task。
- 已知 defer：`ReactiveRateLimiter` 无-Retry-After 的 429 在 `getSnapshot` 不可见（Binance 不触发；将来接无 Retry-After venue 时给 429 加小默认退避窗）。
- roadmap：step 4（capability 化分派 + 清 venue 字面量 + credential validator + venue runtime options registry）/ step 5（接第一个新所 OKX/Bybit，届时按 venue 补 server-time 校准 + proactive 权重桶）。


## Session 20: 06-01 收尾：PR3 listenKey scope review 修复 + 任务归档

**Date**: 2026-06-02
**Task**: 06-01 收尾：PR3 listenKey scope review 修复 + 任务归档
**Branch**: `feat/venue-rate-limiter`

### Summary

PR3 (#40) review 修复 + 06-01 任务归档。createPrivateStream 传裸 account.options 致 listenKey rate-limit scope 缺 accountId（全局、跨账户退避污染），改为 { ...account.options, accountId } 与其它 5 处对齐 + 补回归测试（验证修前 fail / 修后 pass）。lint/type-check/test 全绿（109 pass）。06-01 三件套（REST 骨架 / TimeProvider / RateLimiter）全部完成并归档。

### Main Changes

PR3 review 修复（PR #40，本轮 work commit `4259cc6`）：
- `private-subscription-coordinator.ts:598` 的 `createPrivateStream` 传裸 `account.options` → listenKey 的 `rateLimitScope` 拿到 `accountId=undefined`（全局），与其它 5 处（runtime order×3、coordinator refresh/bootstrapAccount/bootstrapOpenOrders）不一致，且一个账户 listenKey 遇 429/418 会让其它账户 keepalive 跟着退避。改为 `{ ...account.options, accountId: account.accountId }`。
- 回归测试（`account.test.ts`）：注入 capture `RateLimiter` 断言 listenKey scope 带 `accountId`；已实测**修前 fail（undefined）/ 修后 pass**，是真守护。
- 验证：`bun run lint` / `type-check` / `test` 全绿，109 pass / 0 fail。

06-01「共享 venue 基础设施」三件套完成并归档：
- PR1 #36（已合）：共享 HTTP 客户端 + D5 错误脱敏。
- PR2 #38（已合）：统一 `TimeProvider` / 可注入签名时钟（与 freshness 时钟分离）。
- PR3 #40（待合）：可插拔 `RateLimiter` seam + reactive 默认（venue-agnostic 核 + Binance 解析在 venue 层）。

分工：codex 实现、Claude 独立核验 + trellis-check 广度审。后续 roadmap：step 4（capability 化分派 + 清 venue 字面量 + credential validator + venue runtime options registry）、step 5（接第一个新所，按 venue 补 server-time 校准 + proactive 权重桶）。


### Git Commits

| Hash | Message |
|------|---------|
| `4259cc6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 21: Step 4: capability 化 private 分派，清 venue 硬编码（PR #42）

**Date**: 2026-06-02
**Task**: Step 4: capability 化 private 分派，清 venue 硬编码（PR #42）
**Branch**: `feat/venue-capability-dispatch`

### Summary

路线图 Step 4：把 private 链路残留的 venue 字面量分派改为读 capability（orderCapabilities/accountCapabilities/refreshAccount 方法存在性），纯内部重构、对外逐字节等价。流程：拉分支+建任务+brainstorm 锁 4 个决定（credential validator 延后 Step 5 / D3 fallback 对象来源 / 3-commit-1-PR / codex 实现+Claude 逐 commit 复核）；PRD 先经 codex 对抗性复核（8 点修正全折入）。codex 实现 3 commit，Claude 逐 commit 独立复核（重跑 gate+核 diff+验测试非空洞）：#1 离散判别点（下单/订阅/credential + 新增内部 ClientContext.getPrivateOrderCapabilities）、#2 coordinator 双 predicate（stream 顺序按 updates / refresh polling 按 refreshAccount 存在性）、#3 juplendPollIntervalMs 收进 adapter 构造 + 文档。PR review 回应：修 PRD changeset 口径 + 测试 toContain 守卫，跳过 order-manager undefined 建议（保等价）。补 patch changeset（纠正初判，存记忆 internal-src-refactor-needs-patch-changeset）。118 pass/0 fail，PR #42 待 merge。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `355d8d6` | (see git log) |
| `a3aaf0e` | (see git log) |
| `f091a73` | (see git log) |
| `e61f10f` | (see git log) |
| `afa456e` | (see git log) |
| `5b9e059` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 22: market catalog reload: reloadMarkets 主动刷新目录

**Date**: 2026-06-02
**Task**: market catalog reload: reloadMarkets 主动刷新目录
**Branch**: `feat/market-catalog-reload`

### Summary

为 MarketManager 新增 public API reloadMarkets(venue?)，下游可在交易所新增 symbol 后主动刷新目录、无需重启。返回 per-venue MarketCatalogReloadSummary(added/removed/total/ok/error)；全量用 Promise.allSettled，catalog 失败保留旧目录并转 ok:false 不 reject，未注册合法 venue 仍 throw VENUE_NOT_SUPPORTED；catalogPromises 改 in-flight 登记表做 coalescing，并发同 venue 只打一次 fetch；写入前校验 adapter 返回 venue 防跨 venue 污染；不 assertStarted；严守先 fetch 后原子换/失败保留旧目录/不碰订阅三不变量。流程：brainstorm PRD → codex 对抗性复核 PRD(7 点并入) → codex 实现 → Claude 独立 review(重跑 lint/type-check/test 127 pass + 逐条核 9 条 AC)。minor changeset，PR #44。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `65fbdb2` | (see git log) |
| `f65bab7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 23: venue server time 接口 (client.market.fetchServerTime)

**Date**: 2026-06-03
**Task**: venue server time 接口 (client.market.fetchServerTime)
**Branch**: `feat/venue-server-time`

### Summary

新增公共接口 client.market.fetchServerTime(venue) 供下游衡量延迟(RTT)+估算时钟偏差。流程：brainstorm 收敛 5 项决策 → codex 审 PRD(并入 6 条修正) → 用户拍板单调时钟/仅文档 → codex 实现 → 独立复跑门禁+逐条核验红线 → trellis-check 审计(零自修) → 提交 → 开 PR #46 → 处理 PR 评审(修 #1/#2/#4，#3 经验证为非bug跳过)。关键设计：binance 固定打 USDM /fapi/v1/time、复用共享 http-client(maxAttempts:1 不重试)、roundTripMs 用 performance.now 单调时钟而 offset 用墙钟、错误分层(adapter 抛 TransportError/Error，manager 包装 MARKET_SERVER_TIME_FETCH_FAILED)、新增 VenueMarketCapabilities.serverTime、minor changeset。测试 135 pass/0 fail。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `dac87aa` | (see git log) |
| `89b38ac` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 24: AcexError 根因透传

**Date**: 2026-06-05
**Task**: AcexError 根因透传
**Branch**: `feat/acex-error-details`

### Summary

扩展公开 AcexError 错误契约，新增 cause/details、结构化交易所错误原因和脱敏 transport 诊断信息；覆盖 order、market、account/order bootstrap 包装点，补充 tests/docs/changeset/spec，并创建 PR #48。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d874b29` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 25: Binance TradFi public market data

**Date**: 2026-06-08
**Task**: Binance TradFi public market data
**Branch**: `feat/binance-tradfi-public-market`

### Summary

修复 Binance TRADIFI_PERPETUAL 合约分类，补充 AAPL/USDT public market-data fixture 与 L1/funding 订阅测试，更新 SDK 文档、API 文档和 adapter contract spec，并完成子代理 review 与验证。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `153e2d8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 26: Binance private REST reconciliation

**Date**: 2026-06-09
**Task**: Binance private REST reconciliation
**Branch**: `feat/binance-open-orders-reconcile`

### Summary

Implemented Binance private REST reconciliation for account and order convergence, fixed PR review issues around request identity, generation guards, status readiness timestamps, and watermark coverage, then opened and updated PR #53.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `3b01486` | (see git log) |
| `95ae3f2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 27: OrderManager 存储分层与 closed 订单裁剪

**Date**: 2026-06-09
**Task**: OrderManager 存储分层与 closed 订单裁剪
**Branch**: `feat/order-manager-store-tiering`

### Summary

重构 OrderManager 内部存储:open/closed 两表按 symbol 嵌套 + 复合身份三索引((symbol,orderId) 精确 / orderId-only 歧义 / clientOrderId 一对多覆盖 open+closed)+ closed 按 symbol FIFO 批量裁剪(CreateClientOptions.order.maxClosedOrdersPerSymbol,默认 500)+ 无 orderId 终态单 provisional 兜底。codex 实现(2 阶段)、Claude 逐段 review、codex 总体审核挑出并修复 3 个 cid 复用边界 bug(cid-only 归并 retained closed、seq 跨订单比较、provisional warning)、codex 复审通过。179 测试全绿,patch changeset,PR #54(stacked on feat/binance-open-orders-reconcile)。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `89f846e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 28: OrderManager 内部 localOrderId 身份模型 + pending claim (PR #56)

**Date**: 2026-06-10
**Task**: OrderManager 内部 localOrderId 身份模型 + pending claim (PR #56)
**Branch**: `feat/order-manager-local-order-id`

### Summary

Brainstorm 敲定 OrderManager 内部 localOrderId 身份地基(D1–D9):三类 id(localOrderId 内部主键 / venueOrderId / venueClientOrderId)、四索引、external-order-claim、下单 pending claim(防 REST 返回前早到 WS 双建)、未传 cid 时 SDK 生成并发送合规 acex-* cid;public API/类型零改动;submitting/WS 异步下单 out of scope。codex 实现 + Claude 独立 review(重跑三门 + 逐段审 diff,修复 issuedLocalOrderIds 无界增长内存泄漏)。开 PR #56,并按 PR review 把 order-manager.ts 中文注释改英文。lint/type-check/test 全绿(185 pass)。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `acbdfd8` | (see git log) |
| `d4cbafb` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 29: 全库 review 发现固化为 docs/improvement-todo.md

**Date**: 2026-06-10
**Task**: 全库 review 发现固化为 docs/improvement-todo.md
**Branch**: `main`

### Summary

完成 acex 全库 review(订单/行情/账户链路+基础层+Binance 适配器),将 31 项发现按 P0/P1/P2 分级写入 docs/improvement-todo.md(含 file:line、修复方案、验证方式);cancelAllOrders 响应形状已通过 Binance 官方文档核实为 {code,msg} 对象(P0-1 坐实);后续按 P0-1→P0-2→P0-3 三个独立任务串行修复

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `1783541` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
