---
"@imbingox/acex": minor
---

新增 `AcexError.details.venueError.reason`、订单命令错误的 `details.orderState`，并导出 `isOrderStateUnknown()`，方便调用方用稳定语义区分交易所拒单、限流、余额不足和订单状态未知场景。
