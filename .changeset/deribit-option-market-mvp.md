---
"@imbingox/acex": minor
---

新增 Deribit 公开期权行情 MVP：`Venue` 支持 `deribit`、`MarketType` 支持 `option`，`MarketDefinition` 增加可收窄的 `OptionMarketDefinition`，并新增 `listOptionMarkets()` / `listOptionPairs()` 用于 option chain 与 call/put pair discovery。

`createClient()` 新增顶层 `venues` runtime 选择；省略时启用当前 SDK runtime-supported venues，显式数组可收窄到如 `["binance"]`。Deribit market config 支持 `market.venues.deribit.underlyings`，默认 `["BTC"]`。

Deribit 当前只支持 public option catalog 和 `quote.<instrument>` L1 Book，不支持账户、订单、私有流、Greeks / IV / mark price 稳定 API 或 L2/depth。
