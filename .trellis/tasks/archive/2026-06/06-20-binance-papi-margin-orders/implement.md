# Binance PAPI margin order routing implementation plan

## Preconditions

- 已确认 `CreateOrderInput` 直接迁移到 `um` / `margin` 命名空间。
- 已确认 Binance 私有订单 route 必须基于 market catalog 元字段，不使用 symbol 字符串格式猜测。
- 实现前按 `trellis-before-dev` 读取相关 spec。

## Checklist

1. Public types
   - 在 `src/types/order.ts` 增加 `BinanceMarginSideEffectType`、`UmOrderOptions`、`MarginOrderOptions`。
   - 将 `CreateOrderInput` 重构为公共字段 + `um` / `margin` 命名空间。
   - 移除顶层 `reduceOnly` / `positionSide`。
   - 在 `src/adapters/types.ts` 同步 `CreateOrderRequest`，避免 runtime 丢失产品线参数。

2. Runtime and manager validation
   - 更新 `src/client/runtime.ts` 的 `createOrder()` request 构造，透传 `um` / `margin`。
   - 更新 `src/managers/order-manager.ts` 的输入校验：
     - 同时传 `um` 与 `margin` 抛 `ORDER_INPUT_INVALID`。
     - 暂不在 manager 层判断 symbol 产品线；产品线匹配由 adapter 基于 catalog 校验。
   - 更新测试替身和类型测试中旧字段用法。

3. Binance route helper
   - 在 `src/adapters/binance/private-adapter.ts` 拆掉订单命令对 `BINANCE_PRIVATE_SYMBOL_FAMILY = "usdm"` 的硬依赖。
   - 保留 account/risk/UM position 相关逻辑使用 USDM catalog。
   - 新增 private order route helper：
     - 对 spot / usdm 做独立 catalog lookup，任一 family 明确命中即可 route，另一 family 加载失败不得阻断已命中的 route。
     - 按 catalog 精确查找 unified symbol，不用 symbol 字符串格式猜产品线。
     - 返回 `product: "um"` 或 `product: "margin"` 与 venue id。
     - 对 miss 做对应 family refresh。
     - spot/usdm 都 miss 后 best-effort 查询 coinm；命中 coinm 时抛 unsupported product line，coinm catalog 不可用时保留 symbol mapping/catalog 错误。

4. REST command routing
   - `createOrder()`：
     - UM route 发送 `/papi/v1/um/order`，读取 `request.um`。
     - margin route 发送 `/papi/v1/margin/order`，读取 `request.margin`，编码 `sideEffectType` 和 `autoRepayAtCancel`。
   - `fetchOrder()` / `cancelOrder()` / `cancelAllOrders()` 按 route 选择 UM 或 margin endpoint。
   - `fetchOpenOrders()` / `bootstrapOpenOrders()` 并发读取 UM 与 margin open orders，合并快照。

5. Mapping
   - 扩展 REST order response interface，支持 margin response 字段。
   - 将 `mapOpenOrder()` 参数化为 `family`，按 `spot` 或 `usdm` 映射统一 symbol。
   - 确保 margin 路由不写 `reduceOnly` / `positionSide`。
   - 复用现有 decimal canonical 输出约束，不用浮点计算派生字段。

6. Account raw update support
   - 评估并扩展 `RawBalanceUpdate`，支持部分 lending/liability 更新。
   - 更新 `AccountManager.createBalance()`：
     - 部分 lending 字段用 previous/default 补齐，保持 public `LendingBalanceFacet` 输出稳定。
     - `balanceUpdate` delta 不进入常规 snapshot 写入路径，不产生错误 snapshot。

7. Private stream
   - 新增 `executionReport` message interface 与 type guard。
   - 新增 margin stream order mapper，按 spot catalog 映射 symbol；只有 `x === "TRADE"` 且 `l > 0` 时生成 trade，`t` 映射 `tradeId`。
   - 新增 `outboundAccountPosition` mapper，映射 changed-asset balance snapshot。
   - 新增 `balanceUpdate` 处理：解析但默认不改余额、不触发 REST；仅异常恢复路径可进入 delayed reconcile。
   - 新增 `liabilityChange` 处理：覆盖 lending/liability snapshot；只有衍生字段必须校准且上下文不足时进入 delayed reconcile。
   - 新增 `openOrderLoss` 处理：触发 private reconcile / risk refresh，当前不新增 public risk 字段。
   - 扩展 `PrivateStreamCallbacks.requestReconcile` reason union；coordinator 按 reason 分类，symbol mapping / reconnect / bootstrap 走 immediate，margin 异常校准 reason 走 delayed queue。
   - 扩展 symbol mapping quarantine，让 miss refresh 能按 family 区分 spot / usdm。
   - 保持 UM `ORDER_TRADE_UPDATE` 行为不变。

8. Reconcile rate control
   - 在 `PrivateSubscriptionCoordinator` 增加 margin reconcile reason 的 per-account delayed queue。
   - 对 `margin_liability_change`、`margin_open_order_loss` 做 debounce + min interval，避免一条 WS 事件一次 REST。
   - `margin_balance_delta` 只用于异常恢复路径，不作为普通 `balanceUpdate` 默认行为。
   - delayed reconcile 最终复用现有 `requestPrivateReconcile()` dirty/drain 机制。
   - 保持 reconnect、symbol mapping miss、bootstrap 这类 ready/correctness 路径 immediate。
   - 添加测试覆盖多条 margin reconcile reason 在窗口内只触发一次 REST 对账。

9. Rate limits
   - 在 `src/adapters/binance/rate-limit-topology.ts` 增加 PAPI margin order/openOrders/cancel plan id。
   - `getBinancePapiRateLimitPlanId()` 映射 margin endpoint。
   - 复用 PAPI request-weight 与 orders bucket，保留 cancel priority。

10. Tests
   - 更新现有 UM 下单测试为 `um` 参数块。
   - 新增 margin `createOrder()` 测试：
     - spot catalog 命中。
     - endpoint 为 `/papi/v1/margin/order`。
     - `sideEffectType` / `autoRepayAtCancel` 编码正确。
     - 不发送 `reduceOnly` / `positionSide`。
   - 新增 route mismatch 测试：
     - spot symbol + `um` 报输入错误。
     - swap symbol + `margin` 报输入错误。
   - 新增 `fetchOrder()` / `cancelOrder()` / `cancelAllOrders()` margin endpoint 测试。
   - 新增 full-account `fetchOpenOrders()` 合并 UM + margin 测试。
   - 新增 `executionReport` stream mapping 测试。
   - 新增 `outboundAccountPosition` 余额 stream mapping 测试。
   - 新增 `balanceUpdate` 解析但不重复应用余额、不常规触发 REST 的测试。
   - 新增 `liabilityChange` lending facet / reconcile 行为测试。
   - 新增 `openOrderLoss` 触发 reconcile 测试。
   - 新增 reconcile debounce / min interval 测试，确认高频 margin 事件不会导致逐条 REST。
   - 更新 type-level examples，确认顶层 `reduceOnly` / `positionSide` 不再可用。

11. Docs
   - 更新 `README.md` Binance 能力说明。
   - 更新 `docs/api.md` 能力表、`CreateOrderInput` 类型、下单示例、限制说明。
   - 更新 private stream 说明，列出 PAPI margin 支持的事件和哪些事件会触发 reconcile。
   - 明确 `amount` 仍是 base quantity，`quoteOrderQty` 暂不支持。

## Validation Commands

按顺序运行：

```bash
bun test tests/unit/binance-private-adapter.test.ts
bun test tests/unit/order-manager-cid.test.ts tests/unit/private-subscription-coordinator.test.ts
bun run type-check
bun run lint
```

如果局部测试通过，再按时间允许运行：

```bash
bun run test:unit
```

## Rollback Points

- 公共类型迁移完成但 adapter 未改完时，`type-check` 会集中暴露所有旧字段引用。
- REST route helper 完成后先跑 Binance private adapter 单测，避免 stream 改动干扰。
- Private stream quarantine 变更风险较高；如出现复杂回归，先保留 REST margin 命令并把 stream 支持拆成后续任务。

## Review Gate

进入实现前确认：

- `prd.md`、`design.md`、`implement.md` 均存在。
- 用户已确认 breaking API cleanup：顶层 `reduceOnly` / `positionSide` 迁移到 `um`。
- 用户已确认 catalog 元字段路由。
