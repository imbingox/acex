# Binance 默认手续费参考

## 结论

本任务的内置默认费率只作为本地兜底值，不代表账号实际费率、VIP 等级、BNB 折扣、返佣或活动优惠。账号真实费率仍以 venue 私有接口返回值为准。

推荐 Binance 内置默认值：

| MarketType | maker | taker | 说明 |
|---|---:|---:|---|
| `spot` | `0.001` | `0.001` | CCXT `binance.fees.trading` 默认值 |
| `swap` | `0.0002` | `0.0005` | CCXT `binance.fees.linear.trading` 默认值；当前 SDK PAPI UM fee adapter 覆盖此类 |
| `future` | `0.0001` | `0.0005` | CCXT `binance.fees.inverse.trading` 默认值 |

## 依据

* CCXT Binance metadata 将 trading fee 按 spot / linear / inverse 分组：
  * spot trading: maker `0.001`, taker `0.001`
  * linear trading: maker `0.000200`, taker `0.000500`
  * inverse trading: maker `0.000100`, taker `0.000500`
* acex 当前 `MarketType` 为 `spot | swap | future`：
  * `swap` 对应当前 Binance PAPI UM / linear perpetual 使用的默认值。
  * `future` 先对应 inverse / coin-margined delivery futures 的默认值。
* Binance spot 文档存在账号级 commission 查询接口 `GET /api/v3/account/commission`，但当前 SDK private adapter 已实现的是 PAPI UM `GET /papi/v1/um/commissionRate`。因此本任务 MVP 的真实远端刷新先只覆盖 Binance `swap`。

## 设计约束

* 默认费率必须按 `Venue + MarketType` 解析，不能只有一个全局 maker / taker。
* 未读取到真实费率时必须返回默认值，不能返回 `undefined`。
* 非 Binance venue 或 Binance 暂未支持的 market type 仍必须有兜底默认值；调用方可通过 `CreateClientOptions.fee.defaultRates` 覆盖。
