# CCXT public trades 封装调研

## 结论

CCXT 把 public market trades 暴露为统一方法 `fetchTrades(symbol, since, limit, params)`。这个方法不是账户成交历史，账户成交历史对应 `fetchMyTrades`。

Binance 的 CCXT 实现需要特别注意：`binance.fetchTrades` 默认走 aggregate trades，而不是 raw recent/historical trades。要取 raw public trades，需要通过 exchange-specific `params.fetchTradesMethod` 指定具体 endpoint。

## Unified API

官方手册：

- Manual: https://github.com/ccxt/ccxt/wiki/Manual
- `fetchTrades(symbol, since = undefined, limit = undefined, params = {})`

核心语义：

- 返回 public market trades。
- 返回数组按 timestamp 升序，oldest first, most recent last。
- 不传 `since` 时，默认范围由交易所决定。
- `since` 是毫秒时间戳，`limit` 是返回条数。
- 很少有交易所允许一次取完整历史；通常必须分页。
- `params` 用于透传交易所特定参数。
- CCXT 有实验性自动分页:
  - `params.paginate`
  - `paginationCalls`
  - `paginationDirection`
  - `maxEntriesPerRequest`

统一 trade structure 主要字段：

- `info`: 原始响应
- `id`: trade id 字符串
- `timestamp`, `datetime`
- `symbol`
- `order`
- `type`
- `side`
- `takerOrMaker`
- `price`
- `amount`
- `cost`
- `fee`, `fees`

Public trades 常见情况下只有 `timestamp`、`symbol`、`price`、`amount` 等字段可靠；订单 id、手续费、订单类型通常没有。

## Binance 实现重点

参考源码：

- https://github.com/ccxt/ccxt/blob/master/ts/src/binance.ts
- 当前 npm `ccxt` 版本调研时为 `4.5.58`。

`binance.fetchTrades` 的文档注释列出默认和可选方法：

- 默认:
  - Spot: `publicGetAggTrades`
  - USD-M swap: `fapiPublicGetAggTrades`
  - COIN-M future/swap: `dapiPublicGetAggTrades`
  - Option: `eapiPublicGetTrades`
- 可选:
  - Spot raw recent: `publicGetTrades`
  - USD-M raw recent: `fapiPublicGetTrades`
  - COIN-M raw recent: `dapiPublicGetTrades`
  - Spot raw historical: `publicGetHistoricalTrades`
  - USD-M raw historical: `fapiPublicGetHistoricalTrades`
  - COIN-M raw historical: `dapiPublicGetHistoricalTrades`

参数行为：

- `since` 只对 aggregate methods 有意义。CCXT 会把 `since` 写成 `startTime`，并默认补 `endTime = since + 1h`，也可用 `params.until` 覆盖。
- `params.fromId` 可用于 historical/aggregate endpoint，但 raw recent endpoint 不使用。
- `limit` 对合约 historical endpoint 会被 clamp 到 500，对其他 endpoint 通常最大 1000。
- `params.fetchTradesMethod` 或 `params.method` 可覆盖默认 endpoint。

## 可借鉴点

- API 名称上，`fetchTrades` 在行业里通常表示 public market trades；账户成交历史应叫 `fetchMyTrades` 或类似命名。
- 返回按时间升序是合理默认，有利于分页消费。
- 保留原始 `info` 有价值，尤其 Binance 不同产品线字段不一致，例如 spot 的 `quoteQty`，COIN-M 的 `baseQty`，agg trade 的 `f/l` raw trade id 范围。
- 自动分页不应作为 MVP 默认行为。CCXT 也把自动分页标为实验性，并通过 `params.paginate` opt-in。

## 不建议照搬点

- 不建议让 Acex 的 public `fetchTrades` 默认返回 aggregate trades。对 Acex 用户来说，“trades”更容易被理解为逐笔成交；如果默认返回聚合数据，会造成 id 和数量语义误解。
- 不建议把 raw trades 和 agg trades 塞进一个完全同构类型而不暴露 `kind`。两者的 `id` 含义不同，agg trades 还包含 first/last raw trade id。
- 不建议对 Binance raw historical trades 暴露 `since/until` 后静默转成 aggregate trades；这会改变“raw trade”的语义。

## 建议给 Acex 的 API 语义

可选方案：

- `client.market.fetchTrades({ venue, symbol, fromId?, limit? })`
  - 默认 raw public trades。
  - 不传 `fromId` 取 recent raw trades。
  - 传 `fromId` 取 historical raw trades。
- `client.market.fetchAggregateTrades({ venue, symbol, since?, until?, fromId?, limit? })`
  - 明确返回 aggregate trades。
  - 支持 Binance 的时间窗口能力。

如果只做一个方法，也应加显式 mode：

```ts
client.market.fetchTrades({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  mode: "raw" | "aggregate",
  fromId,
  since,
  until,
  limit,
});
```

其中 `mode: "raw"` 不接受 `since/until`，`mode: "aggregate"` 才接受时间范围。
