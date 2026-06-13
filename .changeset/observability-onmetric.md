---
"@imbingox/acex": minor
---

新增 `CreateClientOptions.onMetric` 同步可观测性钩子，并公开 `MetricType`、`OnMetric` 与 `METRIC_NAMES`。SDK 现在会输出下单 RTT、WebSocket 消息延迟、WebSocket reconnect 和事件 buffer overflow 指标；未配置 hook 时热路径跳过 latency 与 tags 构造，hook 抛错不会打断主流程。
