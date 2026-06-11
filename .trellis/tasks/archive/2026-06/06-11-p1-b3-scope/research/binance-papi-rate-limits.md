# Binance PAPI REST rate limits

Research date: 2026-06-11. Scope: Binance Portfolio Margin REST API on `https://papi.binance.com`, mainly `/papi/v1/...`.

Primary official sources:

- Binance Portfolio Margin General Info: https://developers.binance.com/docs/derivatives/portfolio-margin/general-info
- Binance Portfolio Margin Market Data: https://developers.binance.com/docs/derivatives/portfolio-margin/market-data
- Binance Portfolio Margin Account Balance: https://developers.binance.com/docs/derivatives/portfolio-margin/account
- Binance Portfolio Margin Account Information: https://developers.binance.com/docs/derivatives/portfolio-margin/account/Account-Information
- Binance Portfolio Margin Query UM Position Information: https://developers.binance.com/docs/derivatives/portfolio-margin/account/Query-UM-Position-Information
- Binance Portfolio Margin Query User Rate Limit: https://developers.binance.com/docs/derivatives/portfolio-margin/account/Query-User-Rate-Limit
- Binance Portfolio Margin New UM Order: https://developers.binance.com/docs/derivatives/portfolio-margin/trade/New-UM-Order
- Binance Portfolio Margin Query UM Order: https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Query-UM-Order
- Binance Portfolio Margin Cancel UM Order: https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Cancel-UM-Order
- Binance Portfolio Margin Query All Current UM Open Orders: https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Query-All-Current-UM-Open-Orders
- Binance Portfolio Margin Cancel All UM Open Orders: https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Cancel-All-UM-Open-Orders
- Binance Portfolio Margin Start User Data Stream: https://developers.binance.com/docs/derivatives/portfolio-margin/user-data-streams/Start-User-Data-Stream
- Binance Portfolio Margin Keepalive User Data Stream: https://developers.binance.com/docs/derivatives/portfolio-margin/user-data-streams/Keepalive-User-Data-Stream
- Binance Portfolio Margin Close User Data Stream: https://developers.binance.com/docs/derivatives/portfolio-margin/user-data-streams/Close-User-Data-Stream
- USD-M Futures Exchange Information, used only as catalog fallback caveat: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information
- USD-M Futures Check Server Time, used only as server-time fallback caveat: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Check-Server-Time

## Bucket topology

| Bucket | Officially verified PAPI limit | Interval | Scope | Notes |
|---|---:|---|---|---|
| `REQUEST_WEIGHT` | 6000 | 1 minute | Per IP | PAPI General Info says every response has `X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)`, it is current used weight for the IP, limits are based on IPs not API keys, and Portfolio Margin IP Limit is 6000/min. |
| `ORDERS` | 1200 | 1 minute | Per account | PAPI General Info says `X-MBX-ORDER-COUNT-(intervalNum)(intervalLetter)` is current order count for the account and Portfolio Margin Order Limits are 1200/min. `GET /papi/v1/rateLimit/order` returns `rateLimitType: ORDERS`, `interval: MINUTE`, `intervalNum: 1`, `limit: 1200`. |
| `ORDERS` | UNVERIFIED (training knowledge): 300 | 10 seconds | Per account | PAPI docs found on 2026-06-11 only confirmed 1-minute PAPI order limit. USD-M `/fapi/v1/exchangeInfo` live response exposes `ORDERS` 300/10s and 1200/1m, but this is UM futures, not PAPI. |
| `ORDERS` | UNVERIFIED (training knowledge): 200000 | 1 day | Per account | PAPI docs found on 2026-06-11 only confirmed 1-minute PAPI order limit. Spot `/api/v3/exchangeInfo` live response exposes 200000/day, but this is spot, not PAPI. |

Open question: Does PAPI share request-weight capacity with UM futures or spot? The PAPI official docs only state "Portfolio Margin IP Limit is 6000/min" and describe the limit as IP-scoped. They do not state whether this pool is shared with `fapi.binance.com`, `dapi.binance.com`, or `api.binance.com`. Live unauthenticated probes from the same IP on 2026-06-11 showed independent-looking counters (`papi` already high, `fapi`/`dapi`/spot near 1), but that is an observation, not an official contract. Treat cross-product sharing as unverified; model PAPI weight as its own venue bucket unless later official docs prove otherwise.

## Headers

| Header family | Example | Meaning | Scope |
|---|---|---|---|
| `X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)` | `X-MBX-USED-WEIGHT-1M` / lower-cased by `fetch` as `x-mbx-used-weight-1m` | Current used request weight for all request-weight rate limiters defined | Per IP |
| `X-MBX-ORDER-COUNT-(intervalNum)(intervalLetter)` | `X-MBX-ORDER-COUNT-1M`; possible suffixes follow Binance convention such as `10S`, `1M`, `1D` | Current order count for all order rate limiters defined | Per account |

PAPI-specific differences found: no different header names were documented for PAPI. PAPI General Info uses the same `X-MBX-USED-WEIGHT-*` and `X-MBX-ORDER-COUNT-*` families as Binance spot/futures. Rejected or unsuccessful orders are not guaranteed to include `X-MBX-ORDER-COUNT-*`.

Live unauthenticated probe on 2026-06-11:

- `GET https://papi.binance.com/papi/v1/time` returned HTTP 200 and `x-mbx-used-weight-1m`; repeated calls incremented it by 1.
- `GET https://papi.binance.com/papi/v1/exchangeInfo` returned HTTP 404, no PAPI exchangeInfo header signal.

## 429, 418, Retry-After

| Status | Official PAPI meaning | Scope / consequence | Retry behavior |
|---|---|---|---|
| 429 | Returned when either request-weight or order-count limit is violated | For request weight, the violated scope is IP. For order count, the violated scope is account. | PAPI General Info says clients must back off after 429. It does not explicitly document a REST `Retry-After` header in the PAPI page. |
| 418 | Automated IP ban after repeatedly violating limits and/or failing to back off after 429 | IP ban. Durations scale for repeat offenders from 2 minutes to 3 days. | PAPI General Info does not explicitly document REST `Retry-After` header semantics. Binance WebSocket API docs use `retryAfter` as retry time / ban lift timestamp, but that is not REST PAPI. |

For acex implementation: still parse the standard HTTP `Retry-After` response header when present. If absent, fall back to conservative local cooldowns. A 418 should block the per-IP PAPI weight bucket, not just the endpoint that got the error. A 429 from an order endpoint may need to block both affected buckets if the response does not identify whether weight or order count was exceeded.

## Endpoint costs

These are documented PAPI costs unless marked otherwise.

| Endpoint | Security | Official PAPI request weight / order count | Notes |
|---|---|---:|---|
| `POST /papi/v1/um/order` | `TRADE` | `Request Weight(Order) = 1` | Official page labels it as order-count cost. It does not consume IP request weight per the page wording. Closest USD-M equivalent explicitly says 1 on 10s order count, 1 on 1m order count, 0 on IP weight; for PAPI, only `1` order cost is directly documented. |
| `GET /papi/v1/um/order` | `USER_DATA` | `Request Weight = 1` | IP request weight. |
| `DELETE /papi/v1/um/order` | `TRADE` | `Request Weight = 1` | The PAPI page does not label this as `Request Weight(Order)`. It appears to consume request weight, not order-count, but whether cancel also increments order count is not explicitly documented. Treat "cancel consumes order count" as UNVERIFIED (training knowledge): no. |
| `GET /papi/v1/um/openOrders` | `USER_DATA` | `1` for a single symbol; `40` when no symbol | Official page states both values. |
| `DELETE /papi/v1/um/allOpenOrders` | `TRADE` | `Request Weight = 1` | Requires `symbol`. |
| `GET /papi/v1/balance` | `USER_DATA` | `20` | Official account balance page. |
| `GET /papi/v1/account` | `USER_DATA` | `20` | Official account information page. |
| `GET /papi/v1/um/positionRisk` | `USER_DATA` | `5` | Official query UM position information page. |
| `POST /papi/v1/listenKey` | `USER_STREAM` | `1` | Official start user data stream page. |
| `PUT /papi/v1/listenKey` | `USER_STREAM` | `1` | Official keepalive user data stream page. |
| `DELETE /papi/v1/listenKey` | `USER_STREAM` | `1` | Official close user data stream page. |
| `GET /papi/v1/ping` | public | `1` | Official PAPI market-data page only documents ping. |
| `GET /papi/v1/time` | public | `1` | Official PAPI page for server time was not found, but live probe confirms the endpoint exists and increments `x-mbx-used-weight-1m` by 1. Mark exact official documentation as gap. |
| `GET /papi/v1/exchangeInfo` | public | Not available | Official PAPI exchangeInfo page was not found; live probe returned 404. Use `GET /fapi/v1/exchangeInfo` for USD-M catalog and `GET /dapi/v1/exchangeInfo` for COIN-M catalog when building market metadata. Both derivatives catalog endpoints are official weight 1, but they are not PAPI. Spot `GET /api/v3/exchangeInfo` is official weight 20. |

Third-party cross-check, not authoritative: ccxt `binance.ts` currently models PAPI through a normalized cost scale where PAPI 6000/min maps to cost `0.2` for one IP weight and 1200/min maps to cost `1` for one order. In that scale it lists `balance: 4`, `account: 4`, and `um/positionRisk: 1`, which correspond to official PAPI weights 20, 20, and 5 after multiplying by 5. Prefer official docs over ccxt for acex constants.

## Implementation implications for acex

- The Binance adapter should own endpoint cost metadata. Core should receive venue-agnostic descriptors such as "this request consumes 1 from bucket `binance:papi:REQUEST_WEIGHT:IP:1m`" and "new order consumes 1 from bucket `binance:papi:ORDERS:ACCOUNT:1m`".
- `REQUEST_WEIGHT` bucket key should not include `accountId`; it is IP-scoped and shared across accounts using the same host/IP.
- `ORDERS` bucket key should include `accountId` or UID-level account identity. Binance docs say order limits are per account and shared by API keys of the account.
- Header feedback must update bucket usage at the bucket level. Current acex `RateLimitUsage.weight["1m"]` and `orderCount["1m"]` can carry the parsed counts, but the current `scopeKey = venue + accountId + endpointKey` is too endpoint-local for PAPI's real scopes.
- Cancel endpoints should be tagged as `priority: "cancel"` or similar even if their cost is ordinary request weight, because they are risk-control operations. Do not rely on a false assumption that cancels are free.

## Confidence & gaps

- High confidence, official: PAPI request-weight limit is 6000/min per IP; order limit is 1200/min per account; header families are `X-MBX-USED-WEIGHT-*` and `X-MBX-ORDER-COUNT-*`; repeated 429 can escalate to 418 IP ban from 2 minutes to 3 days.
- High confidence, official: documented costs for the listed PAPI account, trade, openOrders, allOpenOrders, listenKey, and ping endpoints.
- Medium confidence, live observation: `GET /papi/v1/time` exists and costs 1 request weight. Official PAPI server-time page was not found.
- Medium confidence, live observation: PAPI request-weight counter appears independent from spot/UM/COIN-M counters. Official docs do not state sharing or independence.
- Gap: PAPI docs found only 1200/min order limit. 10s and 1d order-count values for PAPI are UNVERIFIED (training knowledge); do not implement them as official PAPI limits without a later source.
- Gap: PAPI docs do not explicitly say whether cancel requests consume order count. The safest documented reading is that new order consumes order count and cancel consumes request weight; mark any stronger claim UNVERIFIED.
- Gap: PAPI REST `Retry-After` header semantics are not explicitly documented in the PAPI General Info page. Parse it if present, but do not depend on it always existing.
- Gap: No official PAPI `exchangeInfo` endpoint was found; `/papi/v1/exchangeInfo` returned 404 on 2026-06-11.
