---
"@imbingox/acex": minor
---

公开 `AcexError.details` 与 `AcexError.cause`，让调用方在捕获订单、市场目录、server time、account/order bootstrap 等失败时，既能继续使用稳定的 `error.code` 分支，也能读取交易所结构化拒绝原因（`details.exchange.code/message`）和已脱敏的 transport 诊断信息（`details.transport`）。

