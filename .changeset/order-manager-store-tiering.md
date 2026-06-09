---
"@imbingox/acex": patch
---

OrderManager 内部订单存储改为 open / closed 分层（按 symbol 嵌套）+ 复合身份索引，终态订单不再无界累积：closed 订单按 symbol 保留最近 N 个（新增可选 `CreateClientOptions.order.maxClosedOrdersPerSymbol`，默认 500，超限按 FIFO 批量裁剪），`getOpenOrders()` 查询不再随历史订单数量增长而变慢。`getOrder()` 对外行为保持不变（仍可只按 `orderId` 或 `clientOrderId` 查询、可省略 `symbol`），`clientOrderId` 多命中时返回最新一笔。
