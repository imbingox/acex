# venue server time 接口用于延迟测量

## Goal

为 venue 抽象新增「获取交易所服务器时间」的统一接口，让下游能够衡量延迟（latency）并校正本地与交易所之间的时钟漂移（clock skew）。当前代码库没有任何 server-time 接口，下游只能用流式数据自带的 `receivedAt - exchangeTs` 近似估算，但这个差值混入了时钟偏差、无法分离出真实网络延迟。

## What I already know

- venue 核心抽象：`MarketAdapter`（`src/adapters/types.ts:73`）、`PrivateUserDataAdapter`（`src/adapters/types.ts:216`）。两者均无 server-time / ping / latency 方法。
- 下游**不直接消费 adapter**，而是通过公共 `AcexClient`（`src/types/client.ts:128`）的 `market` / `account` / `order` manager + `getVenueCapabilities()` / `listVenueCapabilities()`。新接口需同时设计 adapter 层与 client 暴露面。
- 能力门控模型：`VenueMarketCapabilities`（`src/types/client.ts:84`，含 catalog / l1Book / fundingRate / marketTypes）。server-time 能力天然是这里的新字段。
- 已有 `TimeProvider`（`src/types/shared.ts:27`）仅表示**本地签名时钟**（默认 `Date.now()`），与交易所 server time 无关；契约明确「不信任交易所时钟」（`adapter-contract.md:173`）。
- REST 调用模式：`requestCatalogJson(fetchFn, url, rateLimiter, label)`（`src/adapters/binance/market-catalog.ts`，`loadBinanceMarkets` 在 293 行）。Binance 现成端点：`/api/v3/time`（spot）、`/fapi/v1/time`（USDM）、`/dapi/v1/time`（COINM），返回 `{ serverTime: <epoch ms> }`。
- 实际落地的 venue：`binance`（完整）、`juplend`（Jupiter Lend，链上借贷，**无 server time 概念**）。`okx` / `bybit` / `gate` 在 `Venue` 联合类型（`src/types/shared.ts:9`）中声明但尚未实现 adapter。
- 流式更新已带 `exchangeTs?`（交易所推送 epoch ms，可能缺失）与 `receivedAt`（本地 epoch ms），见 `src/adapters/types.ts:24-25` 等。

## Assumptions (temporary)

- MVP 仅实现 binance；接口设计需为其他 venue 预留，但不强制全部实现（可选方法 + capability 门控）。
- juplend 不实现该接口（链上无统一 server time）；其 capability 标记为 unsupported。
- 衡量延迟的核心价值在于返回值要能让下游算出 RTT 与时钟偏差，而不只是裸 server time。

## Decision (ADR-lite) — 返回契约

**Context**: 任务核心目标是让下游衡量延迟；返回形态决定方法签名、capability 形态与暴露面。
**Decision**: 采用 NTP 风格的开箱即用返回对象（选项 3）：
```ts
interface VenueServerTime {
  serverTime: number;        // 交易所返回的服务器时间, epoch ms (墙钟)
  requestSentAt: number;     // SDK 发请求前的本地墙钟, epoch ms (Date.now)
  responseReceivedAt: number;// SDK 收响应时的本地墙钟, epoch ms (Date.now)
  roundTripMs: number;       // 单调时钟测得的往返耗时 (performance.now 差值), 不受墙钟跳变影响
  estimatedOffsetMs: number; // serverTime - (requestSentAt + responseReceivedAt) / 2
}
```
**Consequences**: 下游既拿结论（RTT / offset）也拿原始墙钟时间戳可自行重算；`roundTripMs` 用单调时钟（决策 A），故**不恒等于** `responseReceivedAt - requestSentAt`（墙钟差），这是有意为之——避免本地 NTP step 导致负/失真 RTT；`estimatedOffsetMs` 隐含上下行对称假设，需在契约文档注明局限；墙钟戳与现有 `exchangeTs`/`receivedAt` 约定一致。

## Decision (ADR-lite) — 暴露面

**Context**: 下游通过公共 `AcexClient` 消费，需决定 server time 方法挂在哪一层。
**Decision**: 挂在 `client.market.fetchServerTime(venue)`（`MarketManager`），与 `reloadMarkets(venue?)` 同构。adapter 侧新增**可选**方法 `MarketAdapter.fetchServerTime?(): Promise<VenueServerTime>`；不支持的 venue 不实现该方法，由 capability 标记 + manager 层兜底。
**Consequences**: 与现有 venue-scoped REST 操作分层一致；binance time 端点为公开行情端点，归属 market 层自然；可选方法不破坏现有 adapter。

## Decision (ADR-lite) — Capability 门控与不支持行为

**Context**: 需让下游能预先判断 venue 是否支持 server time，并定义不支持时的行为。
**Decision**:
- (a) `VenueMarketCapabilities` 新增 `serverTime: VenueCapabilitySupport`（`"supported" | "unsupported"`）。binance = `"supported"`；`unsupportedMarket`（juplend 及未实现 venue）= `"unsupported"`。下游可查 `getVenueCapabilities(venue).market.serverTime`。
- (b) `client.market.fetchServerTime(venue)` 对无 market adapter 或不支持的 venue **抛 `AcexError`**，沿用 manager 现有 `"Venue is not supported yet: ${venue}"`（`market-manager.ts:652/663`）风格。
**Consequences**: 能力可声明可预查；错误处理与 `subscribeL1Book`/`subscribeFundingRate`/`reloadMarkets` 一致；下游 try/catch 即可。

## Decision (ADR-lite) — binance 端点

**Context**: Binance 三集群各有独立 time 端点，下游关心交易集群的 RTT。
**Decision**: MVP 固定使用 USDM 合约端点 `/fapi/v1/time`（`https://fapi.binance.com/fapi/v1/time`，返回 `{ serverTime: number }`），文档注明用的是 USDM 集群。将来如需 spot/coinm 精确测量，再加可选 `marketType?` 参数（向后兼容扩展）。
**Consequences**: 实现最小；USDM 为本 SDK 主力集群；纯 spot 下游测到的是合约集群 RTT（差异可接受，文档说明）。

## Decision (ADR-lite) — 失败/超时/重试

**Context**: server time 用于测延迟，失败/重试/错误分层直接影响 RTT 语义与契约合规。
**Decision**:
- **不自动重试**：单次往返。经共享 http-client（`src/internal/http-client.ts`）的 `retryPolicy: { maxAttempts: 1 }`（内部 clamp ≥1），保证 `roundTripMs` 反映一次真实往返；失败即抛。
- **错误分层（codex 审核修正）**：adapter **只抛 `TransportError`**（HTTP 失败）或普通 `Error`（响应缺/非 number `serverTime` 的校验失败），**不得在 adapter 构造 `AcexError`**（adapter-contract.md §3.6 `:162` / §3.13 `:485-488`）。由 `MarketManager.fetchServerTime()` catch 后包装成**新增**错误码 `MARKET_SERVER_TIME_FETCH_FAILED`（加进 `src/errors.ts` 的 `AcexErrorCode`，public contract），并 `publishRuntimeError`——与 `createCatalogLoadError`（`market-manager.ts:589`）同构。
- **复用共享 HTTP + rate limiter**：沿用 `requestCatalogJson` 同款骨架，传现有 `RateLimiter`（time 端点 weight=1）；脱敏沿用 http-client。
- **超时**：复用默认 `DEFAULT_HTTP_TIMEOUT_MS = 10_000`。
**Consequences**: 错误分层合规（adapter 抛 transport/Error、manager 定错误码）；新增 public 错误码计入 minor changeset；唯一刻意设计是「不重试」保 RTT 语义。

## Decision (ADR-lite) — 时间戳采集点与时钟 seam（codex 审核新增）

**Context**: RTT 正确性依赖采集点；adapter 当前无 market 级可注入时钟（`adapter.ts:57` 构造器只收 `rateLimiter`），PRD 原称「复用现有可注入时钟」不属实。
**Decision**:
- **采集点**：在 `rateLimiter.beforeRequest()` resolve **之后**、`httpRequest()` **之前**同时采集 `requestSentAt = now()`（墙钟）与 `startMono = monotonicNow()`（单调）；在 `httpRequest()` resolve 后、`afterResponse()` 前采集 `responseReceivedAt = now()`（墙钟）与 `endMono = monotonicNow()`（单调）。`roundTripMs = endMono - startMono`（决策 A，单调，免墙钟跳变）；`estimatedOffsetMs` 用墙钟戳。避免限流 sleep 混入 RTT（`requestCatalogJson:242-245`）。
- **时钟 seam**：实现 helper 接受可选 `now?: () => number`（默认 `Date.now`）、`monotonicNow?: () => number`（默认 `performance.now`）、`fetchFn?`（默认全局 `fetch`），供确定性单测注入；不复用不存在的 adapter 级时钟。
**Consequences**: RTT 不含限流等待、不受 NTP step 影响；单测可注入确定性墙钟/单调时钟与 fetch；`performance.now()` 在 Bun/Node 均可用。

## Open Questions（已全部解决）

- **A. 单调时钟 RTT** → 采纳：`roundTripMs` 用 `performance.now()` 差值，`estimatedOffsetMs` 用 `Date.now()` 墙钟。
- **B. 暴露测量源** → 不加字段，**仅强文档说明**固定测 USDM 集群；将来加 `marketType` 参数时再一并暴露 source。

## Requirements

- 公共类型新增 `VenueServerTime`（`src/types/market.ts`，public contract），字段见返回契约 ADR：`serverTime` / `requestSentAt` / `responseReceivedAt` / `roundTripMs` / `estimatedOffsetMs`（均 epoch ms / ms）。
- `MarketAdapter` 新增可选方法 `fetchServerTime?(): Promise<VenueServerTime>`（`src/adapters/types.ts`）。
- `VenueMarketCapabilities` 新增 `serverTime: VenueCapabilitySupport`（`src/types/client.ts`）；`unsupportedMarket` fallback 置 `"unsupported"`（`src/client/venue-capabilities.ts`）。
- `BinanceMarketAdapter` 实现 `fetchServerTime()`，打 USDM `https://fapi.binance.com/fapi/v1/time`，`marketCapabilities.serverTime = "supported"`（`src/adapters/binance/adapter.ts:46` 的 capability 字面量 + `market-catalog.ts` 同源 helper 或新增 time 模块）。失败抛 `TransportError`、`serverTime` 缺失/非 number 抛普通 `Error`，**不在 adapter 构造 `AcexError`**；实现 helper 接受可注入 `now?`/`monotonicNow?`/`fetchFn?`。
- `src/errors.ts` 的 `AcexErrorCode` 新增 `MARKET_SERVER_TIME_FETCH_FAILED`（public contract，计入 minor）。
- `MarketManager` 新增 `fetchServerTime(venue: Venue): Promise<VenueServerTime>`（`src/types/market.ts` 接口 + `src/managers/market-manager.ts` 实现）：查 market adapter，缺失或无该方法时抛 `AcexError("VENUE_NOT_SUPPORTED", ...)`（沿用 `:647` 风格）；委派时 catch adapter 的 transport/Error 包装成 `MARKET_SERVER_TIME_FETCH_FAILED` 并 `publishRuntimeError`（与 `createCatalogLoadError` `:589` 同构）。**不调用 `assertStarted()`**——与 `reloadMarkets`（`:180`）一致，不要求 `client.start()`。
- 文档：`.trellis/spec/backend/adapter-contract.md`（新方法契约 + 对称假设局限）、`.trellis/spec/backend/venue-capabilities.md`（新增 `serverTime` 能力语义 + Validation 矩阵 + Tests Required）同步更新。
- changeset：`.changeset/*.md`，bump = **minor**（新增 public API + public 类型字段 + 新 capability 字段）。

## Acceptance Criteria

- [ ] `client.market.fetchServerTime("binance")` 返回含 `serverTime` / `requestSentAt` / `responseReceivedAt` / `roundTripMs` / `estimatedOffsetMs` 的对象；`roundTripMs` 由单调时钟测得（`>= 0`、有限，不强求等于墙钟差）；`estimatedOffsetMs` 由墙钟戳派生。
- [ ] `getVenueCapabilities("binance").market.serverTime === "supported"`；`juplend` / okx / bybit / gate 为 `"unsupported"`。
- [ ] 对无 market adapter 或不支持的 venue 调用 `fetchServerTime` 抛 `AcexError("VENUE_NOT_SUPPORTED", ...)`。
- [ ] binance 端点失败 / 响应缺 `serverTime` 时：adapter 抛 `TransportError`/`Error`，manager 包装成 `AcexError("MARKET_SERVER_TIME_FETCH_FAILED", ...)`；不重试（`maxAttempts: 1`）。
- [ ] `fetchServerTime` 在未 `client.start()` 时仍可调用（不抛 `CLIENT_NOT_STARTED`）。
- [ ] `requestSentAt` 在 rate limiter `beforeRequest` 之后采集（RTT 不含限流等待）。
- [ ] 单测覆盖：binance 正常解析 + 失败路径 + attempts=1 + 缺失/非 number `serverTime` + 限流前后顺序 + 未 start 可调用 + 注入单调时钟验证 `roundTripMs` 取单调差值；manager 不支持 venue 抛错；capability 快照含 `serverTime`。
- [ ] `.changeset/*.md`（minor）已添加，summary 描述用户可见能力。
- [ ] lint / type-check / test 全绿。

## Technical Approach

- **数据流**：`client.market.fetchServerTime(venue)` → `MarketManager`（venue 路由 + 不支持兜底抛 `VENUE_NOT_SUPPORTED` + catch 包装 `MARKET_SERVER_TIME_FETCH_FAILED`）→ `BinanceMarketAdapter.fetchServerTime()` → 复用 `src/internal/http-client.ts`（`maxAttempts: 1`）打 `/fapi/v1/time`。
- **时间戳采集（codex 修正 + 决策 A）**：在 `beforeRequest()` 后、`httpRequest()` 前采集墙钟 `requestSentAt` 与单调 `startMono`；在 `httpRequest()` resolve 后采集墙钟 `responseReceivedAt` 与单调 `endMono`。`serverTime` 取自响应体；`roundTripMs = endMono - startMono`（单调）；`estimatedOffsetMs` 用墙钟戳。时钟经 helper 注入的 `now?`（默认 `Date.now`）/ `monotonicNow?`（默认 `performance.now`），**不复用不存在的 adapter 级时钟**。
- **错误分层（codex 修正）**：adapter 只抛 `TransportError`/`Error`，错误码归 manager（adapter-contract §3.6/§3.13）。
- **capability 真源靠近 adapter**：binance adapter 的 `marketCapabilities` 声明 `serverTime: "supported"`，runtime 仅聚合（符合 venue-capabilities.md「capability 真源应尽量靠近 adapter」+ clone 要求；新增标量字段不影响 clone）。
- **复用而非新写**：HTTP 走共享传输客户端；rate limiter 走现有 `RateLimiter`；脱敏沿用 http-client。

## Implementation Plan (codex 修正：docs+测试+changeset 必须与 API 同 PR 落地)

> venue-capabilities.md `:64` 要求「新增 public capability 字段必须同步 docs、测试、changeset」。故 public API（含 `serverTime` capability 字段）+ docs + tests + changeset **必须在同一可发布单元**，不能拆成可独立 merge 的 PR。采用单一 feature PR（本切片不大），如需分阶段则用 **stacked PR 一起 merge**。

- **单一 feature PR（推荐）**：
  - 类型骨架：`VenueServerTime`、`MarketAdapter.fetchServerTime?()`、`VenueMarketCapabilities.serverTime`、`unsupportedMarket` fallback、`MarketManager` 方法签名、`AcexErrorCode` 新增码。
  - manager 实现：venue 路由 + `VENUE_NOT_SUPPORTED` + 包装 `MARKET_SERVER_TIME_FETCH_FAILED` + 不 `assertStarted`。
  - binance 实现：`fetchServerTime()` 真打 `/fapi/v1/time`（http-client，`maxAttempts: 1`，注入 `now?`/`monotonicNow?`/`fetchFn?`），`serverTime: "supported"`。
  - 测试：见 AC（解析/失败/attempts=1/缺字段/限流顺序/未 start/不支持 venue/capability 快照）；fixture 放 `tests/support/exchanges/binance.ts`。
  - docs：`adapter-contract.md`（新方法契约 + 错误分层 + 对称假设局限）、`venue-capabilities.md`（`serverTime` 语义 + Validation 矩阵 + Tests Required）。
  - `.changeset/*.md`（**minor**）。
- 若坚持分阶段：拆成 stacked PR（骨架→binance→边角），但 **最终一起 merge**，避免中途出现「有 capability 字段但缺 docs/changeset」的可发布状态。

## Definition of Done (team quality bar)

- Tests added/updated（unit；binance 解析/失败/attempts=1/限流顺序/未 start；manager 不支持 venue；capability 快照）
- Lint / typecheck / CI green
- 契约文档（`adapter-contract.md`）与 capability 文档（`venue-capabilities.md`）同步更新
- changeset（**minor**：新增 public API + `VenueServerTime` 类型 + `serverTime` capability 字段 + `MARKET_SERVER_TIME_FETCH_FAILED` 错误码）

## Out of Scope (explicit)

- okx / bybit / gate 的 adapter 实现（未落地，留待各自实现时补该能力）。
- 自动持续时钟同步 / 后台轮询校正（本任务只提供按需查询接口）。
- 把 server time 回灌到签名 `TimeProvider`（签名时钟设计保持本地，不在本任务变更）。

## Technical Notes

- 核心文件：`src/types/market.ts`（`VenueServerTime` 类型 + `MarketManager` 方法）、`src/adapters/types.ts`（`MarketAdapter.fetchServerTime?`）、`src/types/client.ts`（`VenueMarketCapabilities.serverTime`）、`src/client/venue-capabilities.ts`（`unsupportedMarket` fallback）、`src/managers/market-manager.ts`（路由 + 兜底）、`src/adapters/binance/adapter.ts` + `market-catalog.ts`（binance 实现）。
- HTTP：复用共享传输客户端 `src/internal/http-client.ts`（`requestCatalogJson` 同源），`retryPolicy: { maxAttempts: 1 }` 不重试；adapter 抛 `TransportError`/`Error`，由 manager 包装成 `AcexError`（错误码归 manager，§3.6/§3.13），脱敏沿用 http-client。
- Binance USDM time 端点 `https://fapi.binance.com/fapi/v1/time` 返回 `{ serverTime: number }`（epoch 毫秒），公开端点无需签名，weight=1。
- 测试：单测放 `tests/unit/`，capability integration 放 `tests/integration/`，binance fixture 放 `tests/support/exchanges/binance.ts`。
- 发布：新增 public API/类型/capability 字段 → changeset bump = **minor**（release-publishing.md §3.7 + bump 矩阵）。
- 对称假设：`estimatedOffsetMs` 基于 NTP 上下行对称假设，需在 adapter-contract.md 注明局限。
