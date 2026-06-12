---
"@imbingox/acex": minor
---

Breaking: 账户级 venue 专属配置统一迁移到 `account.venues.<venue>`。移除旧的 `account.binance`、`account.juplend` 与顶层 `listenKeyKeepAliveMs` 配置入口；Binance 私有流、风险轮询与 reconcile 调优项现在放在 `account.venues.binance`，Juplend RPC/API key 与 polling 配置放在 `account.venues.juplend`。

同时改进内部交易所扩展基础设施：Binance 私有链路 symbol 归一化改走共享 market catalog，修正交割合约/私有流映射一致性；流协议层新增可选应用层 heartbeat 钩子，用于后续 OKX/Bybit 等需要客户端文本 ping 的 venue，未配置 heartbeat 的现有 Binance 连接行为不变。
