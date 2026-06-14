# Binance public trades 调研

## 结论

Binance 的 public market trades 不是一个单一接口，至少要分三种语义：

- recent raw trades: 最近逐笔市场成交，按真实 trade id 返回。
- historical/old raw trades: 旧的逐笔市场成交，只支持 `fromId` 翻页，不支持按时间范围查询。
- aggregate trades: 聚合成交，支持 `fromId` 或 `startTime`/`endTime`，但 trade id 是 aggregate trade id，不等同于真实逐笔 trade id。

如果 Acex 要做 `fetch history trades`，建议默认语义用 raw market trades，并通过参数显式选择 `recent`/`historical` 或自动根据 `fromId` 走 old lookup。Aggregate trades 应作为单独模式或单独方法，避免把聚合数据误当逐笔成交。

## Spot

官方文档：

- Market Data endpoints: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
- GitHub markdown: https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/rest-api.md
- Market-data-only base: Spot 文档建议 public market data 可使用 `https://data-api.binance.vision`。

### Recent raw trades

- Endpoint: `GET /api/v3/trades`
- Weight: 25
- 参数:
  - `symbol` 必填
  - `limit` 可选，默认 500，最大 1000
- Data Source: Memory
- 响应字段:
  - `id`, `price`, `qty`, `quoteQty`, `time`, `isBuyerMaker`, `isBestMatch`

### Historical raw trades

- Endpoint: `GET /api/v3/historicalTrades`
- Weight: 25
- 参数:
  - `symbol` 必填
  - `limit` 可选，默认 500，最大 1000
  - `fromId` 可选，按真实 trade id 从该 id 开始返回；不传则返回最近成交
- Data Source: Database
- 响应字段与 recent raw trades 基本一致。
- 关键限制: 不支持 `startTime`/`endTime`。按时间拉历史逐笔成交不能直接走这个接口，只能基于 id 翻页或改用 aggregate trades。

### Aggregate trades

- Endpoint: `GET /api/v3/aggTrades`
- Weight: 4
- 参数:
  - `symbol` 必填
  - `fromId` 可选，按 aggregate trade id inclusive
  - `startTime` 可选，毫秒时间戳 inclusive
  - `endTime` 可选，毫秒时间戳 inclusive
  - `limit` 可选，默认 500，最大 1000
- Data Source: Database
- 响应字段:
  - `a` aggregate trade id
  - `p` price
  - `q` quantity
  - `f` first raw trade id
  - `l` last raw trade id
  - `T` timestamp
  - `m` buyer is maker
  - `M` best price match
- 关键语义: 同一 taker order、相同价格、同一时刻成交会聚合数量；`a` 不是 raw trade id。

## USD-M Futures

官方文档：

- Recent: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Recent-Trades-List
- Old: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Old-Trades-Lookup
- Aggregate: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Compressed-Aggregate-Trades-List

### Recent raw trades

- Endpoint: `GET /fapi/v1/trades`
- Weight: 5
- 参数:
  - `symbol` 必填
  - `limit` 可选，默认 500，最大 1000
- 响应字段:
  - `id`, `price`, `qty`, `quoteQty`, `time`, `isBuyerMaker`, `isRPITrade`
- 说明: 只返回 order book 中撮合的 market trades，不返回 insurance fund trades 和 ADL trades。

### Historical raw trades

- Endpoint: `GET /fapi/v1/historicalTrades`
- Weight: 20
- 参数:
  - `symbol` 必填
  - `limit` 可选，默认 100，最大 500
  - `fromId` 可选，按真实 trade id 从该 id 开始返回；不传则返回最近成交
- 响应字段与 recent raw trades 基本一致。
- 关键限制: 不支持时间范围，只能按 `fromId` 翻页。

### Aggregate trades

- Endpoint: `GET /fapi/v1/aggTrades`
- Weight: 20
- 参数:
  - `symbol` 必填
  - `fromId` 可选，按 aggregate trade id inclusive
  - `startTime` 可选，毫秒时间戳 inclusive
  - `endTime` 可选，毫秒时间戳 inclusive
  - `limit` 可选，默认 500，最大 1000
- 关键限制:
  - 只支持不早于最近 24 小时的 futures trade history。
  - 同时发送 `startTime` 和 `endTime` 时，窗口必须小于 1 小时。
  - 不发送 `fromId`、`startTime`、`endTime` 时返回最近 aggregate trades。
  - 文档提示不要同时发送 `fromId` 和时间范围，否则可能 timeout。
  - 只聚合 order book market trades，不聚合 insurance fund/ADL trades。

## COIN-M Futures

官方文档：

- Recent: https://developers.binance.com/docs/derivatives/coin-margined-futures/market-data/rest-api/Recent-Trades-List
- Old: https://developers.binance.com/docs/derivatives/coin-margined-futures/market-data/rest-api/Old-Trades-Lookup
- Aggregate: https://developers.binance.com/docs/derivatives/coin-margined-futures/market-data/rest-api/Compressed-Aggregate-Trades-List

### Recent raw trades

- Endpoint: `GET /dapi/v1/trades`
- Weight: 5
- 参数:
  - `symbol` 必填
  - `limit` 可选，默认 500，最大 1000
- 响应字段:
  - `id`, `price`, `qty`, `baseQty`, `time`, `isBuyerMaker`

### Historical raw trades

- Endpoint: `GET /dapi/v1/historicalTrades`
- Weight: 20
- 参数:
  - `symbol` 必填
  - `limit` 可选，默认 100，最大 500
  - `fromId` 可选，按真实 trade id 从该 id 开始返回；不传则返回最近成交
- 关键限制:
  - 只支持最近一个月内的数据。
  - 只返回 order book market trades，不返回 insurance fund/ADL trades。

### Aggregate trades

- Endpoint: `GET /dapi/v1/aggTrades`
- Weight: 20
- 参数与 USD-M `aggTrades` 基本一致。
- 关键限制:
  - 只支持不早于最近 24 小时的 futures trade history。
  - 同时发送 `startTime` 和 `endTime` 时，窗口必须小于 1 小时。
  - 不建议同时发送 `fromId` 和时间范围。

## 对 Acex 的影响

- Public trades 应归 `MarketManager`/`MarketAdapter`，不是 `OrderManager`/private user data。
- Raw trades 与 aggregate trades 的字段、id 含义、分页方式都不同，类型上应显式区分。
- `since`/`until` 对 Binance raw historical trades 并不天然成立；如果 Acex 要支持按时间查 public trades，实际只能用 `aggTrades`，或先从 recent/old raw trades 拉取再由 SDK 过滤，这会有成本和完整性问题。
- MVP 若目标是“真实逐笔成交历史”，建议先支持 raw trades 的 `fromId` 分页:
  - recent: 不传 `fromId`，取最近 `limit` 条。
  - historical: 传 `fromId`，取从该 raw trade id 起的 `limit` 条。
  - 后续再加 aggregate/time-window 模式。
