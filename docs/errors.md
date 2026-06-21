# 错误处理与能力边界

## 错误处理

可预期错误统一抛 `AcexError`：

```ts
import { AcexError, isOrderStateUnknown } from "@imbingox/acex";

try {
  await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000",
    amount: "0.01",
    postOnly: true,
  });
} catch (error) {
  if (error instanceof AcexError) {
    console.log(error.code);
    console.log(error.details?.venueError?.code);
    console.log(error.details?.venueError?.reason);
    console.log(error.details?.orderState);
    console.log(error.details?.transport?.status);
    console.log(isOrderStateUnknown(error));
  }
}
```

`details.venueError` 是读取交易所结构化拒绝原因的首选字段；`details.venueError.reason` 是 SDK 归一后的稳定原因，原始 `code/message` 会继续保留。`details.orderState` 只在订单命令错误中填写：`not_placed` 表示 SDK 判定订单未落地，`unknown` 表示请求可能已经到达交易所，应由调用方后续查询或对账确认。`details.transport` 保存已脱敏的 HTTP / transport 诊断信息；`cause` 保留底层错误链。

归一错误原因：

| `VenueErrorReason` | 典型含义 |
|---|---|
| `insufficient_balance` | 余额或保证金不足 |
| `would_take` | Post Only / maker-only 订单会吃单而被拒 |
| `order_not_found` | 订单不存在、已不在可撤订单簿或超过交易所可查询范围 |
| `filter_violation` | 价格、数量、精度、最小名义金额或订单数量限制不满足 |
| `rate_limited` | 请求权重、订单频率或账户排队被限流 |
| `timestamp_out_of_sync` | 请求时间戳或 `recvWindow` 与交易所时间不匹配 |
| `unknown` | 交易所原始码未归入稳定语义，调用方仍可读取原始 `code/message` |

完整错误码：

| Code | 典型场景 |
|---|---|
| `CLIENT_NOT_STARTED` | 未 start 就调用订阅方法 |
| `VENUE_NOT_SUPPORTED` | venue runtime 未实现，或 read-only venue 被用于下单 |
| `MARKET_CATALOG_LOAD_FAILED` | market catalog 拉取失败 |
| `MARKET_SERVER_TIME_FETCH_FAILED` | server time 请求失败或响应结构不合法 |
| `MARKET_INPUT_INVALID` | market REST 查询输入不合法，例如时间窗口或 limit 无效 |
| `MARKET_PUBLIC_TRADES_FETCH_FAILED` | public trades / raw trades 请求失败、缺少 Binance market API key 或响应结构不合法 |
| `MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED` | 历史 funding rate 请求失败或响应结构不合法 |
| `MARKET_INACTIVE` | catalog 中 market 不活跃 |
| `MARKET_FUNDING_RATE_UNSUPPORTED` | 指定 market 不支持 funding rate |
| `MARKET_NOT_FOUND` | 指定 symbol 不存在 |
| `MARKET_STREAM_TIMEOUT` | market stream 首条消息超时 |
| `ACCOUNT_ALREADY_EXISTS` | 重复注册 accountId |
| `ACCOUNT_BOOTSTRAP_FAILED` | account bootstrap 失败 |
| `ACCOUNT_NOT_FOUND` | accountId 未注册或已移除 |
| `CREDENTIALS_MISSING` | private 订阅或下单缺凭证 |
| `EVENT_BUFFER_OVERFLOW` | 事件流消费者积压超过缓冲上限 |
| `FEE_RATE_FETCH_FAILED` | 单 symbol 手续费费率远端查询失败 |
| `RISK_LIMIT_FETCH_FAILED` | risk limit / leverage bracket 远端查询失败 |
| `RISK_LIMIT_INPUT_INVALID` | risk limit 本地输入校验失败，例如 leverage 不是 1 到 125 的整数 |
| `LEVERAGE_SET_FAILED` | 设置 symbol leverage REST 失败或交易所拒绝 |
| `ORDER_BOOTSTRAP_FAILED` | open orders bootstrap 失败 |
| `ORDER_INPUT_INVALID` | 本地订单输入校验失败 |
| `ORDER_CREATE_FAILED` | 下单 REST 失败或交易所拒单 |
| `ORDER_CANCEL_FAILED` | 撤单失败 |
| `ORDER_CANCEL_ALL_FAILED` | 批量撤单失败 |

## 当前限制

- Deribit 当前只覆盖公开期权 catalog 和 L1 Book
- Juplend 当前只提供借贷账户只读视图，不支持链上写操作
- Binance 订单当前覆盖 PAPI margin / UM 的 `limit`、`market`、撤单和 open orders 主路径
- Funding Rate 仅支持 Binance 永续合约，包括 Binance TradFi Perps
- Binance order 命令按 symbol 路由 PAPI UM 与 PAPI margin；COIN-M、margin OCO、条件单和改单不支持
- Binance fee 真实远端刷新当前只覆盖 `swap`；spot / future 返回默认费率，显式 fetch 抛 `VENUE_NOT_SUPPORTED`
- Binance risk limit 当前只覆盖 PAPI UM leverage bracket / set leverage；不覆盖 spot、COIN-M 或非 UM 交易链路，也不计算下单前剩余名义价值
- `client.riskLimit.getSymbolRiskLimit()` 只读缓存，不保证首次调用已有交易所数据；需要强一致时调用显式 `fetchRiskLimits()` / `fetchSymbolRiskLimit()`
- `cancelAllOrders()` 必须带 `symbol`，不支持账户级全撤
- `createOrder()` 不支持条件单、改单
- SDK 不自动纠偏订单精度；下游应使用 `normalizeOrderInput()`
- Juplend 只读，不支持链上写操作和 `OrderManager`
- `sandbox`、`logger`、`logLevel` 为预留位
