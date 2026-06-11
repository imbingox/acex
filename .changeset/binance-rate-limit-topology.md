---
"@imbingox/acex": minor
---

Extend the public rate limiter SPI with optional topology plans, request priority, opaque reservations, and bucket-level snapshots. The default limiter now supports Binance REST topology registration, fixed-window bucket budget admission, usage-header reconciliation, request-not-sent refunds, and bucket-level 429/418 blocking while remaining backward compatible with existing custom `RateLimiter` implementations.
