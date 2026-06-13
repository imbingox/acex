---
"@imbingox/acex": minor
---

BREAKING: remove `client.order.getSymbolFeeRate()`. Fee rate lookup is now owned by the new `client.fee` manager.

Add `client.fee.subscribe()`, `client.fee.getSymbolFeeRate()`, `client.fee.getSymbolFeeRates()`, and `client.fee.fetchSymbolFeeRate()` for account-scoped symbol fee rates. The fee manager keeps a local cache, returns market-type defaults before venue values are available, and slowly refreshes Binance swap rates through the existing PAPI UM `commissionRate` endpoint.
