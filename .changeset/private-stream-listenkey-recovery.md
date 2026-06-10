---
"@imbingox/acex": patch
---

Binance private user streams now recover from `listenKeyExpired`, listenKey keepalive failure, and private stream message watchdog timeout by rotating the listenKey and rebuilding the WebSocket, then triggering the existing account/order reconcile path. Added optional `account.binance.privateStreamStaleAfterMs` tuning and a live order smoke entry for listenKey invalidation recovery.
