---
"@imbingox/acex": minor
---

重命名账户风险权益字段并拆分净值与风控口径。`RiskSnapshot.equity` 替换为 `netEquity` / `riskEquity`，`actualLeverage` 替换为 `riskLeverage`；Binance 使用 `actualEquity` / `accountEquity` 分别映射净权益和风控折算权益，Juplend 使用清算阈值折算权益填充 `riskEquity`。
