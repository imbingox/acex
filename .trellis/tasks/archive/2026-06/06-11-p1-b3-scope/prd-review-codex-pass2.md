# PRD 二轮复审：P1-B3 限流分层

审查对象：`/workspace/projects/acex/.trellis/tasks/06-11-p1-b3-scope/prd.md`

结论：修订版关闭了大多数首轮问题，特别是 optional registry、semantic plan、host bucket、cancel workflow、transport error 退款和 PR1 fallback。仍有两个会阻塞实现的契约缺口：固定窗口边界/时间戳归属没有落成可执行规则，且 all-or-none admission 要求 reservation 对账，但 SPI 没定义 reservation/timestamp 如何从 `beforeRequest` 传到 `afterResponse` / `onTransportError`。

## Closure Table

| Issue | Status | Note |
|---|---|---|
| B1 | CLOSED | `R5` 和 Technical Approach 已定义 optional `RateLimitTopologyRegistry`、feature-detect 注册、幂等/冲突处理、旧 custom limiter fallback。 |
| B2 | CLOSED | `R6` 明确 planId 是 adapter 语义 id，AC 覆盖 `openOrders` 成本变体和 spot/fapi/dapi/papi host bucket。 |
| B3 | CLOSED | `R7` 明确 server-time 归 fapi bucket 且不改 URL，Out-of-Scope 也排除了改 PAPI time URL。 |
| B4 | PARTIAL | header 降低 rollover 和乱序防覆盖已写入；但 `windowStartMs/windowEndMs` 如何对齐、下一窗口边界如何计算、使用哪个时间戳判定旧窗仍未定义。 |
| B5 | PARTIAL | all-or-none 临界区和 reservation id 要求已写入；但现有 `RateLimiter.beforeRequest()` 返回 `void`，PRD 没定义 reservation token / timestamp 的 SPI 传播方式。 |
| B6 | CLOSED | PR1 中间态已明确：未注册/unknown/旧 limiter 回退 endpoint reactive，已知 topology 做 bucket-level block 和 snapshot，不做主动预扣。 |
| B7 | CLOSED | `R3` 与 Technical Approach 明确整个 cancel workflow 包含 `cancelAllOrders` prefetch 都标 `priority:"cancel"`，并说明 reserve 只保护本进程。 |
| B8 | CLOSED | `R10` 明确默认不退款，仅 `requestNotSent` 的 pre-HTTP 本地失败可退，符合订单 unknown 安全语义。 |
| S1 | CLOSED | bucket `kind/interval` + plan costs 匹配回填已把 header→bucket 映射留在 adapter/topology 边界内。 |
| S2 | CLOSED | PRD 移除了伪 `ip` scope 维度，使用 host/product 编码 bucket id；当前无多 egress/proxy 支持，MVP 可接受。 |
| S3 | CLOSED | `R12` 明确 `ctx.priority ?? plan.priority ?? "normal"`，可覆盖 cancelAll prefetch。 |
| S4 | CLOSED | `R12` 给出 `normalCap = floor(limit×target) − reserve`，cancel/risk 可用 published limit。 |
| S5 | CLOSED | `R11` 新增 public `CreateClientOptions.rateLimit?: { utilizationTarget? }`，并明确 cancel reserve 暂内部默认。 |
| S6 | CLOSED | Observability 段落明确主动 wait 不改 runtime status，429/418 仍走现有 `rate_limited` reason。 |
| S7 | PARTIAL | 已要求 bucket 级 snapshot 能回答剩余/阻塞/reserve/nextAvailableAt；但 `getSnapshot(scope)` 如何查询/返回 bucket 级结构仍未具体化。非阻塞，但实现时应补清类型。 |
| S8 | CLOSED | `R13` 已定义 429 无 `Retry-After` 到下一窗口+jitter、418 缺失时至少 2min 且连续 418 never shorten。 |
| S9 | CLOSED | Decision 与 Out-of-Scope 已说明 MVP 用 SDK `accountId`，UID override 后续。 |
| S10 | CLOSED | AC 已覆盖 custom limiter、topology 注册、成本变体、host bucket、并发 admission、rollover、cancel reserve、timeout/network 不退款。 |

## New Issues

### Blocker N1. Reservation / timestamp 对账契约仍缺失，导致 B4/B5 的修订无法实现为确定行为

PRD 在 `R8` 要求乱序 `afterResponse` 按时间戳防旧窗覆盖新窗，在 `R9` 要求预扣带 reservation id 给 `afterResponse` / `onTransportError` 对账，并在 Technical Approach 写明 `beforeRequest` 返回 reservation（`prd.md:56-57`, `prd.md:100-103`）。但 SPI 形状只定义 per-request 传 `{ scope, planId?, priority? }` 和 optional registry（`prd.md:106-109`）；当前代码里的 `RateLimiter.beforeRequest()` 返回 `void`，`RateLimitResponseContext` / `RateLimitTransportErrorContext` 也没有 reservation id、admittedAt、requestSentAt 或 responseReceivedAt（`src/types/shared.ts:45-81`）。

这会直接影响正确性：旧窗口响应晚到时，limiter 没有可执行的时间戳来源来判断它属于旧窗；`requestNotSent` 退款也没有明确 token 来保证只退本次 all-or-none 预扣。实现者必须猜是扩展 `beforeRequest` 返回值、把 reservation 放进 ctx、还是由 limiter 内部按 scope/plan 推断。PRD 需要明确一个最小 contract，例如 `beforeRequest()` 返回 opaque admission token，adapter 原样传给 `afterResponse` / `onTransportError`；token 至少携带/关联 admittedAt、planId、priority、reserved costs 和窗口版本。

## Consistency / Implementability Check

- optional registration interface、host-encoded bucket ids、priority override rule、cancel reserve、transport error default no-refund、PR1 intermediate state 与 Out-of-Scope 当前一致。
- `server-time` 归 fapi bucket 与“不改 URL”一致，没有再污染 PAPI bucket。
- 仍不一致/不可执行的点是 `R8/R9` 与 SPI 形状之间的断层：PRD 要求时间戳和 reservation 对账，但没有定义类型和 adapter 调用路径。
- 固定窗口还需要明确 `windowStartMs/windowEndMs` 的计算规则。否则 `429` fallback 的“下一窗口边界”以及 header 降低触发的新窗都需要实现者自行选择边界。

Final verdict: NOT READY (blocking items: B4 window boundary/timestamp rules; B5/N1 reservation token SPI contract)
