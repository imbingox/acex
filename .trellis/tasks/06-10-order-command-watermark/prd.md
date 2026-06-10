# P0-2 REST ack watermark guard

## Goal

修复订单命令回包与私有 WS 成交事件之间的竞态，防止较旧的 REST 命令 ack 把已成交/已撤销的本地订单回退成 `open` 或把 `filled` 数量回退为 0。该修复应落在 order manager 的状态合并层，后续 WS 下单 ack 也能复用同一套 source/watermark 模型。

## What I Already Know

* `docs/improvement-todo.md` 将该问题列为 P0-2，位置集中在 `src/managers/order-manager.ts` 的 `applyCommandUpdate` / `mergeOrderStatus` 和 `src/internal/watermark.ts`。
* `applyUpdateToRecord` 已经让 stream / REST reconcile 更新经过 `shouldApplyWatermarkedUpdate`，但 `applyCommandUpdate` 当前直接创建并写入 snapshot。
* `src/internal/watermark.ts` 的 `WatermarkApplyOptions.source` 已声明 `"command"`，但实现没有 command 分支。
* P0-1 后，`cancelAllOrders()` 的合成 canceled 更新按 spec 必须携带 `exchangeTs: undefined`，因此 command 源不能只依赖 exchangeTs 比较。

## Requirements

* `createOrder()` / `cancelOrder()` / `cancelAllOrders()` 在发起命令前记录 `requestStartedAt`，并传给命令回包入库路径。
* `applyCommandUpdate` / `applyCommandUpdates` 必须通过 `shouldApplyWatermarkedUpdate`，以 `source: "command"` 参与水位判断。
* command 源应拒绝覆盖在命令请求发出之后才到达的本地更新，尤其是 WS `ORDER_TRADE_UPDATE` 先到、REST ack 后到的场景。
* command 源在 `exchangeTs` 缺失时必须有明确语义：不能靠 exchangeTs 比较，需使用 `requestStartedAt` + `receivedAt` 的本地时钟水位保护。
* `filled` 合并必须单调不回退：若已有 snapshot 的 `filled` 大于 incoming，则保留较大的 `filled`，不再限定于 exchangeTs 相等。
* 状态优先级不得被较低优先级状态回退：已有终态/更高优先级状态不能被较旧或低优先级 incoming 覆盖。
* 不新增 public API，不改 adapter contract，不做 live 访问。

## Acceptance Criteria

* [x] 单测覆盖 `source: "command"`：命令请求开始后已有更新时，缺失 exchangeTs 的命令回包不能覆盖。
* [x] 集成测试构造 `ORDER_TRADE_UPDATE` FILLED 先于 `createOrder` REST NEW ack 到达，断言最终订单保持 `filled` 且 `filled` 数量不回退。
* [x] 上述竞态场景不会发布 `order.filled` 之后的 `order.updated(open)` 回退事件。
* [x] `cancelAllOrders()` 这类 `exchangeTs: undefined` 的 command 更新仍能在没有更新水位冲突时正常入库。
* [x] `bun run lint`、`bun run type-check`、`bun run test` 通过。

## Out Of Scope

* WS 下单实现、WS-API 鉴权、请求响应关联与重连。
* `order-manager.ts` 结构拆分；该 refactor 另起任务，P0-2 保持最小行为修复。
* 新增 public order status 或错误语义。
* live smoke / soak 测试。

## Technical Notes

* 相关规范：`.trellis/spec/backend/order-execution.md`、`.trellis/spec/backend/type-safety.md`、`.trellis/spec/backend/code-organization.md`、`.trellis/spec/backend/quality-guidelines.md`。
* 数据流：Exchange WS/REST -> adapter `RawOrderUpdate` -> `OrderManagerImpl` merge/store -> order event bus。
* 现有测试夹具 `installBinancePrivateAccountInfra({ createOrderDelayMs })` 可稳定制造 REST ack 延迟。
