---
"@imbingox/acex": patch
---

修复 Binance PAPI 风险杠杆实时性：`ACCOUNT_UPDATE` 和 `riskLevelChange` 私有流事件在已有 mark price 与 risk equity 时会同步刷新 `RiskSnapshot.riskLeverage`，全平时更新为 `"0"`；缺少 mark price 时等待 REST risk refresh 校准。
