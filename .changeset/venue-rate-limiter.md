---
"@imbingox/acex": minor
---

Add a public `RateLimiter` seam via `CreateClientOptions.rateLimiter`. The default reactive limiter tracks venue-provided REST usage metadata and honors `Retry-After` after 429/418 responses without proactively throttling normal requests or replaying non-idempotent order commands.
