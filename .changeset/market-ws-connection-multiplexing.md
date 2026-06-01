---
"@imbingox/acex": patch
---

Binance 行情订阅现在复用 WebSocket 连接：同一 connectionKey / base URL 下多个 symbol 复用物理连接（例如 USDM L1 与 funding 因 base URL 不同会分开），通过 JSON `SUBSCRIBE`/`UNSUBSCRIBE` 动态增删订阅，断线重连后自动重放，单连接订阅数达上限会自动开新连接。行情层改为按 venue 分派 adapter，为接入更多交易所打基础。公开 API 不变。
