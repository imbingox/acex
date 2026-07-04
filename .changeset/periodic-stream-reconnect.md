---
"@imbingox/acex": patch
---

修复周期性行情流在业务 payload 停止推送但 WebSocket 仍保持 open 时的恢复行为。Binance funding / mark-price stream 超过配置的 stale 阈值后会主动重连并重放订阅；同一连接上的其它订阅仍会收到正常断线状态，不会被该业务 stale 恢复路径误吞。
