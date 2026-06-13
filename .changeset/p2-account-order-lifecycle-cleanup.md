---
"@imbingox/acex": minor
---

收紧并扩展公开行为：`OrderSnapshot.type` / raw order type 归一为小写 `OrderType` 并通过 `rawType` 保留 venue 原始串；SDK 生成的 client order id 加入进程级熵；account getter 返回冻结快照；`stop()` 兑现 graceful drain、timeout 和 stopped client 清理，并在停止后通过 `assertStarted` 拦截新命令。

新增 Binance PAPI 风控面：私有流 `riskLevelChange` 会发布 `account.risk_level_change`，`RiskSnapshot` 新增 `riskLevel`，并用事件中的 `riskRatio`、equity 和 maintenance margin 字段实时回填风险快照。
