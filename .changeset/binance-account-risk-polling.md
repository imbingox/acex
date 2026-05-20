---
"@imbingox/acex": minor
---

通过周期性 REST polling 刷新 Binance 账户风险和 mark-to-market 仓位字段。`RiskSnapshot` 现在暴露风控口径的 `riskLeverage`，Binance 账户运行时配置新增 `account.binance.riskPollIntervalMs`。
