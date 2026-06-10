---
"@imbingox/acex": patch
---

OrderManager 内部订单主键改为 SDK 生成的 `localOrderId`，并维护 venue `orderId` / `clientOrderId` 反向索引与下单 pending claim，避免 REST 返回前早到的 WS 更新双建订单。公开 API 与类型不变。

行为变化：调用 `createOrder()` 未传 `clientOrderId` 时，SDK 现在会生成合规的 `acex-*` client id 并作为 Binance `newClientOrderId` 发送，返回的 `snapshot.clientOrderId` 也会是该生成值，而不再依赖 Binance 自动生成。
