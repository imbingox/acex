# Binance TradFi Perps Public Market Research

## Date

2026-06-08

## Findings

Binance USD-M public `exchangeInfo` 当前返回 `TRADIFI_PERPETUAL` 合约。实时抽样显示共有 75 个 TradFi perpetual，包含：

* `AAPLUSDT`，`underlyingType = EQUITY`
* `TSLAUSDT`，`underlyingType = EQUITY`
* `NVDAUSDT`，`underlyingType = EQUITY`
* `SPYUSDT`，`underlyingType = EQUITY`
* `XAUUSDT`，`underlyingType = COMMODITY`

这些合约带有正常交易过滤器，例如 `PRICE_FILTER`、`LOT_SIZE`、`MIN_NOTIONAL`。

原生 public WebSocket 验证：

* `wss://fstream.binance.com/ws` + `aaplusdt@bookTicker` 可收到 L1 book 数据。
* `wss://fstream.binance.com/market/ws` + `aaplusdt@markPrice` 可收到 `markPriceUpdate`，包含 funding rate 字段 `r` 和 next funding time 字段 `T`。

SDK 当前行为：

* `client.market.loadMarkets()` 能加载 TradFi 合约。
* `AAPLUSDT` 当前被归一化为 `AAPL/USDT:USDT-21001225`，`type = "future"`。
* 用误归一化 symbol 可订阅 L1 book，因为 stream descriptor 仍使用 `id = AAPLUSDT`。
* funding 订阅失败，错误为 `MARKET_FUNDING_RATE_UNSUPPORTED`，因为 `MarketManager` 只允许 `type = "swap"` 的 contract market。

## Post-Fix Verification

修复后 `bun run scripts/live-market-smoke.ts --perp-symbol 'AAPL/USDT:USDT' --duration 6` 通过：

* market catalog 将 `AAPL/USDT:USDT` 识别为 `type = "swap"`、`active = true`、`settle = "USDT"`、`linear = true`。
* L1 Book 订阅走 `wss://fstream.binance.com/ws`。
* Funding Rate 订阅走 `wss://fstream.binance.com/market/ws`。
* live smoke 未记录 runtime error。

## Sources

* Binance public REST: `https://fapi.binance.com/fapi/v1/exchangeInfo`
* Binance USD-M Exchange Information: `https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information`
* Binance USD-M WebSocket stream behavior verified against live public WS endpoints.
