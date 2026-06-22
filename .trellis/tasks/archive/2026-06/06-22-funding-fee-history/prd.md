# Account funding fee history API

## Goal

为 acex 增加账户级 funding fee history 查询能力，让下游可以按账户、时间范围和可选 symbol 集合查询 Binance 实际发生的资金费收付流水，而不是公开 funding rate 历史。

该能力应隐藏 Binance income history 对多 symbol 不支持批量查询的细节，同时保持分页语义清楚、不会误导下游认为 account-scan 模式有 per-symbol 截断信息。

## Confirmed Facts

- Binance 账户实际资金费来自 income history，查询时必须固定 `incomeType=FUNDING_FEE`。
- Binance income history 单次请求也有 `limit` 限制，默认 100，最大 1000，并支持 `page` 翻页。
- 当前 acex 已有 `client.market.fetchFundingRateHistory()`，语义是公开 market funding rate history，不是账户实际收付。
- 当前 `FeeManager` 语义是账号级 maker/taker 费率查询；项目规范要求避免把“费率查询”和“已发生手续费流水”混淆。
- 当前 Binance private runtime 主要通过 PAPI UM private adapter 提供账号级能力；第一版应沿用现有 private adapter / account 注册 / credential 检查路径。

## Requirements

- Public API 落点应是 `AccountManager`，例如 `client.account.fetchFundingFeeHistory(...)`。
- Public input 使用 unified symbols：
  - `symbols === undefined` 表示查询全账户 funding fee history。
  - `symbols: []` 表示空结果，不发远端请求。
  - `symbols.length <= 5` 时 SDK 内部优先按 symbol 循环查询。
  - `symbols.length > 5` 时 SDK 内部优先走 account-scan，再按 symbols 本地过滤。
- Public API 不暴露 `incomeType`；adapter 必须固定传 `FUNDING_FEE`。
- Public API 不暴露 internal strategy；下游只按 query-level pagination 使用 `page` / `nextPage`。
- Venue capabilities 应暴露账户级 funding fee history 支持状态，避免下游只能靠 try/catch 探测。
- `page` 默认 1；`limit` 默认 1000，最大 1000。
- `truncated` 是 query-level 语义：
  - per-symbol 内部查询时，任意底层 symbol 请求返回数量达到 `limit`，则当前 query 视为 truncated。
  - account-scan 内部查询时，账户级 income page 返回数量达到 `limit`，则当前 query 视为 truncated。
  - `truncated === true` 只表示下游应以相同查询条件请求 `nextPage`；不表示某个 symbol 一定还有下一页。
- Result 应提供 `nextPage?: number`。当 `truncated` 为 true 时，`nextPage = page + 1`。
- Result entries 应包含可选 venue-provided transaction id：
  - `venueTransactionId?`（Binance 映射 `tranId`；其它 venue 没有等价字段时可省略，不再额外生成 SDK synthetic id）
  - `accountId`
  - `venue`
  - `symbol`
  - `asset`
  - `amount`
  - `fundingTime`
  - `receivedAt`
  - `tradeId?`
  - `positionSide?`（Binance REST 历史接口没有该字段时不填）
  - `raw`
- `amount` 等 public decimal 输出必须是 canonical decimal string。
- Entries 应按 `fundingTime`、`symbol`、`venueTransactionId ?? ""` 稳定排序。
- 文档必须说明下游拉全量时应固定 `endTs`，循环请求 `nextPage` 直到没有下一页；防御性去重优先使用 `accountId + venue + venueTransactionId`，缺少 `venueTransactionId` 时回退到 `accountId + venue + symbol + asset + fundingTime + amount + tradeId?`。
- 第一版不要求自动扫完整时间窗口；普通 API 只做 page-level fetch。

## Acceptance Criteria

- [ ] `AccountManager` public type 暴露 `fetchFundingFeeHistory(input)`，并从根入口类型导出。
- [ ] `VenueAccountCapabilities` 暴露 funding fee history 支持状态；Binance 为 supported，未实现 venue 为 unsupported。
- [ ] Binance adapter 使用 private signed income history 请求，固定 `incomeType=FUNDING_FEE`，支持不传 symbol 的 account-scan 与单 symbol 查询。
- [ ] `symbols: []` 不发远端请求并返回空结果。
- [ ] `symbols.length <= 5` 走 per-symbol 查询；已完成的 symbol 在后续 page 中返回空页是可接受行为。
- [ ] `symbols.length > 5` 走 account-scan + 本地过滤；不返回 per-symbol truncated 语义。
- [ ] `truncated` / `nextPage` 对 per-symbol 与 account-scan 两种内部路径都符合 query-level pagination 语义。
- [ ] `limit > 1000` 被本地拒绝，不发远端请求。
- [ ] 未 start、账号不存在、缺 credentials、venue 不支持、REST / parse 失败均返回稳定 `AcexError`，并保留 venue/account/symbol 与 transport/venue error details。
- [ ] 测试覆盖固定传 `incomeType=FUNDING_FEE`，避免普通 income 类型污染分页。
- [ ] 测试覆盖 per-symbol 模式：某些 symbol 第一页未打满、某个 symbol 打满时，aggregate `truncated` 为 true，下一页对未打满 symbol 可返回空数组且不会重复第一页。
- [ ] 测试覆盖 account-scan 模式：过滤后结果可能少于 `limit`，但底层 account page 打满时仍返回 `truncated: true` / `nextPage`。
- [ ] 测试覆盖 Binance `tranId` 映射为 `venueTransactionId`、canonical decimal 和 stable sorting。
- [ ] README / docs/managers.md / docs/types.md / docs/errors.md 补充新接口、分页示例和全量拉取建议。

## Notes

- 不应把该能力命名为 `fetchFundingRateHistory`，避免与公开 funding rate 混淆。
- 如果未来需要查询 commission、realized pnl、transfer 等其它 income 类型，再考虑单独的 Income/Ledger manager；本任务只做 funding fee history。
