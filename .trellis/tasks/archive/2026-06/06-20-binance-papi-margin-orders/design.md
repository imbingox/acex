# Binance PAPI margin order routing design

## Scope

本任务在现有 Binance PAPI 私有适配器中增加 margin order 产品线。目标不是新增一个 venue，而是在 `venue: "binance"` 内部按 catalog 解析后的产品线选择 PAPI UM 或 PAPI margin endpoint。

覆盖范围：

- 公共 `CreateOrderInput` 产品线参数重构。
- runtime / manager 到 adapter 的 request 透传。
- Binance PAPI order REST command 路由。
- Binance PAPI private stream 中 margin 订单、余额、负债和风险相关事件映射。
- 相关 rate-limit plan、测试和文档。

不覆盖：

- margin OCO、条件单、改单。
- 独立借款/还款 manager/API。
- PAPI CM 私有订单。
- 账户风险模型重构。

## Public API

### CreateOrderInput

产品线专属参数使用命名空间，公共字段继续保持顶层：

```ts
export type BinanceMarginSideEffectType =
  | "no_side_effect"
  | "margin_buy"
  | "auto_repay"
  | "auto_borrow_repay";

export interface UmOrderOptions {
  reduceOnly?: boolean;
  positionSide?: PositionSide;
}

export interface MarginOrderOptions {
  sideEffectType?: BinanceMarginSideEffectType;
  autoRepayAtCancel?: boolean;
}

type CreateOrderProductOptions =
  | { um?: UmOrderOptions; margin?: never }
  | { margin?: MarginOrderOptions; um?: never }
  | { um?: undefined; margin?: undefined };
```

`CreateLimitOrderInput` / `CreateMarketOrderInput` 与 `CreateOrderProductOptions` 相交。现有顶层 `reduceOnly` / `positionSide` 直接迁移到 `um`，不保留顶层兼容。项目当前是 beta，语义清晰优先于保留旧写法。

`amount` 在本任务中继续表示 base quantity，并映射到 Binance `quantity`。PAPI margin 的 `quoteOrderQty` 暂不加入第一版；后续如要支持，应该显式新增 `quoteAmount` 并与 `amount` 做互斥建模。

### Runtime validation

TypeScript 无法从任意字符串 `symbol` 在编译期推断产品线，因此运行时必须校验：

- catalog 解析为 UM 时，允许 `um`，禁止 `margin`。
- catalog 解析为 margin/spot 时，允许 `margin`，禁止 `um`。
- 同时传 `um` 与 `margin` 属于输入错误。
- `coinm` 或其他 Binance family 在能被 catalog 识别时明确报不支持；未知 symbol 保持 symbol mapping/catalog 错误语义。

非法组合包装为现有 `ORDER_INPUT_INVALID`，不静默忽略。

## Routing

新增内部 route helper，例如：

```ts
type BinancePrivateOrderRoute =
  | { product: "um"; family: "usdm"; venueId: string }
  | { product: "margin"; family: "spot"; venueId: string };
```

helper 行为：

1. 对 `usdm` 与 `spot` 做独立 family lookup，任一 family 精确命中即可确定 route；另一个 family 的加载失败不得阻断已命中的明确 route。
2. lookup 使用 `marketCatalog.getDefinition("usdm", symbol)` 与 `getDefinition("spot", symbol)`，并依据 catalog entry 的 `family` / `type` / `contract` 判断 route。
3. 单 family miss 时按现有 miss-refresh 机制刷新该 family；刷新后命中即可 route。
4. 只有 `usdm` 与 `spot` 都无法确认时，才进入失败路径；失败路径可 best-effort 查询 `coinm` 来把已知 COIN-M symbol 报为 unsupported product line。
5. 如果目标 family catalog 加载失败且没有另一 family 明确命中，抛 `CatalogUnavailableError`；如果所有可用 catalog 都 miss，抛 `SymbolMappingError`。

路由不能使用字符串后缀、分隔符或 `:USDT` 等格式猜测。字符串格式只作为统一 symbol 的外部表示，不能作为产品线真相来源。

## REST endpoints

UM 现有 endpoint 保持：

- `POST /papi/v1/um/order`
- `GET /papi/v1/um/order`
- `GET /papi/v1/um/openOrders`
- `DELETE /papi/v1/um/order`
- `DELETE /papi/v1/um/allOpenOrders`

Margin 新增 endpoint：

- `POST /papi/v1/margin/order`
- `GET /papi/v1/margin/order`
- `GET /papi/v1/margin/openOrders`
- `DELETE /papi/v1/margin/order`
- `DELETE /papi/v1/margin/allOpenOrders`

带 symbol 的命令通过 route helper 单路由。账户级 `fetchOpenOrders()` / `bootstrapOpenOrders()` 没有 symbol 入参，需要并发拉 UM 和 margin open orders，再合并为一个 `RawOpenOrdersSnapshot`。两组结果使用同一个 `snapshotReceivedAt`，避免消费者看到两个不同 bootstrap 时间。

Rate-limit topology 增加 margin endpoint 映射。PAPI margin order 与 UM order 同属 PAPI request/order bucket，但使用独立 plan id 更利于后续调权和观测。

## Mapping

现有 `BinancePapiOpenOrder` 可扩展覆盖 margin response 字段：

- REST margin response 常用字段：`symbol`、`orderId`、`clientOrderId`、`transactTime`、`price`、`origQty`、`executedQty`、`cummulativeQuoteQty`、`status`、`timeInForce`、`type`、`side`、`fills`。
- `mapOpenOrder` 应按 route/family 映射 symbol：
  - UM 用 `family: "usdm"` 映射为 `BTC/USDT:USDT`。
  - margin 用 `family: "spot"` 映射为 `BTC/USDT`。
- `reduceOnly` / `positionSide` 只从 UM response/event 写入。
- margin response 不写入 `reduceOnly` / `positionSide`。
- `avgFillPrice` 对 margin REST 如无明确字段，可保留 undefined；不要用 float 计算平均价。

## Private stream

现有 PAPI private stream 已解析 UM `ORDER_TRADE_UPDATE`、UM `ACCOUNT_UPDATE`、`ACCOUNT_CONFIG_UPDATE`、`riskLevelChange`。引入 PAPI margin 后，private stream 不能只覆盖下单回报；否则订单成交后的余额、负债和风险状态会依赖下一次 REST reconcile 才校准。

### Event coverage

| Event | Action |
| --- | --- |
| `executionReport` | 映射为统一 order update / trade。 |
| `outboundAccountPosition` | 映射为 margin spot 余额快照更新，`free=f`、`used=l`、`total=f+l`。 |
| `balanceUpdate` | 这是 delta 事件，不是完整余额；默认作为补充信号，不参与常规余额投影，也不常规触发 REST。 |
| `liabilityChange` | 映射为按 asset 的负债 snapshot；`l` 是当前 total liability，不做累加。 |
| `openOrderLoss` | 当前 public risk model 没有专用字段；先请求 private reconcile / risk refresh，避免静默丢掉风险变化。 |
| `riskLevelChange` | 沿用现有账户风险告警映射。 |
| UM `ORDER_TRADE_UPDATE` / `ACCOUNT_UPDATE` / `ACCOUNT_CONFIG_UPDATE` | 现有行为保持。 |

margin order stream 事件名为 `executionReport`，需要新增解析与映射：

- `executionReport.s` 通过 spot catalog 映射统一 symbol。
- `i` / `c` 映射 order id / client order id。
- `S` / `o` / `X` 映射 side / type / status。
- `p` / `q` / `z` / `L` / `l` / `n` / `N` / `m` / `T` 映射通用订单与 trade 字段。
- 只有 `x === "TRADE"` 且 `l > 0` 时生成 `RawOrderUpdate.trade`；`t` 映射为 `trade.tradeId`，用于下游去重。
- `n` / `N` 映射手续费；即使 `n === "0"` 也应保留 fee 信息，只要 fee asset 存在。
- margin trade 不产生 `realizedPnl` 和 `positionSide`。

symbol mapping miss 时复用现有 quarantine + catalog refresh 模式，但需要支持 spot family 的 miss 刷新，不能把 margin stream miss 误报为 USDM miss。

### Account projection

PAPI margin WS 没有全账户完整 balance snapshot；完整 bootstrap / reconcile 仍应来自 REST。`outboundAccountPosition` 是发生变化资产的当前 free/locked 快照，不是全量账户余额。它是余额投影主路径，适合直接发增量 `RawAccountUpdate.balances`，但不能触发本地余额全集替换。

`balanceUpdate` 只有 delta，正常情况下不需要用于余额投影：同一类余额变化应以 `outboundAccountPosition` 的 changed-asset snapshot 为准。实现不应把 `balanceUpdate.d` 写成 `free` 或 `total`，也不应在常规路径上用它触发 REST。第一版建议只解析并忽略，或作为异常恢复信号保留：只有在确认缺少对应 `outboundAccountPosition`、本地 snapshot 明显缺口、或未来增加事件相关性判断后，才进入 delayed reconcile queue。

`liabilityChange` 提供 asset、transaction type、principal、interest、total liability。官方示例里 `l` 标注为 `Total Liability`，因此它是当前负债快照值，不是 delta；实现必须直接覆盖该 asset 的负债字段，不能累加。现有 public account 模型已有 `BalanceSnapshot.lending` facet，可复用为 Binance margin liability 投影，但需要允许内部 raw lending update 做部分字段更新：

- `borrowed` 对应 total liability。
- `interest` 对应 liability interest。
- `netAsset` 如有本地 total balance，可由 total balance 减 total liability 得到；否则保留旧值并请求 reconcile。
- `supplied` 没有直接事件字段时保留旧值，不凭空构造。

如果这套映射需要改动 `RawLendingBalanceUpdate` 的 required 字段，应保持 public `LendingBalanceFacet` 输出稳定：最终 snapshot 中仍提供 canonical string，缺失值用 previous 或 `"0"` 补齐。`liabilityChange` 本身不需要常规触发 REST；只有在需要校准 `netAsset` / collateral 之类衍生值且本地上下文不足时，才进入 delayed reconcile。

`openOrderLoss` 会影响账户风险，但当前 `RiskSnapshot` 没有 `openOrderLoss` 字段。本任务第一版不新增风险字段；收到事件后触发 private reconcile / risk refresh。如果后续需要在 public API 暴露 open order loss，应单独设计 `RiskSnapshot` 字段和 REST 校准来源。

### Reconcile callback

当前 `PrivateStreamCallbacks.requestReconcile` 只接受 `"symbol_mapping_miss"`。本任务需要扩展 reason union，例如：

```ts
type PrivateReconcileReason =
  | "symbol_mapping_miss"
  | "margin_balance_delta"
  | "margin_liability_change"
  | "margin_open_order_loss";
```

coordinator 必须按 reason 分类处理：`symbol_mapping_miss`、reconnect 和 bootstrap 相关路径仍走 immediate；`margin_open_order_loss` 和异常恢复用的 `margin_balance_delta` / `margin_liability_change` 进入 delayed reconcile queue。reason 同时用于代码表达和后续观测。

### Reconcile rate control

现有 coordinator 已经有基本合并机制：同一个 account 如果 reconcile in-flight，新的 request 只会把 `privateReconcileDirty` 标记为 true，不会并发启动第二个 REST 对账；in-flight 结束后最多再 drain 一轮。但这只能防并发，不能防止高频 margin 事件在上一轮结束后立刻触发下一轮。

本任务需要为 margin stream reason 增加 per-account 合并/节流策略：

- 能安全本地应用的事件不触发 reconcile：
  - `executionReport` 直接更新订单。
  - `outboundAccountPosition` 直接更新 changed-asset balance。
- 需要 REST 校准的事件进入 delayed reconcile queue，而不是立即逐条请求：
  - `margin_open_order_loss`
- `balanceUpdate` 默认不进 delayed reconcile queue；只有异常恢复路径确认需要校准时才使用 `margin_balance_delta` reason。
- `liabilityChange` 默认本地覆盖负债 snapshot，不进 delayed reconcile queue；只有衍生字段上下文不足且必须校准时才使用 `margin_liability_change` reason。
- delayed queue 以 account 为单位合并原因，建议默认 debounce 1-2s，最小间隔不低于 5s；窗口内多个 reason 只触发一次 reconcile。
- reconnect、symbol mapping miss、用户显式订阅后的 bootstrap 仍可走 immediate path，因为这些影响 ready 状态或 symbol 正确性。
- 如果 periodic private reconcile 已经启用，delayed reconcile 可以复用同一个 dirty/drain 机制，但要避免重置 poll 计时器导致额外周期抖动。

限流依据：当前 Binance PAPI bucket 是 6000 request weight / minute；现有 full private reconcile 至少会读取 `/papi/v1/balance`、`/papi/v1/account`、`/papi/v1/um/positionRisk` 和全账户 open orders，已是较重操作。加入 margin open orders 后更不能用每条 margin WS 事件触发 REST。

## Compatibility

- 这是 beta 包，允许 breaking API cleanup。
- 已有用户需要把：

```ts
{ reduceOnly: true, positionSide: "long" }
```

迁移为：

```ts
{ um: { reduceOnly: true, positionSide: "long" } }
```

- 没有 UM 专属参数的现有下单调用保持形状可用。
- 订单快照结构不新增 margin borrow 字段；本任务只保证通用订单字段。

## Failure behavior

- catalog 加载失败：抛现有 catalog unavailable 语义，order manager 包装为下单/撤单对应错误。
- symbol 命中 `coinm` 或非 spot/usdm：抛不支持订单产品线错误；如果 `coinm` catalog 不可用且 spot/usdm 都 miss，则保留 symbol mapping/catalog 错误语义，不为区分错误类型额外阻断明确的 UM/margin route。
- route 与参数块不匹配：抛 `ORDER_INPUT_INVALID`。
- margin endpoint 交易所拒绝：沿用现有 transport/error wrapping。

## Documentation

文档需要更新：

- Binance 能力表：order 命令按 symbol 覆盖 PAPI UM 与 PAPI margin。
- `CreateOrderInput` 类型示例：分别展示 `um` 与 `margin`。
- 限制说明：`amount` 是 base quantity；`quoteOrderQty`、margin OCO、改单、条件单、显式借还款不在第一版。
