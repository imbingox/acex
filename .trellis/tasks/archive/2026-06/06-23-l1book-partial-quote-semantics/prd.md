# Redesign L1 book partial quote semantics

## Goal

重新设计 SDK 的 L1 Book 语义，使 `L1Book` 能表达单边报价和空盘口状态，支持 Deribit option 等低流动性市场下的方向性可成交判断。

## Background

当前 `L1Book` 的 public contract 要求 `bidPrice` / `bidSize` / `askPrice` / `askSize` 都是非 nullable `string`。Deribit `quote.<instrument>` adapter 只有在 bid/ask price 和 size 全部存在、有限且为正数时才发布 `L1Book`；缺任意一边都会被归为 `no_quote` status，并且首包缺边时 `lease.ready` 不 resolve，最终可能超时并自动释放 lease。

这对期权、冷门市场和方向性执行逻辑不够合理：只有 bid 或只有 ask 也是有效市场状态，分别代表可卖出或可买入的一侧报价。把单边报价当成 `no_quote` 会丢失方向性可成交信号，并可能诱导下游对长期单边/空盘口 symbol 频繁重订。

## Confirmed Facts

- 当前 `L1Book` public type 在 `src/types/market.ts` 中使用非 nullable scalar 字段。
- 当前 adapter-facing `RawL1BookUpdate` 也使用非 nullable scalar 字段。
- 当前 Deribit parser 在缺少任意 bid/ask price 或 size、数量非正、价格非有限时返回 `reason: "no_quote"` status。
- 当前 `lease.ready` 表示首份可读 `L1Book` 到达；如果首条可读数据超时，会 reject 并释放该 lease。
- Binance book ticker 正常提供双边报价；改动必须保持该 venue 的现有行为。
- 当前文档已临时补充现有 `no_quote` 行为，但本任务会把文档更新到新的长期 contract。

## Requirements

- `L1Book` 必须能表达双边报价、仅 bid、仅 ask、两边都空四种 top-of-book 状态。
- `bidPrice` / `bidSize` / `askPrice` / `askSize` 应改为 nullable scalar：`string | null`。
- 不新增 `quoteState` public 字段；报价形态必须从 nullable bid/ask 字段直接推导，避免两个状态源并存。
- 单边报价必须作为 `L1Book` 更新发布，并可通过 `getL1Book()` 读取；不得因缺少另一侧报价而走旧的 status-only / no-quote 路径。
- 空盘口状态也应作为可解释的市场状态进入 `L1Book`，避免仅因当前无报价导致订阅被释放和下游频繁重订。
- `lease.ready` 语义应调整为收到第一份可解释的 top-of-book 状态后 resolve，而不是等待完整双边报价。
- `status.reason` 必须彻底移除 public `"no_quote"` 语义；空盘口由四个 nullable bid/ask 字段全为 `null` 表达。
- 本任务按 beta breaking change 处理，不为旧的 `status.reason: "no_quote"` 语义保留兼容写入路径。
- 文档必须说明 nullable 字段的交易含义：有 ask 表示可买入该腿，有 bid 表示可卖出该腿，两边都 null 表示当前无可执行报价。
- 所有受影响的测试、fixtures、live smoke / bench 脚本和文档示例必须同步处理 nullable 字段。

## Acceptance Criteria

- [ ] Public `L1Book` type 支持 nullable bid/ask scalar，不新增冗余报价状态字段。
- [ ] Adapter raw L1 update contract 能表达单边和空盘口状态。
- [ ] Deribit quote parser 将 bid-only、ask-only、empty 分别映射为对应 nullable `L1Book` 字段组合。
- [ ] Deribit 单边或空盘口首包会让 `lease.ready` resolve，并保持 lease active。
- [ ] Public status reason union 移除 `"no_quote"`，运行时不再发布 `reason: "no_quote"`。
- [ ] Binance 双边 L1 行为保持兼容，测试仍覆盖现有 book ticker 流程。
- [ ] 下游使用 `book.bidPrice` / `book.askPrice` 的内部脚本、测试和文档示例都处理 null。
- [ ] 文档说明新语义、方向性可成交判断方式，以及 breaking change / beta migration 注意事项。
- [ ] 新增 `.changeset/*.md`，按 0.x beta breaking public contract 使用 `minor` bump。
- [ ] 质量检查通过：`bun run lint`、`bun run type-check`、相关 unit / integration tests。

## Out Of Scope

- 不新增 L2/depth book。
- 不实现执行策略逻辑或跨 venue spread 计算。
- 不新增 Deribit Greeks / IV / mark price 支持。
- 不改变 Binance 原始订阅 channel。

## Decisions

- `status.reason: "no_quote"` 从 public API 语义中彻底移除；空盘口使用四个 bid/ask nullable 字段全为 `null` 表达，单边报价通过一侧非 null、另一侧为 null 表达。
- 不新增 `quoteState` public 字段；nullable scalar 是唯一状态源。
- 本任务接受 beta breaking change，不新增兼容 helper，也不继续写入 deprecated `no_quote` reason。

## Open Questions

- 无。
