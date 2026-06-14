# Acex public trades 接入建议

## 范围确认

用户已明确要的是 public market trades，不是 account/my trades。因此本任务应接入 market data 层：

- Public market trades: `client.market` / `MarketManager` / `MarketAdapter`
- Account trades: `client.order` 或 private adapter，非本任务

现有 `client.order.events.trades(...)` 是私有订单成交事件，承载 account 维度的手续费、realized PnL 等，不应与 public market trades 混用。

## 当前项目边界

已确认的现状：

- `src/types/market.ts` 的 `MarketManager` 目前有:
  - `loadMarkets`
  - `fetchServerTime`
  - L1 book 订阅/读取
  - funding rate 订阅/读取
  - market catalog 与 order input normalize
- `src/adapters/types.ts` 的 `MarketAdapter` 目前只有:
  - `loadMarkets`
  - optional `fetchServerTime`
  - `createL1BookStream`
  - `createFundingRateStream`
- `src/adapters/binance/adapter.ts` 的 `BinanceMarketAdapter` 现在支持 spot/swap/future catalog、server time、L1、funding stream，但没有 REST trades 查询。
- `VenueMarketCapabilities` 目前没有 public trades 能力字段。
- Binance rate-limit topology 已覆盖 spot/fapi/dapi exchangeInfo 和 fapi server time；还没有 public trades 相关 plan。

## 推荐 MVP

用户实际使用时会给一个很小的时间窗口，例如 1 分钟。这个输入形态更适合 Binance `aggTrades`，因为 raw recent/historical trades endpoint 不支持 `startTime`/`endTime`。

用户进一步确认需要最精确的撮合时间。因此 aggregate trades 不能作为最终返回；它只能用来定位窗口覆盖的 raw trade id 范围。最终返回必须是 raw public trades，`exchangeTs` 来自 raw trade 响应的 `time` 字段。

### 不推荐: aggregate time-window 直接返回

直接暴露 aggregate trades 虽然调用简单：

```ts
client.market.fetchAggregateTrades({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  since: 1710000000000,
  until: 1710000060000,
  limit: 1000,
});
```

但它不满足“最精确撮合时间”：

- Binance 原生支持 `startTime`/`endTime`。
- 对 1 分钟窗口实现简单，REST 调用少。
- 返回量相对小。
- 返回的是聚合成交，不是每一笔真实撮合成交。
- Aggregate trade id 不是 raw trade id。
- Aggregate trade 的 `T` 不能代表内部每笔 raw trade 的独立撮合时间。

### 推荐: raw time-window 查询

如果用户需要 1 分钟窗口内的真实逐笔成交，可以用两段式实现：

1. 调 `aggTrades({ startTime, endTime })` 找窗口内 aggregate trades。
2. 从 aggregate 结果取最小 `f` / 最大 `l`，即窗口覆盖的 raw `firstTradeId` / `lastTradeId`。
3. 调 `historicalTrades({ fromId })` 分页拉 raw trades，直到超过 `lastTradeId` 或 `time > until`。
4. SDK 过滤 `time >= since && time <= until` 后返回 raw public trades。

优点：

- 对外仍返回真实 raw public trades。
- 最终 `exchangeTs` 使用 raw trade `time`，这是 REST 响应里可获得的逐笔撮合时间。
- 输入仍可用 `since/until`。

缺点：

- 实现复杂，且 1 分钟内成交量很大时可能需要多次 raw trades 请求。
- Futures `aggTrades` 只支持最近 24 小时，且 `startTime`/`endTime` 同传时窗口必须小于 1 小时；1 分钟窗口满足窗口长度限制，但不能查任意久远时间。
- 如果 aggregate 查询本身超过 `limit`，还需要先分页 aggregate 结果，才能完整覆盖 raw id 范围。

推荐 public API：

```ts
client.market.fetchPublicRawTrades({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  startTs: 1710000000000,
  endTs: 1710000060000,
  limit: 5000,
});
```

输入语义：

- `startTs` 必填，毫秒时间戳。
- `endTs` 和 `limit` 至少传一个。
- 只传 `limit` 时，从 `startTs` 开始返回最多 N 条 raw trades。
- 只传 `endTs` 时，返回半开区间 `[startTs, endTs)` 内的 raw trades，最多到 SDK 默认安全上限。
- 两者都传时，两者同时生效：返回 `[startTs, endTs)` 内最多 `limit` 条；如果窗口内超过 `limit`，返回 `truncated: true` 和续拉信息。
- 默认 `limit` 可以取 1000 或 5000；如果命中上限，返回结果应带 `truncated: true` 和续拉信息，例如 `nextFromId`。
- 为避免 aggregate 边界时间与 raw trade 内部时间差导致漏边界成交，内部 `aggTrades` 定位时可以对查询窗口加小幅 padding，再用 raw trade `time` 做最终过滤。

建议返回形态：

```ts
export interface FetchPublicRawTradesResult {
  trades: PublicTrade[];
  startTs: number;
  endTs: number;
  truncated: boolean;
  nextFromId?: string;
}
```

### 底层能力: raw fromId 查询

无论选方案 A 还是 B，都可以保留 raw public trades 单页查询作为底层能力：

```ts
client.market.fetchTrades({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  fromId: "123456789",
  limit: 500,
});
```

语义：

- 不传 `fromId`: 调用 recent raw trades endpoint，返回最近 `limit` 条。
- 传 `fromId`: 调用 historical/old raw trades endpoint，从该 raw trade id 起返回 `limit` 条。
- 返回值按 Binance 返回顺序再规范化为时间升序。如果 Binance 已按升序返回，则保持。
- 直接 raw endpoint 不支持 `since/until`，因为 Binance raw historical trades 不支持时间范围。
- 不做自动分页。调用者根据最后一条 `id` 自行传下一次 `fromId`。

建议类型：

```ts
export interface FetchTradesInput {
  venue: Venue;
  symbol: string;
  fromId?: string;
  limit?: number;
}

export interface PublicTrade {
  venue: Venue;
  symbol: string;
  id: string;
  price: string;
  amount: string;
  cost?: string;
  side?: OrderSide;
  exchangeTs: number;
  receivedAt: number;
  raw: Record<string, unknown>;
}
```

Binance raw 字段映射：

- `id` -> `id`
- `price` -> `price`
- `qty` -> `amount`
- Spot/USD-M `quoteQty` -> `cost`，表示 quote notional。
- COIN-M `baseQty` 不应放进 `cost`，保留在 `raw` 或后续单独字段。
- `time` -> `exchangeTs`
- `isBuyerMaker` -> public trade side 可推导:
  - `isBuyerMaker = true` 表示 buyer 是 maker，taker 是 seller，可映射为 taker side `sell`。
  - `isBuyerMaker = false` 表示 taker side `buy`。
  - 如果暴露 `side`，应在文档明确是 taker side。
- `isBestMatch`、`isRPITrade` 放入 `raw`。

## Aggregate trades 作为后续能力

Aggregate trades 应单独建模：

```ts
export interface FetchAggregateTradesInput {
  venue: Venue;
  symbol: string;
  fromId?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface PublicAggregateTrade {
  venue: Venue;
  symbol: string;
  id: string;
  price: string;
  amount: string;
  firstTradeId?: string;
  lastTradeId?: string;
  takerSide?: OrderSide;
  exchangeTs: number;
  receivedAt: number;
  raw: Record<string, unknown>;
}
```

原因：

- Binance aggregate trade id 与 raw trade id 不同。
- Aggregate trades 可以按时间窗口查，但 futures 只有最近 24 小时，且 `startTime`/`endTime` 同传时窗口小于 1 小时。
- 把 aggregate trades 混进 raw trades 会让用户误以为拿到了每笔撮合。

## Rate limit 与 adapter 注意事项

需要给 Binance public REST 增加 rate-limit plan：

- Spot:
  - `GET /api/v3/trades`: weight 25，spot request weight bucket。
  - `GET /api/v3/historicalTrades`: weight 25，spot request weight bucket。
  - `GET /api/v3/aggTrades`: weight 4，spot request weight bucket。
- USD-M:
  - `GET /fapi/v1/trades`: weight 5，fapi request weight bucket。
  - `GET /fapi/v1/historicalTrades`: weight 20，fapi request weight bucket。
  - `GET /fapi/v1/aggTrades`: weight 20，fapi request weight bucket。
- COIN-M:
  - `GET /dapi/v1/trades`: weight 5，dapi request weight bucket。
  - `GET /dapi/v1/historicalTrades`: weight 20，dapi request weight bucket。
  - `GET /dapi/v1/aggTrades`: weight 20，dapi request weight bucket。

Adapter 层需要根据 market family 选择 endpoint：

- spot -> `/api/v3/...`
- usdm/swap -> `/fapi/v1/...`
- coinm/future 或 inverse swap -> `/dapi/v1/...`

Public trades 不需要 account credentials，也不应触发 private runtime 或 order event bus。

## 后续决策点

唯一需要产品侧确认的点是默认语义：

- 推荐: `fetchTrades` 默认 raw public trades，aggregate 另设 `fetchAggregateTrades`。
- 兼容 CCXT: `fetchTrades` 默认 aggregate trades，但这会弱化“逐笔成交”的直觉。
- 折中: `fetchTrades({ mode })`，默认 `mode: "raw"`，后续可扩 `mode: "aggregate"`。
