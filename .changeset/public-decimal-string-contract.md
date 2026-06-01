---
"@imbingox/acex": minor
---

公共 snapshot / market 数值字段（包括 `L1Book`、`FundingRateSnapshot`、`OrderSnapshot`、`BalanceSnapshot`、`PositionSnapshot`、`RiskSnapshot`、`MarketDefinition` 及 lending facets）由 `BigNumber` 改为 canonical 十进制 string。

这是破坏性 public contract 变更：`snapshot.bidPrice.minus(...)`、`.multipliedBy(...)` 等链式调用不再可用，消费者需要改为 `new BigNumber(field)` 自行解析后运算（SDK 仍保留 `export { BigNumber }`）。不要用 `parseFloat()` 解析这些字段，否则会退回 JS 浮点精度。输入侧 `DecimalInput` 不变，仍接受 string / number / `BigNumber`。
