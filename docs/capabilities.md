# 当前支持能力

## 图例

| 图标 | 状态 |
|---|---|
| ✅ | 支持 |
| ⚠️ | 部分支持 |
| ❌ | 不支持 |
| ➖ | 不适用 |

## Venue 总览

| Venue | Public market data | Private account | Private order |
|---|---|---|---|
| Binance | ✅ | ✅ | ⚠️ |
| Deribit | ⚠️ | ❌ | ❌ |
| Juplend | ➖ | ✅ | ❌ |

## Public market data

| Venue | Spot | Swap | Future | Option |
|---|---|---|---|---|
| Binance | ✅ | ✅ | ✅ | ❌ |
| Deribit | ❌ | ❌ | ❌ | ⚠️ |
| Juplend | ➖ | ➖ | ➖ | ➖ |

## Private account

| Venue | Spot | Margin | Swap | Future | Option | Lending |
|---|---|---|---|---|---|---|
| Binance | ❌ | ✅ | ✅ | ⚠️ | ❌ | ✅ |
| Deribit | ❌ | ❌ | ❌ | ❌ | ❌ | ➖ |
| Juplend | ➖ | ➖ | ➖ | ➖ | ➖ | ✅ |

## Private order

| Venue | Spot | Margin | Swap | Future | Option | Lending |
|---|---|---|---|---|---|---|
| Binance | ❌ | ⚠️ | ⚠️ | ⚠️ | ❌ | ➖ |
| Deribit | ❌ | ❌ | ❌ | ❌ | ❌ | ➖ |
| Juplend | ➖ | ➖ | ➖ | ➖ | ➖ | ❌ |

## 相关能力

- Binance account 会把 PAPI margin liability 投影到 balance lending facet；Juplend account 是只读借贷账户视图。
- FeeManager 当前可对 Binance swap 通过 PAPI UM commissionRate 读取账号级真实费率；其他 venue 或 Binance spot/future 先返回默认费率。
- RiskLimitManager 当前可对 Binance PAPI UM 读取 leverage bracket / notional tier，并支持设置 symbol leverage。
- Deribit 当前只覆盖公开期权 catalog 和 L1 Book。
- Juplend 当前只提供借贷账户只读视图，不支持链上写操作。
