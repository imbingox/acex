---
"@imbingox/acex": minor
---

Add post-only limit order support and market order input normalization. Binance PAPI UM limit orders now map `postOnly: true` to `timeInForce=GTX`, and callers can normalize price and amount strings with `market.normalizeOrderInput()` before placing orders.
