# Binance PAPI UM / USD-M Futures 错误码归一研究

研究日期：2026-06-11

适用范围：acex SDK 当前走 `https://papi.binance.com` 的 Portfolio Margin PAPI UM 接口，核心下单/撤单端点是 `POST /papi/v1/um/order` 与 `DELETE /papi/v1/um/order`。Binance PAPI common definitions 明确 `UM` 为 USD-M Futures，且 `GTX` 为 `Good Till Crossing (Post Only)`。

官方来源：

- Portfolio Margin Error Code: https://developers.binance.com/docs/derivatives/portfolio-margin/error-code
- Portfolio Margin New UM Order: https://developers.binance.com/docs/derivatives/portfolio-margin/trade/New-UM-Order
- Portfolio Margin Cancel UM Order: https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Cancel-UM-Order
- Portfolio Margin Common Definition: https://developers.binance.com/docs/derivatives/portfolio-margin/common-definition
- Portfolio Margin General Info: https://developers.binance.com/docs/derivatives/portfolio-margin/general-info
- USDⓈ-M Futures Error Code: https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

结论摘要：

- PAPI/UM 下单余额/保证金不足应优先用 `-2018 BALANCE_NOT_SUFFICIENT` 与 `-2019 MARGIN_NOT_SUFFICIEN` 归一到 `insufficient_balance`；不要把 Spot 常见的 `-2010 NEW_ORDER_REJECTED` 直接当作余额不足。
- `-5022 GTX_ORDER_REJECT` 是 Post Only/GTX 不能作为 maker 成交时的拒单，建议归一到 `would_take`。
- `-4131 PERCENT_PRICE`、价格/数量/精度/min notional 类明确过滤约束建议归一到 `filter_violation`。
- `-2011` 在 PAPI 文案中是泛化 cancel reject，但 USD-M 官方补充了 open order not found 语义；对撤单链路建议归一到 `order_not_found`。

## 建议纳入映射

### -1003 TOO_MANY_REQUESTS

官方文案原文：

> Too many requests queued. Too much request weight used; current limit is %s request weight per %s. Please use WebSocket Streams for live updates to avoid polling the API.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`rate_limited`

说明：这是 Binance JSON error code 层面的限流/权重超限。HTTP 429/418 也应在 transport/status 层归一到 `rate_limited`，但它们不是 `code` 字段。

### -1021 INVALID_TIMESTAMP

官方文案原文：

> Timestamp for this request is outside of the recvWindow. Timestamp for this request was 1000ms ahead of the server's time.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`timestamp_out_of_sync`

说明：覆盖本地时间与服务端时间偏移、`recvWindow` 过期两类时间同步问题。

### -2011 CANCEL_REJECTED

官方文案原文：

> CANCEL_REJECTED

USD-M Futures 官方补充原文：

> Cancel request failure as open order not found in orderbook: "Unknown order sent."

来源 URL：

- https://developers.binance.com/docs/derivatives/portfolio-margin/error-code
- https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`order_not_found`

说明：对 PAPI UM 撤单链路，`-2011` 建议按“待撤订单不存在/已不在 order book”处理。若未来在非撤单上下文遇到同码但 message 非 unknown-order，应保留按 message/上下文降级为 `unknown` 的空间。

### -2013 NO_SUCH_ORDER

官方文案原文：

> Order does not exist.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`order_not_found`

说明：语义直接明确，适用于查询、撤单或撤单后补查时的不存在结果。

### -2018 BALANCE_NOT_SUFFICIENT

官方文案原文：

> Balance is insufficient.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`insufficient_balance`

说明：UM/PAPI 官方将余额不足作为独立码列出。

### -2019 MARGIN_NOT_SUFFICIEN

官方文案原文：

> Margin is insufficient.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`insufficient_balance`

说明：官方 code title 拼写为 `MARGIN_NOT_SUFFICIEN`。归一枚举不需要区分 wallet balance 与 margin balance，策略层动作一致。

### -4131 MARKET_ORDER_REJECT

官方文案原文：

> The counterparty's best price does not meet the PERCENT_PRICE filter limit.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`filter_violation`

说明：官方语义明确指向 `PERCENT_PRICE` 过滤器；不是余额不足，也不是撮合状态未知。

### -5022 GTX_ORDER_REJECT

官方文案原文：

> Due to the order could not be executed as maker, the Post Only order will be rejected.

来源 URL：

- https://developers.binance.com/docs/derivatives/portfolio-margin/error-code
- https://developers.binance.com/docs/derivatives/portfolio-margin/common-definition
- https://developers.binance.com/docs/derivatives/portfolio-margin/trade/New-UM-Order

建议归一映射：`would_take`

说明：PAPI common definitions 将 `GTX` 定义为 Post Only，PAPI New UM Order 支持 `timeInForce`。因此该码适用于 PAPI UM 下单链路中的 Post Only/GTX 拒单，语义就是“会吃单，无法作为 maker 挂出”。

## 官方页补充的明确码

### -1008 Request Throttled

官方文案原文：

> Request throttled by system-level protection. Reduce-only/close-position orders are exempt.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`rate_limited`

说明：这是系统级 throttling/overload 保护，不是账户权重配额；但对 SDK 调用方的可操作语义仍是退避重试，归入 `rate_limited`。

### -1015 TOO_MANY_ORDERS

官方文案原文：

> Too many new orders; current limit is %s orders per %s.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`rate_limited`

说明：下单频率/订单数限流，适合归到 `rate_limited`。

### HTTP 429 / HTTP 418

官方文案原文：

> HTTP 429 return code is used when breaking a request rate limit. HTTP 418 return code is used when an IP has been auto-banned for continuing to send requests after receiving 429 codes.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/general-info

建议归一映射：`rate_limited`

说明：这不是 Binance JSON `code`，而是 HTTP status。实现时应由 transport status 或 `TransportError.kind === "rate_limited"` 映射。

### -5028 ME_RECVWINDOW_REJECT

官方文案原文：

> Timestamp for this request is outside of the ME recvWindow.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`timestamp_out_of_sync`

说明：与 `-1021` 同属时间戳/recvWindow 问题，只是由 matching engine 层拒绝。

### -2025 MAX_OPEN_ORDER_EXCEEDED

官方文案原文：

> Reach max open order limit.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：属于交易规则/订单数量上限约束，策略层通常应修改下单行为或先撤旧单。

### -1111 BAD_PRECISION

官方文案原文：

> Precision is over the maximum defined for this asset.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：精度超出交易对/资产规则，适合归入过滤约束。

### -4002 PRICE_GREATER_THAN_MAX_PRICE

官方文案原文：

> Price greater than max price.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确价格上限过滤。

### -4004 QTY_LESS_THAN_MIN_QTY

官方文案原文：

> Qty less than min qty.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确数量下限过滤。

### -4005 QTY_GREATER_THAN_MAX_QTY

官方文案原文：

> Qty greater than max qty.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确数量上限过滤。

### -4013 PRICE_LESS_THAN_MIN_PRICE

官方文案原文：

> Price less than min price.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确价格下限过滤。

### -4014 PRICE_NOT_INCREASED_BY_TICK_SIZE

官方文案原文：

> Price not increased by tick size.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确 tick size 过滤。

### -4016 PRICE_HIGHTER_THAN_MULTIPLIER_UP

官方文案原文：

> Price is higher than mark price multiplier cap.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：官方拼写为 `HIGHTER`。这是 mark price multiplier 上限过滤。

### -4023 QTY_NOT_INCREASED_BY_STEP_SIZE

官方文案原文：

> Qty not increased by step size.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确 step size 过滤。

### -4024 PRICE_LOWER_THAN_MULTIPLIER_DOWN

官方文案原文：

> Price is lower than mark price multiplier floor.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确 mark price multiplier 下限过滤。

### -4029 INVALID_TICK_SIZE_PRECISION

官方文案原文：

> Tick size precision is invalid.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：tick size 精度规则失败。

### -4030 INVALID_STEP_SIZE_PRECISION

官方文案原文：

> Step size precision is invalid.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：step size 精度规则失败。

### -4164 MIN_NOTIONAL

官方文案原文：

> Order's notional must be no smaller than 5.0.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确 min notional 过滤。官方示例值为 `5.0`，实现不要把该值硬编码为所有交易对规则。

### -4183 PRICE_HIGHTER_THAN_STOP_MULTIPLIER_UP

官方文案原文：

> Price is higher than stop price multiplier cap.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：官方拼写为 `HIGHTER`。这是 stop price multiplier 上限过滤。

### -4184 PRICE_LOWER_THAN_STOP_MULTIPLIER_DOWN

官方文案原文：

> Price is lower than stop price multiplier floor.

来源 URL：https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code

建议归一映射：`filter_violation`

说明：明确 stop price multiplier 下限过滤。

### -5041 TOO_MANY_REQUESTS_IN_QUEUE（仅 PAPI 语义）

官方文案原文：

> Time out for too many requests from this account queueing at the same time.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`rate_limited`

说明：PAPI Portfolio Margin 页面中 `-5041` 是账户请求排队过多；但 USD-M Futures 页面同码为 `BBO_ORDER_REJECT`，语义不同。acex 当前走 PAPI UM，可在 PAPI venue map 中收录；不要把该码无条件复用于 fapi/USD-M map。

## 不确定或不建议按 code-only 收录的码

### -2010 NEW_ORDER_REJECTED

官方文案原文：

> NEW_ORDER_REJECTED

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`unknown`

不确定原因：PAPI/UM 官方 Error Code 页面没有把 `-2010` 描述为余额不足；余额/保证金不足在 UM/PAPI 页面分别有 `-2018` 与 `-2019`。因此不建议沿用 Spot 经验把 `-2010` code-only 映射到 `insufficient_balance`。后续如果要细分 `-2010`，应基于实际 `msg` 样本做 message-level 映射。

### -2020 UNABLE_TO_FILL

官方文案原文：

> Unable to fill.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`unknown`

不确定原因：该码表示不能成交，但不是 Post Only “would take” 语义，也不等价于 filter violation。当前枚举没有精确成员。

### -2021 ORDER_WOULD_IMMEDIATELY_TRIGGER

官方文案原文：

> Order would immediately trigger.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`unknown`

不确定原因：这是条件单触发条件不合法/会立即触发，不是 Post Only 会吃单的 `would_take`。可考虑未来新增更细枚举或按调用场景归入输入校验，但本轮不建议混入 `would_take`。

### -5021 FOK_ORDER_REJECT

官方文案原文：

> Due to the order could not be filled immediately, the FOK order has been rejected.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`unknown`

不确定原因：FOK 不能立即完全成交与 Post Only 会吃单是相反方向的执行约束；不应归入 `would_take`。

### -4118 REDUCE_ONLY_MARGIN_CHECK_FAILED

官方文案原文：

> ReduceOnly Order Failed. Please check your existing position and open orders.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`unknown`

不确定原因：官方说明还提到同时存在仓位和 open reduce-only orders 时可能因“insufficient margin”失败，但主语义是 reduce-only 订单冲突/仓位约束，不应简单归入 `insufficient_balance`。

### -51113 EXCEED_PRICE_LIMIT

官方文案原文：

> This order will break the price limit rule of this margin trading pair, please place your order between %s and %s.

来源 URL：https://developers.binance.com/docs/derivatives/portfolio-margin/error-code

建议归一映射：`unknown`

不确定原因：文案明确是 margin trading pair，不是 PAPI UM futures order。虽然语义像价格过滤，但本研究目标是 PAPI UM 下单/撤单链路，暂不收入 UM 映射。
