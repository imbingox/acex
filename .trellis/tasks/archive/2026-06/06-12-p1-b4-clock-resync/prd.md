# P1-B4 签名时钟自动同步回路

## Goal

私有签名请求的 `timestamp` 目前来自 `options.clock`（默认本地 `Date.now`）。`fetchBinanceServerTime`
实现质量很好（单调钟 RTT、NTP 式中点 offset），但**没有任何调度**：无启动多次采样、无周期重测、无漂移平滑、
收到 Binance `-1021`（`timestamp_out_of_sync`）也不会自动重校。本地时钟漂移超过 `recvWindow` 时，
**所有签名请求静默失败且无自愈**——对挂单密集策略是严重可用性风险。

本任务内置一个 venue 级、自动同步的 TimeProvider：启动采样取中位 → 周期重测 + 漂移平滑 →
收到 `-1021` 立即重校；`options.clock` 保留为用户覆盖入口（注入即关闭自动同步）。

## What I already know（代码事实）

- `TimeProvider` 接口（`src/types/shared.ts:27`）只有 `now(): number`，public。
- 注入链：`CreateClientOptions.clock`（`shared.ts:311`）→ `runtime.ts:139` `signingClock: options.clock`
  → `BinancePrivateAdapter` 构造 `signingClock?: TimeProvider`（`private-adapter.ts:678`）。
- 签名取时优先级：`accountOptions.timestamp` > `signingClock?.now()` > `Date.now()`（`private-adapter.ts:1247-1253`）。
- server-time 取样源：`fetchBinanceServerTime()`（`server-time.ts:37`）返回 `VenueServerTime`
  （`serverTime` / `requestSentAt` / `responseReceivedAt` / `roundTripMs` / `estimatedOffsetMs`），
  经共享 `httpRequest` + rateLimiter，`maxAttempts:1` 不自动重试。market adapter 已用它实现 `fetchServerTime()`（`adapter.ts:82`）。
- `-1021` 归一：`error-codes.ts:9` 已把 `-1021/-5028` → `timestamp_out_of_sync`（批次①产物），
  private adapter 暴露 `normalizeVenueErrorCode()`（`private-adapter.ts:685`）。
- 默认 `recvWindow`：`DEFAULT_RECV_WINDOW`（`private-adapter.ts:1257` 引用）。
- 跨切面共享服务范式：`RateLimiter` 在 `runtime.ts:130-141` 创建一次、注入 market + private 两个 adapter
  （`ReactiveRateLimiter` 默认，public `CreateClientOptions.rateLimiter?` 覆盖）——TimeProvider 自动同步可复刻此范式。

## 硬约束（来自 spec，必须遵守 + 完成后回写）

- `adapter-contract.md:210-211`：**签名时钟 ⟂ freshness 时钟**。自动校准只能作用于签名 `timestamp`，
  **绝不能**驱动 `receivedAt`/freshness 的 `now()`。完成后需更新 211 行"当前不自动做 server-time 校准"的措辞。
- `adapter-contract.md:150 / 255-257 / 527`：server-time 请求 `maxAttempts:1`、限流 sleep 不计入 RTT、
  解析失败/HTTP 失败的错误形态——重测路径必须沿用 `fetchBinanceServerTime`，不得绕过这些契约。

## Decision (ADR-lite)

**Context**：自动同步逻辑放哪、如何与 venue 解耦、`-1021` 信号如何回流。
**Decision**：方案 A——core 通用 `SyncingTimeProvider`（`src/internal/`，venue-agnostic）实现 `TimeProvider`，
构造接收 `sample: () => Promise<VenueServerTime>`（Binance 注入 `fetchBinanceServerTime`）+ 调度参数；
`now()` = 本地墙钟 + 平滑 offset，独立于 freshness 时钟。`runtime.ts` 创建一次注入私有 adapter
`signingClock`（类比 rateLimiter）。`-1021` 回流：`TimeProvider` 加可选 `requestResync?()`，adapter 检测到
`timestamp_out_of_sync` 时调用，不持有任何同步逻辑。`options.clock` 注入时不创建 provider（自动同步关闭）。
**Consequences**：复用 `fetchBinanceServerTime` 全部契约；adapter 保持纯净；未来加 venue 只需再注入 sampler。

**Q2（配置面）= 方案①**：零公共配置，内置默认常量；`clock` 仍是唯一公共覆盖位（注入 `{now:()=>Date.now()}`
即关闭自动同步）。内部调度参数保留为 `SyncingTimeProvider` 构造可选项（仅供单测注入快周期/可控采样），不进 public API。
changeset = **patch**（默认运行时行为变化但无 API 变化，仍需发布，见 [[internal-src-refactor-needs-patch-changeset]]）。

**Q4（采样/平滑）确定参数**：
- 启动：串行采样 N=5 次，取 `estimatedOffsetMs` 中位作初始 offset；部分失败用成功样本中位；全失败 offset=0（退化本地钟）+ 上报一次可观测事件，靠周期重测纠正。
- 周期：每 5min 单次重测，EMA 平滑 `offset = α·new + (1-α)·old`，α=0.3。
- `-1021`：去抖（2s 合并）→ 立即单次重测并直接采纳（不走 EMA，快速纠偏）。
- 漂移告警：重测后 `|new-old| > recvWindow/2`（默认阈值 2500ms）上报一次 health 事件，仍采纳新值。
- 不强制 `now()` 单调（签名 timestamp 无单调要求，平滑已抑制跳变）；offset 用墙钟差，RTT 用单调钟（沿用 `fetchBinanceServerTime`）。

## Technical Approach

- 新增 `src/internal/syncing-time-provider.ts`：`class SyncingTimeProvider implements TimeProvider`。
  - 构造：`{ sample, now?, resyncIntervalMs?, startupSamples?, smoothingAlpha?, driftWarnMs?, onResync?, onSampleFailed? }`。
  - `now()`：`(this.options.now ?? Date.now)() + this.offsetMs`。
  - `start()`：跑启动中位采样 → 启动周期 timer；`stop()`：清 timer（杜绝泄漏，呼应 P2-10）。
  - `requestResync()`：去抖触发一次立即重测。
  - 重测失败保留旧 offset、不抛、经回调上报。
- `TimeProvider` 接口（`src/types/shared.ts`）加可选 `requestResync?(): void`（不破坏既有实现）。
- `runtime.ts`：未注入 `options.clock` 时，创建 `SyncingTimeProvider`（sampler = `() => fetchBinanceServerTime({ rateLimiter })`），
  注入私有 adapter `signingClock`；`start()/stop()` 联动 provider 的 `start()/stop()`；失败/漂移经 health/error 总线上报。
- `private-adapter.ts`：签名请求回包/抛错路径检测到 `timestamp_out_of_sync`（复用 `normalizeBinanceErrorCode`）时调用 `signingClock?.requestResync?.()`。
- 校准只作用签名 `timestamp`，**不触碰** `receivedAt`/freshness（隔离测试断言）。

## Lifecycle & Edge cases

- provider 生命周期挂在 client `start()/stop()`；timer 必须在 stop 清理。
- 启动采样异步进行；窗口内若有签名请求，offset 暂为 0（本地钟），recvWindow 容差通常可覆盖，万一 `-1021` 则触发立即重校。
- venue 级单例：多账户共享同一 offset（offset 是 venue↔本地的钟差，与账户无关）。
- 自动同步关闭（用户注入 clock）时 sampler 零调用、无 timer。

## Requirements (evolving)

- 启动时多次采样取中位，得到初始 offset。
- 周期性重测，漂移平滑（避免单次抖动污染 offset）。
- 收到 `-1021`/`timestamp_out_of_sync` 触发立即重校。
- `signingClock.now()` = 本地单调推进 + offset 修正；不污染 freshness 时钟。
- `options.clock` 用户注入时关闭自动同步（用户完全接管）。
- 重测失败有降级（保留旧 offset，不让签名时间跳变），并通过 health/error 总线可观测。

## Acceptance Criteria (evolving)

- [ ] 单测：注入带固定漂移的假钟 + 假 server-time 采样源，断言 offset 收敛到真实漂移。
- [ ] 单测：注入 `-1021` 信号触发一次立即重校（且不与周期重测重复打）。
- [ ] 单测：重测失败时保留旧 offset、不抛、签名时间不跳变，并上报一次可观测事件。
- [ ] 单测：`options.clock` 注入时不启动自动同步（采样源零调用）。
- [ ] 单测：签名时钟校准不改变 freshness/`receivedAt` 路径（隔离回归）。
- [ ] 回写 `adapter-contract.md` §签名时钟一节；更新 `docs/api.md` 若有公共配置变化。

## Definition of Done

- 单测覆盖上述 AC；`bun run lint` / `bun run type-check` / `bun run test` green。
- 若新增公共配置/接口字段 → minor changeset；纯内部实现（仅默认行为）→ 评估是否 patch changeset。
- spec + docs 同步更新；live account smoke 长跑观察无 `-1021`（live 复核步骤记录）。

## Out of Scope

- 非 Binance venue 的时钟校准（Juplend 走 Solana RPC，无签名 timestamp 语义）。
- WS-API 下单的时间戳（P2-1，独立设计）。

## Technical Notes

- 关键文件：`src/adapters/binance/server-time.ts`、`src/client/runtime.ts`、`src/types/shared.ts`、
  `src/adapters/binance/private-adapter.ts`、`src/adapters/binance/error-codes.ts`、`.trellis/spec/backend/adapter-contract.md`。
