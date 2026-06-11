---
"@imbingox/acex": minor
---

订单生命周期增加 confirmed-missing 收尾与 pending claim TTL：`OrderStatus` 新增 `unknown` 终态，open 订单在 reconcile 单笔回查连续确认不存在后会移入 closed；`CreateClientOptions.order` 新增 `missingOrderEvictionThreshold` 与 `pendingClaimTtlMs`，用于配置幽灵 open 订单驱逐阈值和 `createOrder` timeout claim 回查 TTL。
