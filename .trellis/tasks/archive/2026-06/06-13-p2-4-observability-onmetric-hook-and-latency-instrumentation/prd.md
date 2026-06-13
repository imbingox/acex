# P2-4 可观测性：onMetric 钩子 + 延迟打点

## Goal

实现最小可观测性能力：一个 `onMetric` 同步回调钩子 + 关键路径打点（下单 RTT、WS 消息延迟等），让下游策略/运维能采集 SDK 内部延迟与事件指标。当前 `logger`/`logLevel` 是预留位未实现。来源：`docs/improvement-todo.md` P2-4。

## What I already know（调研见 research/observability-context.md）

- **预留位**：`Logger` 接口 + `LogLevel` 已在 `src/types/shared.ts:18-25` 定义，`CreateClientOptions.logger/logLevel`（:316-327）是纯占位、全库未读取。
- **注入路径**：`options.clock` → runtime 构造 → `VenueAdapterFactoryDeps` → adapter（runtime.ts:271-285/82-90/143-185）。onMetric 可走同样路径。
- **manager 打点扩展点**：`ClientContext`（context.ts:30-53）已有 `publishRuntimeError`/`publishHealthEvent`，加一个 `emitMetric` 最自然；runtime 持有 `options.onMetric`。
- **下单 RTT**：`OrderManagerImpl` 已有 `requestStartedAt = context.now()`（order-manager.ts:235/288/331）包住 `await context.createOrder` 等——是最佳打点位。⚠️ adapter 的 `receivedAt` 在 HTTP 请求**前**采样（private-adapter.ts:1110/1157），不能当 RTT 终点。
- **WS 延迟**：`exchangeTs` + `receivedAt` 在 RawL1BookUpdate/RawOrderUpdate/RawAccountUpdate 都已存在（adapter mapper 填好），manager/coordinator callback 直接算 `receivedAt - exchangeTs`。
- **事件点**：reconnect（managed-websocket close→scheduleReconnect / private onReconnected）、buffer overflow（async-event-bus `onOverflow` → 已 publishRuntimeError）、rate-limit block（rate-limiter，但 `RateLimiter` 是 public SPI、custom 实现无法内省）。
- **无 metric 雏形**：仅 healthBus + errorBus 两条 AsyncEventBus。

## Technical Approach（已定的技术决策）

- **纯同步 callback，不是第四条 event stream**：metric（尤其 WS tick latency）是热路径高频，走 AsyncEventBus 会引入 event 对象/队列/filter/overflow 成本 + cardinality 问题。经 `CreateClientOptions.onMetric` 注入。
- **零开销原则**：runtime 缓存 `onMetric` 到 private 字段；`emitMetric` 首行 `if (!onMetric) return`；热路径调用点先判断 emitter 存在、再计算 latency/构造 tags（未注入不构造 `{venue,symbol}`）。
- **RTT 用 monotonic**（`performance.now()`）测 duration，不受时钟 offset/回拨影响；wall-clock `now()` 仅用于 watermark。
- **manager/coordinator 层打点**：那里有 venue/symbol/accountId tags + update 已带 exchangeTs/receivedAt；adapter 层若需打点经 factory deps 注入 emitter（类似 publishRuntimeError）。
- **callback 异常吞掉**（try/catch，参考 SyncingTimeProvider「observability callbacks must not break main flow」先例）。

## Open Questions

- [x] Q1 已决：核心（下单 RTT + WS 消息延迟）+ reconnect 计数 + buffer overflow 计数；REST 延迟 / rate-limit block 留后续（实现重 + tag 不全 / custom limiter 无法内省）。
- [x] Q2 已决：位置参数 `onMetric(name: string, value: number, type: MetricType, tags?: Record<string, string>)`，`MetricType = "counter" | "gauge" | "timing"`；SDK 发的 metric name 固定、导出为 const 常量集合 + docs 列全。下单 RTT / WS latency = `timing`，reconnect / overflow = `counter`。
- [x] Q3 已决：只做 onMetric；`logger`/`logLevel` 占位原样保留、留后续（独立关注点，与 errors()/health() 流职责需单独厘清）。

## Requirements (evolving)

- `onMetric` 经 `CreateClientOptions` 注入；未注入时热路径零额外开销。
- 打点范围（Q1 已决）：下单 RTT（create/cancel/cancelAll，timing）+ WS 消息延迟（L1 tick + private order/account，`receivedAt-exchangeTs`，timing）+ reconnect 计数（counter）+ buffer overflow 计数（counter）。

## Acceptance Criteria (evolving)

- [ ] 单测：注入 onMetric，触发下单/WS 消息后收到对应 metric（name/value/tags 正确）。
- [ ] 单测：未注入 onMetric 时热路径不构造 tags/不调用（spy 验证零调用）。
- [ ] 单测：onMetric 抛异常不影响主流程。
- [ ] `bun run lint` / `type-check` / `test` 全绿。

## Definition of Done

- 单测覆盖新打点 + 零开销 + 异常隔离
- lint / type-check / test 全绿
- docs/api.md + adapter-contract spec 回写
- minor changeset（公开 API 新增 onMetric）

## Decision (ADR-lite)

**Context**：P2-4 最小可观测性，3 个设计点需拍板。
**Decision**（2026-06-13，与用户逐项确认）：
- Q1 范围：核心（下单 RTT + WS 消息延迟）+ reconnect / buffer-overflow 计数；REST 延迟 / rate-limit block 留后续。
- Q2 签名：位置参数 `onMetric(name, value, type, tags?)`，`MetricType = counter|gauge|timing`；metric name 固定 const 导出。纯同步 callback、非第四条 event stream（热路径高频 + cardinality）。
- Q3 只做 onMetric；logger/logLevel 占位原样保留、留后续。
**Consequences**：minor changeset（`CreateClientOptions.onMetric` + `MetricType` + metric name 常量为公开新增）；onMetric 未注入热路径零开销（null check、不预构造 tags）；RTT 用 monotonic `performance.now()`；callback 异常吞掉不打断主流程。

## Out of Scope (explicit)

- WS 下单（P2-1，不做）、testnet（P2-3，不做）
- REST 延迟打点、rate-limit block 打点（留后续：实现重 + tag 不全 / custom limiter SPI 无法内省）
- `logger`/`logLevel` 实现（占位保留，留后续）
- 完整 metrics 后端集成（Prometheus/StatsD/OTel）——只做钩子，导出由下游桥接
- `client.events.metrics()` 事件流形态（用纯 callback 替代）

## Research References

- [research/observability-context.md](research/observability-context.md) — 预留位 / 注入路径 / 打点候选位置 / 时间数据 / 热路径约束

## Technical Notes

- 热路径零开销参考 P1-B6（market tick ≈2.26 bytes/tick）
- RTT 终点修正：可顺手把 createOrder/cancelOrder 的 adapter `receivedAt` 改到 HTTP 响应后（超出纯 metric，影响语义，待定）
