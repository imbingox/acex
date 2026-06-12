---
"@imbingox/acex": patch
---

Binance private signing timestamps now use a default server-time synchronized clock with startup sampling, periodic resync, and timestamp-error-triggered resync. Passing `CreateClientOptions.clock` continues to fully override signing time and disables the default sampler.
