# Deribit Venue Spec

## Scope

Deribit runtime support is currently public option market data only: option catalog, option pair discovery, and `quote.<instrument>` L1 Book. Account, order, private stream, Greeks / IV / mark price stable APIs, and L2/depth are out of scope until explicitly implemented.

## Market Catalog

- `CreateClientOptions.market.venues.deribit.underlyings` configures option underlyings. Inputs are trimmed, uppercased, deduped, and mapped to Deribit `public/get_instruments` `currency`.
- Omitted `underlyings` defaults to `["BTC"]`; empty normalized lists are configuration errors.
- Catalog load failures for any requested underlying fail the load; do not silently skip missing underlyings.
- Deribit option `symbol` is `<underlying>/<strikeCurrency>:<settle>-<YYYYMMDD>-<strike>-<C|P>`, for example `BTC/USD:BTC-20260621-57000-C`.
- `OptionMarketDefinition.id` keeps the native Deribit instrument name, while `raw` keeps the original payload.

## Option Discovery

- `listOptionMarkets(filter)` and `listOptionPairs(filter)` are pure catalog reads; they must not implicitly load markets or touch the network.
- Pair grouping key is `venue + underlying + strikeCurrency + premiumCurrency + settle + expiry + strike`; incomplete call/put pairs are not returned.
- Sorting must be stable by venue, underlying, currencies, settle, expiry, numeric strike, and option type where relevant.

## L1 Book

- Deribit option L1 使用 public WS `quote.<instrument>`。
- `lease.ready` 由 Deribit `public/subscribe` ACK resolve。如果 matching `quote.<instrument>` data message 在该 ACK 前到达，已路由的 data 也视为 subscription acceptance，并 resolve `lease.ready`。
- 每个 quote payload 都映射为 nullable top-of-book data，并且必须使用 multiplexer `data` route / adapter `onUpdate`。
- 单侧报价只有在 price 和 size 都有限且大于 0 时才有效。任一字段缺失、非有限或非正数时，该侧 price 和 size 都置为 `null`。
- two-sided、bid-only、ask-only 和 empty 状态都要发布 `L1Book`。这四种状态都会递增 version、更新 `getL1Book()`，并发布 `l1_book.updated`。
- Empty book 是 fresh/readable market state：`status.ready = true`、`freshness = "fresh"`，且 `reason` 不设置。
- 不要对正常 quote shape 使用 status-only route 或 status reason，也不要新增独立 public quote-state 字段。

## Capability Contract

- Deribit available runtime is read-only.
- Market capabilities: catalog and L1 Book supported; server time, funding, public trades, raw trades, and funding history unsupported.
- Account and order capabilities are unsupported; order reason is `read_only`.
