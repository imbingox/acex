# 订单生命周期收尾：幽灵 open 订单驱逐与 pending claim TTL（P1-A1 + P1-A2）

## Goal

修复两个"订单生命周期没有最终出口"的正确性缺口：
1. **P1-A1**：reconcile 发现"本地 open 但交易所快照缺失"的订单走 `fetchOrder` backfill；若交易所已查不到（-2011/-2013 → `undefined`），订单永远留在 open 表，每 60s 重复报错。需要强制终态化驱逐路径。
2. **P1-A2**：`createOrder` 超时保留 pending claim（等 WS 认领）是对的，但订单实际未到达交易所时，claim 在 `pendingClientOrderIdIndex` 永久泄漏。需要 TTL + 回查清理。

来源：`docs/improvement-todo.md` P1 批次②。

## What I already know

### P1-A1 现状

- 链路：coordinator reconcile → `onPrivateOrderReconcile` 返回 disappeared 列表 → `backfillDisappearedOrders`（并发 worker）→ `backfillDisappearedOrder`（`private-subscription-coordinator.ts:1012`）→ `adapter.fetchOrder`。
- `fetchOrder` 返回 `undefined`（Binance -2011/-2013，`isBinanceOrderNotFound`）时只走 `handleOrderReconcileError`（`:1058-1066`：publishRuntimeError + 标 degraded），订单不离开 open 表 → 每轮 reconcile 重复。
- `OrderStatus = "open" | ... | "filled" | "canceled" | "rejected" | "expired"`（`types/order.ts:31`），已有 `expired` 终态。
- 驱逐需经 order-manager（open→closed 移表 + 发布事件）；coordinator 只能通过 `orderConsumer`（`PrivateOrderDataConsumer`）接口驱动。

### P1-A2 现状

- `createOrder` 失败时仅 `transport.kind === "timeout"` 保留 claim（`shouldRetainPendingClaimAfterCreateError`，`order-manager.ts:891`）。
- `PendingOrderClaim = { localOrderId, symbol }`（`order/model.ts:29`），**无时间戳**；`pendingClientOrderIdIndex: Map<venueClientOrderId, PendingOrderClaim>`。
- claim 的自然解除路径：WS 更新按 clientOrderId 认领（`order-manager.ts:691`）、reconcile bootstrap 快照认领（订单落地且仍 open 时）。订单"落地后很快终态"或"根本没落地"两种情况 claim 都不会被认领 → 泄漏。
- order-manager 无定时器基础设施，也无 fetchOrder 通道；fetchOrder 在 adapter 上，由 coordinator 调用（批次①先例：跨层能力经 `ClientContext` 一等方法注入）。

## Assumptions (temporary)

- A1 驱逐只对"确认查不到"（fetchOrder 返回 `undefined`）计数；transport 错误（网络/超时）不计数，维持现有 degraded 行为——网络故障不能当"订单消失"。
- A2 claim 回查复用 reconcile 周期驱动（不新增独立定时器），TTL 到期后由 coordinator 用 `fetchOrder(clientOrderId)` 确认一次。
- 连续失败阈值 N=3（todo 建议），TTL 默认值待定（候选：60-120s，至少跨一个 reconcile 周期）。

## Open Questions

（已全部收敛）

## Decision (ADR-lite)

**Q1 — 幽灵订单驱逐终态（已定，方案 A）**
- **Context**：驱逐时只知道"交易所查不到"，不知道实际终态（可能已 FILLED、资金已变动）；复用 `expired` 会伪装成交易所一等语义，误导策略对 filled 的判断。
- **Decision**：`OrderStatus` 新增 `"unknown"` 终态成员；驱逐订单标 `unknown` 移入 closed，发布终态事件 + 一次明确 runtime error。与批次①的 `details.orderState: "unknown"` 语义哲学一致。
- **Consequences**：公开枚举扩成员 → minor changeset；下游穷举 switch 需适配；同步更新 order-execution spec、docs/api.md 的 OrderStatus 文档与状态机说明。

**Q2 — 驱逐计数语义与默认值（已定）**
- **Context**：断网一分钟不应把一批好订单驱逐成 `unknown`；网络故障 ≠ 订单消失。
- **Decision**：仅"确认不存在"（`fetchOrder` 返回 `undefined`，交易所明确 -2011/-2013）累加计数；transport 错误不计数（保持 degraded 上报）。订单在 reconcile 快照重现或收到 WS 更新 → 计数清零。默认：驱逐阈值 N=3（连续三轮），claim TTL=90s；经 client `order: {...}` options 可配置。
- **Consequences**：需要 per-order 失败计数的存储位置（驱逐状态机在 order-manager 或 coordinator，实施时按数据归属定）；纯网络故障下幽灵单仍会留存（接受，等网络恢复后下一轮处理）。

**Q3 — claim TTL 驱动机制（已定）**
- **Decision**:挂在现有 reconcile 周期上由 coordinator 驱动，不新增独立 timer；到期 claim 由 coordinator `fetchOrder(clientOrderId)` 回查一次。跨层通道遵循批次①先例：经 Consumer/Context 一等接口方法，不做 cast。

## Requirements (evolving)

- A1：同一订单连续 N=3 次 backfill"确认不存在"（fetchOrder 返回 undefined）后强制终态化为 `unknown` 移入 closed，发布一次明确 runtime error + 终态订单事件；transport 错误不计数；订单在 reconcile 快照重现或收到 WS 更新时计数清零。
- A1：`OrderStatus` 新增 `"unknown"` 终态成员（minor changeset），同步 order-execution spec 与 docs/api.md。
- A2：`PendingOrderClaim` 增加创建时间戳；TTL=90s 到期的 claim 由 reconcile 周期触发 `fetchOrder(clientOrderId)` 回查——查得到则入库（含已终态场景），查不到则清理 claim 并发布一次 runtime error；回查失败（transport 错误）保留 claim 等下轮。
- 阈值 N 与 TTL 经 client `order: {...}` options 可配置，默认 N=3 / TTL=90s。
- 跨层通道经 Consumer/Context 一等接口方法，不做 cast。

## Acceptance Criteria (evolving)

- [ ] 集成测试：模拟 fetchOrder 持续返回 not-found（-2013），断言 N 轮 reconcile 后订单离开 `getOpenOrders()`、出现在 closed 表、收到一次终态事件与 runtime error。
- [ ] 集成测试：backfill 网络错误（非 not-found）不触发驱逐，订单保持 open。
- [ ] 单测：claim 超时 + 订单不存在 → claim 清理；claim 超时 + 订单实际已成交 → 订单入库且事件正确。
- [ ] `bun run lint` / `bun run type-check` / `bun run test` 全绿。

## Definition of Done

- 上述 AC 全部满足
- 需要时 changeset（视公开 API 是否变化定 patch/minor）
- 相关 spec（order-execution.md 等）与 docs 同步

## Out of Scope (explicit)

- 不做 reconcile 周期本身的可配置化重构（沿用现有 interval 配置）。
- 不引入通用任务调度器/定时器框架。
- 不处理 cancelOrder/cancelAllOrders 的 claim（它们不产生 pending claim）。

## Technical Notes

- 关键文件：`src/client/private-subscription-coordinator.ts:927-1110`（reconcile/backfill）、`src/managers/order-manager.ts:200-260,672,858-898`（claim 生命周期）、`src/managers/order/model.ts`（OrderRecord/PendingOrderClaim）、`src/types/order.ts:31`（OrderStatus）、`src/client/context.ts`（PrivateOrderDataConsumer 接口扩展点）。
- 批次①先例：跨层能力用 ClientContext/Consumer 接口一等方法，不做 cast。
- 测试参考：`tests/integration/order.test.ts`（reconcile 场景已有夹具）、`tests/support/exchanges/binance.ts`。
