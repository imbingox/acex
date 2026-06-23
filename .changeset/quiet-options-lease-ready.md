---
"@imbingox/acex": minor
---

调整 market subscription lease 的 ready 语义：L1 / funding stream 的 `lease.ready` 现在表示 logical subscription 已被底层 venue 接受，通常由 subscribe ACK 确认；如果首条可路由 data 在 ACK 前到达且能确定属于该 pending subscription，也会视为订阅已接受。

迁移提示：`await lease.ready` 不再保证 `getL1Book()` 已经有值。低流动性 symbol 可能已订阅成功但暂时没有首条 book state；调用方应先处理 `getL1Book() === undefined`，再检查 nullable bid/ask 字段。订阅 ACK 超时或被拒绝仍会 reject `MARKET_STREAM_TIMEOUT` 并释放该 lease。
