# Support Binance TradFi Perps public market data

## Goal

修复 Binance TradFi Perps 在 public market catalog 中被误归类的问题，使 `AAPL/USDT:USDT` 等 `TRADIFI_PERPETUAL` 合约能按永续合约正常获取合约信息，并通过现有 public WebSocket 订阅 L1 Book 和 funding/mark price。

## What I Already Know

* Binance `GET /fapi/v1/exchangeInfo` 当前返回多个 `contractType = TRADIFI_PERPETUAL` 的合约，例如 `AAPLUSDT`、`TSLAUSDT`、`NVDAUSDT`、`SPYUSDT`。
* 这些合约的 `underlyingType` 可为 `EQUITY`、`COMMODITY`、`PREMARKET`，`underlyingSubType` 包含 `TradFi`。
* 原生 Binance public WS 可订阅 `aaplusdt@bookTicker` 和 `aaplusdt@markPrice`，分别返回 L1 book 与 funding/mark price 数据。
* 当前 SDK catalog 已读到 TradFi 合约，但把 `AAPLUSDT` 归一化为 `AAPL/USDT:USDT-21001225`，原因是 `TRADIFI_PERPETUAL` 没被识别为 swap，同时 Binance 返回远期 `deliveryDate = 4133404800000`。
* 当前 SDK 使用误归一化 symbol 可订阅 L1 book，但 funding 被 `market.type !== "swap"` 拒绝。

## Requirements

* `TRADIFI_PERPETUAL` 必须被识别为永续 swap，不应因远期 `deliveryDate` 被归为 future。
* TradFi Perps 的 SDK symbol 应为标准永续格式，例如 `AAPL/USDT:USDT`。
* `client.market.getMarket("binance", "AAPL/USDT:USDT")` 应能返回 active contract market，`type = "swap"`，`contract = true`。
* `client.market.subscribeL1Book({ venue: "binance", symbol: "AAPL/USDT:USDT" })` 应复用现有 Binance USDM bookTicker WS 路径。
* `client.market.subscribeFundingRate({ venue: "binance", symbol: "AAPL/USDT:USDT" })` 应复用现有 Binance USDM markPrice WS 路径并通过 funding 支持校验。
* 更新测试，覆盖 catalog 归一化、L1 route、funding route。
* 更新文档中 Binance market 支持范围，明确 TradFi Perps public market data 支持。

## Acceptance Criteria

* [x] 单元或集成测试覆盖 `TRADIFI_PERPETUAL` catalog 归一化为 swap。
* [x] 测试覆盖 TradFi symbol 的 L1 book 订阅流名称和路由。
* [x] 测试覆盖 TradFi symbol 的 funding/mark price 订阅流名称和路由。
* [x] `bun run lint` 通过。
* [x] `bun run type-check` 通过。
* [x] 相关测试通过。

## Out of Scope

* 不在本任务实现 Binance TradFi Perps 下单。
* 不在本任务实现 `/papi/v1/um/stock/contract` 签署协议接口。
* 不新增普通 Futures `/fapi` private trading adapter。
* 不新增新的 `MarketType` 或 TradFi 专属资产类型，保留当前 public `MarketDefinition` 兼容形状。

## Technical Notes

* 主要代码路径：`src/adapters/binance/market-catalog.ts`、`src/adapters/binance/stream-protocol.ts`、`src/managers/market-manager.ts`。
* 现有 funding 支持校验在 `market.contract && market.type === "swap"`，修复 catalog 归类后应自然通过。
* 研究记录见 `research/binance-tradfi-public-market.md`。
* 真实 public smoke：`bun run scripts/live-market-smoke.ts --perp-symbol 'AAPL/USDT:USDT' --duration 6` 通过。
