# Binance historical funding rate endpoint

## Sources

- Binance USD-M Futures docs: `GET /fapi/v1/fundingRate`
- Binance COIN-M Futures docs: `GET /dapi/v1/fundingRate`

## Findings

- USD-M funding history endpoint is `https://fapi.binance.com/fapi/v1/fundingRate`.
- COIN-M perpetual funding history endpoint is `https://dapi.binance.com/dapi/v1/fundingRate`.
- Request params are `symbol`, `startTime`, `endTime`, `limit`.
- `startTime` is inclusive; `endTime` is documented as inclusive.
- `limit` default is 100 and max is 1000.
- Results are returned in ascending order by funding time.
- USD-M docs state that when both `startTime` and `endTime` are omitted, the most recent 200 records are returned.
- USD-M response example includes `symbol`, `fundingRate`, `fundingTime`, `markPrice`.
- COIN-M response example includes `symbol`, `fundingTime`, `fundingRate`; `markPrice` should be treated as optional.
- COIN-M docs note delivery symbols return an empty array; the SDK should reject non-swap markets before calling the endpoint.

## Mapping to this repo

- Use the existing MarketManager public REST query pattern from `fetchPublicRawTrades()`.
- Add a market-level public method rather than a streaming/cache method; historical funding is a point-in-time REST query.
- Support Binance USD-M and COIN-M swap markets through existing Binance market family inference.
- Keep venue payload inside `raw` and normalize public decimal fields with `toCanonical()` at the manager boundary.
- Add a dedicated market error code for remote/query failures so callers can distinguish history fetch failures from live stream unsupported errors.
