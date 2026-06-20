# Binance PAPI margin order routing

## Goal

为 Binance 私有交易增加 PAPI margin 交易路由，使同一个 Binance 账户可按 `symbol` 自动区分 PAPI UM 合约交易与 PAPI margin 现货杠杆交易，并让 `CreateOrderInput` 的语义足够明确，避免不同产品线误读彼此的参数。

用户价值：

- 调用方继续通过 `client.order.createOrder()` 下单，不需要暴露 Binance 内部 endpoint 选择。
- `BTC/USDT:USDT` 等 swap symbol 继续走现有 PAPI UM 路径。
- `BTC/USDT` 等 spot symbol 可走 PAPI margin 交易路径。
- margin-only 参数与 UM-only 参数在类型和运行时校验中明确隔离。

## Requirements

- Binance 内部路由必须按 `symbol` 推断产品线：
  - swap symbol（例如 `BTC/USDT:USDT`）走现有 PAPI UM endpoint。
  - spot symbol（例如 `BTC/USDT`）走 PAPI margin endpoint。
  - 推断必须通过 Binance market catalog 的元字段完成，优先使用 `BinanceMarketDefinition.family` / `MarketDefinition.type` / `contract`，不能通过解析 `symbol` 字符串后缀或分隔符来猜产品线。
- PAPI UM 现有行为保持兼容：
  - 下单继续使用 `/papi/v1/um/order`。
  - `reduceOnly`、`positionSide` 迁移到 `CreateOrderInput.um` 参数块，只属于 UM 路由。
  - `setSymbolLeverage()`、risk limit 与 UM 订单能力不因本任务改变语义。
- PAPI margin 第一版订单能力覆盖：
  - `POST /papi/v1/margin/order`
  - `GET /papi/v1/margin/order`
  - `GET /papi/v1/margin/openOrders`
  - `DELETE /papi/v1/margin/order`
  - `DELETE /papi/v1/margin/allOpenOrders`
- `CreateOrderInput` 需要清晰表达产品线参数边界：
  - 产品线专属参数必须按 `um` / `margin` 命名空间建模。
  - 本任务直接迁移现有顶层 `reduceOnly` / `positionSide` 到 `um`，不保留顶层兼容写法。
  - margin 订单可表达 Binance `sideEffectType` 与 `autoRepayAtCancel`。
  - UM-only 参数不能被 margin 路由误用。
  - margin-only 参数不能被 UM 路由误用。
  - 类型设计应尽量让 TypeScript 调用方在编译期得到清晰提示；运行时仍需校验非法组合。
- 下单、查询单笔订单、撤单、按 symbol 全撤应使用同一套 symbol 路由规则。
- 账户级 `fetchOpenOrders()` / `bootstrapOpenOrders()` 无 symbol 入参，应同时拉取 PAPI UM 与 PAPI margin open orders 并合并为统一快照。
- PAPI private stream 应补齐 margin 相关事件能力，不能只覆盖 margin order：
  - `executionReport`：按 spot catalog 映射到统一订单 update / trade 事件。
  - `outboundAccountPosition`：映射 margin spot 余额快照更新。
  - `balanceUpdate`：作为 delta 型补充事件处理，默认不用于常规余额投影或 REST 校准；不得把 delta 当完整余额写入，也不得在已有 `outboundAccountPosition` 主路径时重复应用。
  - `liabilityChange`：按 asset 更新负债快照字段，`l` 是当前 total liability，不是 delta；不得把它累加到本地负债。
  - `openOrderLoss`：当前 public risk model 无专用字段时至少触发 private reconcile / risk refresh，避免静默丢掉风险变化。
  - 已有 `riskLevelChange`、UM `ORDER_TRADE_UPDATE`、UM `ACCOUNT_UPDATE`、UM `ACCOUNT_CONFIG_UPDATE` 行为不能回退。
- margin stream 触发 REST 校准必须合并和节流，不能每个高频事件都发一次 REST：
  - 能通过本地 snapshot 安全应用的事件优先本地应用。
  - `balanceUpdate` 不作为常规 REST 校准触发源；只有确认缺少对应 snapshot 事件或进入异常恢复路径时才进入合并/节流队列。
  - 必须 REST 校准的事件按 account + reason 合并，并设置最小触发间隔。
  - 多个校准请求在同一窗口内只触发一次 reconcile。
- 返回的 `OrderSnapshot` 应继续使用统一 symbol：
  - UM 返回 `BTC/USDT:USDT` 这类 swap symbol。
  - margin 返回 `BTC/USDT` 这类 spot symbol。
- 保持 SDK 现有 decimal 输入/输出约束，不自动纠偏下单精度。
- 更新单元测试和文档，明确 Binance order 命令不再只覆盖 PAPI UM，而是按 symbol 覆盖 PAPI UM 与 PAPI margin。

## Out of Scope

- PAPI margin OCO、条件单、改单。
- 单独借款/还款命令 API（`/papi/v1/marginLoan`、`/papi/v1/repayLoan`）暂不纳入 `createOrder()`。
- 非 Binance venue。
- PAPI CM order。
- 重新设计账户风险、借贷余额或 Portfolio Margin 风控模型。

## Acceptance Criteria

- [ ] `createOrder()` 对 `BTC/USDT:USDT` 仍发送 `/papi/v1/um/order`，且 UM 参数映射保持现有测试通过。
- [ ] `createOrder()` 对 `BTC/USDT` 发送 `/papi/v1/margin/order`，能传递 `sideEffectType` 与 `autoRepayAtCancel`。
- [ ] `CreateOrderInput` 使用 `um` / `margin` 参数块表达产品线专属参数，顶层 `reduceOnly` / `positionSide` 不再属于公共输入。
- [ ] margin 路由不会发送或读取 `um.reduceOnly` / `um.positionSide`。
- [ ] UM 路由不会发送或读取 `margin.sideEffectType` / `margin.autoRepayAtCancel`。
- [ ] `fetchOrder()`、`cancelOrder()`、`cancelAllOrders()` 按 symbol 走 UM 或 margin 对应 endpoint。
- [ ] `fetchOpenOrders()` / `bootstrapOpenOrders()` 合并 UM 与 margin 两套 open order 快照，并保持 snapshot received timestamp 一致。
- [ ] PAPI margin `executionReport` private stream 事件能映射为统一订单 update / trade 事件；UM `ORDER_TRADE_UPDATE` 现有行为不回退。
- [ ] PAPI margin `outboundAccountPosition` 能更新 spot/margin 余额快照。
- [ ] PAPI margin `balanceUpdate` 不会被误当完整余额，也不会在 `outboundAccountPosition` 主路径存在时重复应用或常规触发 REST。
- [ ] PAPI margin `liabilityChange` 能按 asset 覆盖余额借贷/负债 facet，默认不触发 REST；只有衍生字段必须校准且上下文不足时才进入 delayed reconcile。
- [ ] PAPI margin `openOrderLoss` 至少触发 private reconcile / risk refresh，不静默丢弃。
- [ ] margin stream 导致的 REST reconcile 有 per-account 合并/节流保护，高频 `balanceUpdate` / `liabilityChange` 不会一条 WS 对应一次 REST。
- [ ] margin order response 能映射为现有 `OrderSnapshot` / `RawOrderUpdate`，包括 order id、client order id、side、type、status、price、amount、filled、avg fill price 和时间戳等通用字段。
- [ ] 非法参数组合抛 `ORDER_INPUT_INVALID` 或等价的现有输入错误，而不是静默忽略。
- [ ] 单元测试覆盖 UM 兼容路径、margin 新路径、参数隔离、symbol 路由与文档示例。
- [ ] `README.md` / `docs/api.md` 更新能力说明和 `CreateOrderInput` 示例。

## Confirmed Facts

- 当前 Binance 私有适配器固定使用 `BINANCE_PRIVATE_SYMBOL_FAMILY = "usdm"`，所有私有订单命令都通过 USDM catalog 做 symbol 映射。
- 当前 UM 下单 endpoint 是 `/papi/v1/um/order`，参数包含 `reduceOnly` 和 `positionSide`。
- 当前公共 `CreateOrderInput` 只有 `limit` / `market` 两种订单类型，基础字段上直接挂载 `reduceOnly` 与 `positionSide`。
- Binance PAPI margin 新单 endpoint 是 `POST /papi/v1/margin/order`，参数包含 `sideEffectType` 与 `autoRepayAtCancel`。
- Binance PAPI margin private stream 订单更新事件名为 `executionReport`。
- Binance PAPI margin private stream 还包含 `outboundAccountPosition`、`balanceUpdate`、`liabilityChange`、`openOrderLoss` 等账户/风险相关事件。
- Binance market catalog 已有产品线元字段：spot catalog entry 的 `family` 为 `spot`，derivatives entry 的 `family` 为 `usdm` / `coinm`；通用 `MarketDefinition` 也暴露 `type` 与 `contract`。

## Decisions

- `CreateOrderInput` 产品线专属参数使用 `um` / `margin` 命名空间。现有顶层 `reduceOnly` / `positionSide` 直接迁移到 `um`，不做顶层兼容。
- 运行时路由通过 Binance market catalog 精确解析 symbol 到产品线元字段，不做 symbol 字符串 trick 匹配。
