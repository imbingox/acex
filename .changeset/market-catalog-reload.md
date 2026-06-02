---
"@imbingox/acex": minor
---

新增 `client.market.reloadMarkets(venue?)` 主动刷新市场目录能力，并公开 `MarketCatalogReloadSummary` 返回每个 venue 的新增、移除、总数和失败摘要。刷新失败会保留旧目录并在对应 summary 中返回错误，方便长运行进程在交易所新增 symbol 后无需重启即可加载新目录。
