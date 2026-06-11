# 错误体系统一：orderState 语义与 venue 错误码归一（P1-A3 + P1-C5）

## Goal

让策略层不必写 Binance 专属错误判断：
1. **P1-C5**：`AcexError` 提供小而稳的归一错误原因枚举（`insufficient_balance` / `would_take` / `order_not_found` / `filter_violation` / `rate_limited` / `unknown` …），适配器提供原始码→归一码映射表，原始码继续保留在 `details.venueError`。
2. **P1-A3**：订单命令失败时提供一等的"订单状态未知"语义（`not_placed` vs `unknown`），替代调用方自行理解 `details.transport.kind === "timeout"` 的隐式约定。

来源：`docs/improvement-todo.md` P1-A3（`src/errors.ts:35`）、P1-C5（`src/errors.ts:30`）。

## What I already know

- `AcexError.details` 由 `buildAcexErrorDetails`（`src/errors.ts:77`）构造：解析 `TransportError.rawBody` 中 Binance-style `{code,msg}` 填 `venueError`，transport 元数据已脱敏。
- spec 契约（`.trellis/spec/backend/error-handling.md` §3）：adapter/internal 层只抛 `TransportError` / `Error`，public `AcexError` 归 manager/runtime 包装。→ 归一映射表应由 adapter 导出（纯数据/函数），由包装层或 `buildAcexErrorDetails` 消费，不违反分层。
- 现有先例：`BINANCE_ORDER_NOT_FOUND_CODES = {"-2011","-2013"}`（`private-adapter.ts:186`）已经是一个局部归一映射，可吸收进统一表。
- juplend 是只读 venue（createOrder/cancelOrder 直接 throw），映射表 MVP 只需 Binance；其他 venue 默认归一为 `unknown`。
- order-manager 的包装点：`wrapError`（`order-manager.ts:1024-1037`）与本地校验错误（`:1005`），是注入 `orderState` 的位置。
- transport.kind 取值：`timeout | http | network | rate_limited | parse`。
- Binance 语义参考：HTTP 5xx = 执行状态未知；timeout/发出后网络中断 = 未知；4xx + `{code,msg}` 拒单 = 未落地；429/418 = 请求被限流未处理。
- 需要 minor changeset（新增 public API 字段）；同步更新 `.trellis/spec/backend/error-handling.md` 与 `docs/api.md` §10。

## Assumptions (temporary)

- 归一枚举初版保持小集合，宁缺毋滥；映射不到的全部 `unknown`。
- `orderState` 仅在订单命令类错误（`ORDER_CREATE_FAILED` / `ORDER_CANCEL_FAILED` / `ORDER_CANCEL_ALL_FAILED`）上有意义；其他错误不填。
- 本地校验错误（`ORDER_INPUT_INVALID`）`orderState = "not_placed"`（请求未发出）。

## Open Questions

- [ ] Q3（derivable，实施时定）：映射表注入路径——倾向 adapter SPI 可选方法（与 P1-C1 适配器可插拔方向一致），实现阶段按 order-manager 对 adapter 的可见性确定。

## Decision (ADR-lite)

**Q1 — public API 形态（已定，方案 A）**
- **Context**：归一码与订单落地状态是两个正交维度；timeout 场景没有 venueError 但必须能表达 orderState。
- **Decision**：`details.venueError.reason`（归一枚举）+ `details.orderState?: "not_placed" | "unknown"`（仅订单命令错误填写）+ 导出 helper `isOrderStateUnknown(error)`。
- **Consequences**：新增字段全部 optional，向后兼容；helper 进入根导出，需更新 error-handling spec 的导出约定。

**Q2 — 归一枚举初版成员（已定）**
- **Context**：枚举要小而稳，每个成员都对应策略层可操作的差异化动作；映射不到一律 `unknown`。
- **Decision**：`insufficient_balance | would_take | order_not_found | filter_violation | rate_limited | timestamp_out_of_sync | unknown`。`timestamp_out_of_sync`（-1021）纳入初版，为 P1-B4 时钟自动重校预留触发信号；`invalid_request` 不单列（策略层无差异化动作，归 `unknown`）。
- **Consequences**：后续扩枚举成员是非破坏性 minor；删除/改名是 breaking，故初版从紧。

## Requirements (evolving)

- 归一枚举 `VenueErrorReason = insufficient_balance | would_take | order_not_found | filter_violation | rate_limited | timestamp_out_of_sync | unknown`，Binance 映射表至少覆盖 -2011/-2013/-2018/-2019/-5022/-4131/-1021 与 429/418 限流；-2010 等不确定码按研究结论归 `unknown`（具体码以实现期对照 Binance 官方错误码文档为准，吸收现有 `BINANCE_ORDER_NOT_FOUND_CODES`）。
- `details.venueError.reason`（归一枚举）+ `details.orderState?: "not_placed" | "unknown"` + helper `isOrderStateUnknown(error)`（见 Decision Q1）。
- 原始 `venueError.code/message` 保持透传不变（向后兼容，新增字段全部 optional）。
- timeout / network / 5xx / parse → orderState `unknown`；venue 明确拒单 / 本地校验 / 限流未处理 → `not_placed`。
- 同步更新 error-handling spec 与 docs/api.md；minor changeset。

## Acceptance Criteria (evolving)

- [ ] 单测：-2011、-2013、-2018、-2019、-5022、-4131、限流码（如 -1003 / HTTP 429）映射到预期归一码；-2010 等不确定码与未知码 → `unknown`。
- [ ] 单测：timeout / 网络中断 / 5xx 的订单命令错误 `orderState === "unknown"`；venue 拒单 / 输入校验 `orderState === "not_placed"`。
- [ ] 现有错误字段与消息格式不回归（lint / type-check / test 全绿）。
- [ ] spec 与 docs/api.md 更新，含错误矩阵新列。

## Definition of Done

- `bun run lint` / `bun run type-check` / `bun run test` 全绿
- minor changeset
- error-handling spec 与 docs/api.md 同步

## Out of Scope (explicit)

- 不实现限流主动预算（P1-B3）、时钟自动重校（P1-B4）——仅做错误归一，-1021 归一为对应原因即可。
- 不改 runtime error 事件流的结构。
- 不为 juplend 建映射表（只读 venue）。

## Technical Notes

- 关键文件：`src/errors.ts`、`src/managers/order-manager.ts:1005-1037`、`src/adapters/binance/private-adapter.ts:186,631`、`src/adapters/types.ts`（若走 SPI）、`tests/unit/` 错误相关用例。
- spec 约束：根入口只导出 `AcexError`、`AcexErrorCode`、`AcexError*Details` 类型；新枚举类型需纳入导出约定。
