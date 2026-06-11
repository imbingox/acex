---
"@imbingox/acex": minor
---

事件流新增 `conflate` / `buffer` 与 `maxBuffer` 订阅选项：L1 Book 与 Funding Rate 默认改为 latest-wins，慢消费者只保留同一 `venue:symbol` 的最新事件；market status 事件按 activity/ready/freshness/reason 去重发布；buffer 溢出会丢弃最旧事件并通过 `EVENT_BUFFER_OVERFLOW` runtime error 告警。
