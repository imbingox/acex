---
"@imbingox/acex": minor
---

Add `client.market.fetchPublicTrades()` for public aggregate market trades and make `client.market.fetchPublicRawTrades()` ready for Binance raw historical trades when a market API key is configured. `fetchPublicTrades()` uses public `aggTrades` without credentials; `fetchPublicRawTrades()` uses `aggTrades` as a locator and then `historicalTrades` with `CreateClientOptions.market.venues.binance.apiKey` or `BINANCE_MARKET_API_KEY`, so its available lookback follows the data available from both Binance endpoints.
