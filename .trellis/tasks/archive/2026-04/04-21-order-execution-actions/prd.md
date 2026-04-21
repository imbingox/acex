# Implement Order Execution Actions

## Goal

在现有 Binance PAPI 私有订单订阅与缓存能力之上，补齐第一版交易命令能力，让 SDK 可以对已注册账户执行下单与撤单，并与现有 order manager 的本地快照/事件模型保持一致。

## What I already know

* 用户确认 account / private order stream / live smoke 已验证通过，下一步要做“下单/撤单等功能”。
* 用户已选择首版范围 `B`：单笔 `createOrder` + 单笔 `cancelOrder` + `cancelAllOrders`。
* 用户已确认 `cancelAllOrders` 首版必须传 `symbol`，不支持账户级全撤。
* 用户已确认 `createOrder` 首版只支持普通单 `LIMIT` / `MARKET`，不纳入条件单。
* 用户已确认交易命令首版返回“规范化结果对象”，不是只返回薄 ack。
* 用户已确认 `cancelOrder` 首版支持 `orderId` / `clientOrderId` 任一标识撤单，但仍要求传 `symbol`。
* 当前仓库的 `order` 领域只覆盖订阅、缓存、状态与事件；没有任何 `createOrder` / `cancelOrder` public API、runtime/context 合同或 adapter 方法。
* 现有 Binance PAPI private adapter 已具备：
  * 签名 REST 请求能力
  * `accountOptions.timestamp` / `recvWindow` 透传
  * open orders bootstrap
  * private user stream 处理
* 当前实现和 live 验证都基于 Binance PAPI + UM only 路径。
* `OrderSnapshot` 已包含 `triggerPrice` / `reduceOnly` / `positionSide` 等字段，说明后续 public command input 可以与现有 snapshot 语义对齐。
* 现有测试基建 `tests/support/client-test-utils.ts` 已具备 fake `fetch` / fake websocket，可扩展到下单撤单 REST mock。

## Assumptions (temporary)

* 第一版命令范围固定为：单笔下单、单笔撤单、批量撤销当前 open orders。
* 第一版仍然保持 Binance PAPI UM only，不在本轮扩展 spot、CM 或其他交易所。
* `cancelAllOrders` 语义固定为“撤销某账户在某个 symbol 下的所有当前 open orders”。
* `createOrder` 语义固定为普通单 `LIMIT` / `MARKET`。
* 交易命令返回值应包含可用于后续跟踪与对账的规范化字段。
* `cancelOrder` 语义固定为 `{ accountId, symbol, orderId? , clientOrderId? }`，其中两种标识至少提供一种。
* 命令执行后，本地订单状态仍以 REST 响应 + 既有 private order stream 更新共同维持一致性。

## Open Questions

* 无

## Requirements (evolving)

* 为 `order` 领域补齐交易命令 public contract。
* 为 runtime / context / adapter 补齐下单撤单执行链路。
* `cancelAllOrders` 输入必须为 `{ accountId, symbol }`。
* `createOrder` 输入只覆盖 `LIMIT` / `MARKET` 必需字段。
* 交易命令返回规范化结果对象，而不是空返回或薄 ack。
* `cancelOrder` 输入必须为 `{ accountId, symbol, orderId? , clientOrderId? }`，并校验两种定位方式至少一项存在。
* 复用现有 Binance PAPI 签名请求与 order snapshot 语义。
* 补充单元测试，覆盖成功、错误、状态同步与输入校验。

## Acceptance Criteria (evolving)

* [ ] SDK 对外可执行 `createOrder`、`cancelOrder`、`cancelAllOrders`。
* [ ] Binance PAPI adapter 能正确发起相应 REST 请求。
* [ ] 交易命令结果与本地 order cache / status 语义一致。
* [ ] `bun run lint`、`bun run type-check`、相关测试通过。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 多交易所统一交易命令差异抽象的完整设计
* 批量单、改单、批量撤单等高级命令
* spot / CM / 其他账户体系扩展
* 条件单（`STOP` / `TAKE_PROFIT` 等）
* 风控、仓位模式、杠杆切换等账户级交易配置

## Converged MVP

* `createOrder`
  * Binance PAPI UM only
  * 仅支持 `LIMIT` / `MARKET`
  * 返回规范化结果对象
* `cancelOrder`
  * 需要 `accountId + symbol`
  * 支持 `orderId` / `clientOrderId` 任一定位
  * 返回规范化结果对象
* `cancelAllOrders`
  * 需要 `accountId + symbol`
  * 不支持账户级全撤
  * 返回规范化结果对象

## Expansion Sweep

### Future Evolution

* 未来可在不推翻首版 contract 的前提下扩展 `STOP` / `TAKE_PROFIT`、`amendOrder`、`cancelAllOrders` 更宽作用域。
* 结果对象应尽量与后续 WS snapshot 字段对齐，减少未来条件单扩展时的重做。

### Related Scenarios

* `createOrder` / `cancelOrder` / `cancelAllOrders` 的输入风格应与现有 `subscribeOrders` / `getOrder` 保持 accountId + symbol + 标识语义一致。
* `cancelOrder` 的双标识规则应与 `getOrder()` 当前的 `orderId` / `clientOrderId` 读取规则一致。

### Failure & Edge Cases

* 未 `start()`、账户未注册、凭证缺失时应直接失败。
* `cancelOrder` 缺少 `orderId` 与 `clientOrderId` 时应本地校验失败。
* REST 成功但 WS 尚未推送时，返回对象与后续 cache 更新之间的语义要保持一致，不制造“已返回成功但本地完全找不到订单”的混乱。
* `cancelAllOrders` 需要明确返回被撤销订单集合为空时的语义。

## Technical Notes

* 已检查文件：
  * `src/types/order.ts`
  * `src/managers/order-manager.ts`
  * `src/client/context.ts`
  * `src/client/runtime.ts`
  * `src/adapters/types.ts`
  * `src/adapters/binance/private-adapter.ts`
  * `src/errors.ts`
  * `tests/support/client-test-utils.ts`
* 已检查历史设计：
  * `.trellis/tasks/archive/2026-04/04-07-design-sdk-public-api/prd.md`
  * `.trellis/tasks/archive/2026-04/04-20-binance-papi-account-order/prd.md`
* 当前历史设计明确把 `placeOrder` / `cancelOrder` / `amendOrder` 排除在前一阶段之外，因此本任务会首次定义相关 public API 与错误模型。
* 已补充检查：
  * `docs/sdk-public-api.md`
* 当前代码和文档已经普遍使用 `orderId` / `clientOrderId` 双标识语义：
  * `getOrder()` 支持通过任一标识查找
  * `OrderSnapshot` 同时保留 `orderId` 与 `clientOrderId`
* 官方文档（2026-04-21 查询）显示 Binance Portfolio Margin 存在：
  * `POST /papi/v1/um/order`
  * `DELETE /papi/v1/um/order`
  * `DELETE /papi/v1/um/allOpenOrders`
* 官方文档当前明确：
  * `DELETE /papi/v1/um/allOpenOrders` 要求 `symbol` 为必填
  * `POST /papi/v1/um/order` 当前普通单类型为 `LIMIT` / `MARKET`
  * `POST /papi/v1/um/order` 支持可选 `newClientOrderId`，未传时由交易所生成
  * `DELETE /papi/v1/um/order` 要求 `symbol`，且 `orderId` / `origClientOrderId` 二选一
