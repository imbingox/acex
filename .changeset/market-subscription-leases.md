---
"@imbingox/acex": major
---

Replace market websocket subscribe/unsubscribe methods with per-consumer subscription leases. Use `client.market.acquireL1BookSubscription()` and `client.market.acquireFundingRateSubscription()` to obtain a `MarketSubscriptionLease`, await `lease.ready` for the first snapshot, and call `lease.close()` to release only that consumer. L1 book and funding rate streams now ref-count active leases independently and only close the underlying websocket stream after the final lease is closed.
