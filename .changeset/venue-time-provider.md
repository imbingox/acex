---
"@imbingox/acex": minor
---

Add an injectable request signing clock via `CreateClientOptions.clock` and the public `TimeProvider` type. The default remains the local system clock; this does not add server-time calibration.
