# fix cancelAllOrders PAPI response shape（P0-1）

## Goal

修复 `BinancePrivateAdapter.cancelAllOrders` 把 `DELETE /papi/v1/um/allOpenOrders` 响应当订单数组解析的确定性 bug：真实 PAPI 返回 `{"code": 200, "msg": "..."}` 对象，现网调用必然 `flatMap is not a function` → 假"撤单失败"，而交易所侧已全撤成功（本地状态分歧）。来源：`docs/improvement-todo.md` P0-1（2026-06-10 review，已完成 Binance 官方文档级验证）。

## Requirements

1. `src/adapters/binance/private-adapter.ts` 的 `cancelAllOrders`：
   - 流程改为：① `GET /papi/v1/um/openOrders?symbol=X`（带 symbol 参数，低 weight，SAFE_READ_RETRY_POLICY）拿到待撤订单快照 → ② `DELETE /papi/v1/um/allOpenOrders?symbol=X`（NO_RETRY_POLICY）按 `{code,msg}` 对象解析 → ③ 把 ① 的订单映射为 `status: "canceled"` 的 `RawOrderUpdate[]` 返回（receivedAt = ② 完成时刻；exchangeTs 不伪造，置 undefined）。
   - DELETE 响应校验：HTTP 非 2xx 已由 http-client 抛 TransportError；body 存在 `code` 字段且不为 200/"200" 时按失败处理（抛带 venueError 的错误）。
   - 公开契约 `cancelAllOrders(input): Promise<OrderSnapshot[]>` 与 SPI `Promise<RawOrderUpdate[]>` 均不变（`.trellis/spec/backend/order-execution.md` 约束）。
2. 测试夹具 `tests/support/exchanges/binance.ts`：`DELETE /papi/v1/um/allOpenOrders` 改为返回 `{"code": 200, "msg": "..."}`；新增/调整 `GET /papi/v1/um/openOrders`（带 symbol query）支撑预取；现有 `options.cancelAllOrders` 夹具语义改为"预取阶段返回的 open orders 列表"。
3. `tests/integration/order.test.ts`：现有 cancelAllOrders 用例改为对象响应路径；新增用例：a) DELETE 返回 `{code,msg}` 时返回的 snapshots 全部 `canceled` 且只含目标 symbol；b) DELETE 失败（-2011 等）时抛 `ORDER_CANCEL_ALL_FAILED` 且带 venueError。
4. `scripts/live-order-smoke.ts`：增加 `--cancel-all` 可选步骤（挂 2 笔远离盘口 GTX 单 → `cancelAllOrders` → 断言 `getOpenOrders` 为空），默认不启用，soak 不强制。
5. changeset：patch（用户可见 bug fix）。

## Acceptance Criteria

- [ ] 适配器按 `{code,msg}` 解析，返回合成的 canceled `RawOrderUpdate[]`，单测/集成测试覆盖成功与失败路径。
- [ ] 夹具响应形状与 Binance 官方文档一致（对象，非数组）。
- [ ] `bun run lint` / `bun run type-check` / `bun run test` 全绿。
- [ ] live smoke 提供 `--cancel-all` 步骤（本任务不要求实际跑 live）。
- [ ] 有 patch changeset。
- [ ] `docs/improvement-todo.md` P0-1 条目：checkbox 保持未勾选，状态行更新为「代码已修复（→ 本任务目录），待 live 复核后勾选」。

## Definition of Done

- 实现 + 测试 + changeset + todo 勾选，CI 三件套绿；live 复核由持 key 的人后续执行（附录 A 步骤）。

## Decision (ADR-lite)

**Context**: 适配器是无状态的，DELETE 响应不含被撤订单列表，但 SPI 契约要求返回 `RawOrderUpdate[]`。
**Decision**: 采用"预取 openOrders(symbol) → DELETE → 标记 canceled"合成方案；不改 SPI、不从本地缓存取（适配器不依赖 manager 状态）。
**Consequences**: ①、② 之间成交的订单会被短暂误标 canceled——由 WS `ORDER_TRADE_UPDATE` 真实终态事件与 60s reconcile 纠正（P0-2 watermark 接入后彻底闭环）；多一次 GET 的 weight 成本可接受（带 symbol 参数 weight 低）。

## Out of Scope

- P0-2（applyCommandUpdate watermark）与 P0-3（listenKey）。
- 真实 live 验证的执行（步骤已在 docs/improvement-todo.md 附录 A）。

## Technical Notes

- 现状代码：`private-adapter.ts:857-878`（错误的数组假设）；`signedRequest` 泛型按调用方指定。
- 官方响应示例：`{"code": 200, "msg": "The operation of cancel all open order is done."}`（Portfolio Margin → Cancel All UM Open Orders）。
- 夹具现状：`tests/support/exchanges/binance.ts:632-644` 按数组 mock（review 已定位）。
- 相关测试：`tests/integration/order.test.ts:1393`（scopes by symbol 用例）、`:2364`（venue error 用例）。
- 分支：`fix/cancel-all-response-shape`，base `main`。
