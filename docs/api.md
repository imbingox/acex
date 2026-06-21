# @imbingox/acex API 文档

本文是 SDK 使用文档入口。README 只保留项目简介和最小示例；更完整的接入方式、manager API、类型字段和错误处理按主题拆分在下列文档中。

## 快速入口

| 目标 | 文档 |
|---|---|
| 快速安装、初始化和常见接入流程 | [quickstart.md](./quickstart.md) |
| 查看当前 venue 支持能力 | [capabilities.md](./capabilities.md) |
| 查询 Client / manager API | [managers.md](./managers.md) |
| 查询公共类型和字段含义 | [types.md](./types.md) |
| 查询错误处理和能力边界 | [errors.md](./errors.md) |

## 核心模型

`acex` 是状态型多 venue SDK。调用方创建一个 `AcexClient`，通过 `market` / `account` / `order` / `fee` / `riskLimit` 等 manager 读取最新快照、消费事件流、执行命令、查询手续费费率和交易所硬风控限制。

SDK 内部维护本地缓存、ready barrier、WebSocket 生命周期、自动重连、REST timeout / retry、错误脱敏和 reactive rate limiter。

## Manager 概览

| Manager | 用途 | 文档 |
|---|---|---|
| Client lifecycle | 创建 client、启动/停止 runtime、注册账户、查询 venue capabilities | [managers.md](./managers.md#client-生命周期) |
| MarketManager | market catalog、L1 Book、funding rate、public trades、Deribit option catalog / pairs | [managers.md](./managers.md#marketmanager) |
| AccountManager | 账户快照、余额、持仓、风险投影和账户事件流 | [managers.md](./managers.md#accountmanager) |
| OrderManager | open orders 投影、订单事件流、下单和撤单命令 | [managers.md](./managers.md#ordermanager) |
| FeeManager | 账号级 symbol 手续费费率查询 | [managers.md](./managers.md#feemanager) |
| RiskLimitManager | Binance PAPI UM leverage bracket / notional tier 查询和杠杆设置 | [managers.md](./managers.md#risklimitmanager) |

## 类型与错误

- 价格、数量等公共输出字段统一是 canonical decimal string（无科学计数法、不补尾零）。
- 输入侧保持宽进严出，`DecimalInput` 接受 string / number / `BigNumber`；公共输出仍统一为 string。
- 如需运算，使用 SDK re-export 的 `BigNumber`：`new BigNumber(field)`。
- 错误统一通过 `AcexError` 暴露，`code` 用于稳定分类，`details` 携带 venue、account、market、transport 等上下文。

详见 [types.md](./types.md) 和 [errors.md](./errors.md)。
