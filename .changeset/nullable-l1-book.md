---
"@imbingox/acex": minor
---

Change L1 Book snapshots to nullable top-of-book state. `bidPrice` / `bidSize` / `askPrice` / `askSize` are now `string | null`, partial and empty books resolve L1 subscription readiness, and `status.reason: "no_quote"` has been removed.

Migration: `await lease.ready` now means the SDK has received the first readable top-of-book state, not necessarily a complete two-sided quote. Check `askPrice` / `askSize` before buying, `bidPrice` / `bidSize` before selling, and treat all four fields being `null` as an empty book rather than a subscription failure.
