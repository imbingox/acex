---
"@imbingox/acex": minor
---

Extend the public rate limiter SPI with optional topology plans, bucket reserve headroom, request priority, opaque reservations, and bucket-level snapshots. The default limiter now supports Binance REST topology registration, fixed-window bucket budget admission, cancel-priority reserve for Binance PAPI request weight, usage-header reconciliation, request-not-sent refunds, jittered bucket-level 429 fallback, and bucket-level 429/418 blocking while remaining backward compatible with existing custom `RateLimiter` implementations.
