---
"@imbingox/acex": minor
---

Add `client.market.fetchPublicTrades()` for public aggregate market trades and make `client.market.fetchPublicRawTrades()` ready for Binance raw historical trades when a market API key is configured. `fetchPublicTrades()` uses public `aggTrades` without credentials; `fetchPublicRawTrades()` uses `historicalTrades` with `CreateClientOptions.market.venues.binance.apiKey` or `BINANCE_MARKET_API_KEY`, and its available lookback follows Binance MARKET_DATA endpoint availability.
