---
"@imbingox/acex": patch
---

打磨行情流层：优化 decimal 字符串 canonical 快路径和行情 tick 快照复用，移除健康连接下的 per-subscription stale 误判，并为 WebSocket 重连退避加入默认 ±20% jitter。
