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
- Each quote payload maps to nullable top-of-book data and must use the multiplexer `data` route / adapter `onUpdate`.
- A side is valid only when both price and size are finite and greater than 0. If either field is missing, non-finite, or non-positive, set that side's price and size to `null`.
- Publish `L1Book` for two-sided, bid-only, ask-only, and empty states. All four states resolve first `lease.ready`, increment version, update `getL1Book()`, and publish `l1_book.updated`.
- Empty book is fresh/readable market state: `status.ready = true`, `freshness = "fresh"`, and `reason` is unset.
- Do not use status-only routes or status reasons for normal quote shape, and do not add a separate public quote-state field.

## Capability Contract

- Deribit available runtime is read-only.
- Market capabilities: catalog and L1 Book supported; server time, funding, public trades, raw trades, and funding history unsupported.
- Account and order capabilities are unsupported; order reason is `read_only`.
