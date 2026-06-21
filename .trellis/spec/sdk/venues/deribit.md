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

- Deribit option L1 uses public WS `quote.<instrument>`.
- Only publish `L1Book` when bid/ask price and size are all present, finite, and positive.
- Before lease ready, no complete quote means `lease.ready` keeps waiting and may timeout; never publish partial books.
- After a complete quote exists, a no-quote payload is a status-only transition: keep last complete top-level prices/timestamps/version, set `status.freshness = "stale"`, `status.reason = "no_quote"`, update status `lastReceivedAt`, and publish `market.status_changed` only.
- A later complete quote publishes a fresh `L1Book` and clears the no-quote reason.

## Capability Contract

- Deribit available runtime is read-only.
- Market capabilities: catalog and L1 Book supported; server time, funding, public trades, raw trades, and funding history unsupported.
- Account and order capabilities are unsupported; order reason is `read_only`.
