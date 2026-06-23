# Design: L1 book partial quote semantics

## Summary

把 `L1Book` 从“完整双边报价快照”改为“最新 top-of-book 状态快照”。缺失一侧报价用 nullable scalar 表达；`status.reason` 不再承载正常报价形态，也不再包含 `"no_quote"`。不新增 `quoteState` 字段，避免 nullable 字段和状态字段出现两个事实源。

## Public Contract

目标 public shape：

```ts
export interface L1Book {
  venue: Venue;
  symbol: string;
  bidPrice: string | null;
  bidSize: string | null;
  askPrice: string | null;
  askSize: string | null;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
  status: MarketDataStreamStatus;
}
```

`MarketDataStatus["reason"]` / `MarketDataStreamStatus["reason"]` 移除 `"no_quote"`。正常市场报价状态直接从 nullable 字段推导：

- two-sided: bid 和 ask 都存在，可双向判断。
- bid-only: 只有 bid；可按 bid 卖出该腿。
- ask-only: 只有 ask；可按 ask 买入该腿。
- empty: bid/ask 都不存在；当前无可执行报价。

字段 invariant 必须严格成对：

| Derived shape | `bidPrice` | `bidSize` | `askPrice` | `askSize` |
|---|---|---|---|---|
| two-sided | `string` | `string` | `string` | `string` |
| bid-only | `string` | `string` | `null` | `null` |
| ask-only | `null` | `null` | `string` | `string` |
| empty | `null` | `null` | `null` | `null` |

不得出现 price 非 null 但 size 为 null，或 size 非 null 但 price 为 null。side validity 必须按“price 有限且大于 0，并且 size 有限且大于 0”整体判定；任一字段无效时该侧 price/size 成对置 `null`。

## Adapter Contract

`RawL1BookUpdate` 同步改为 nullable scalar。adapter 仍输出 decimal string 或 `null`；manager 出口只对非 null 数值调用 `toCanonical()`。

Deribit `quote.<instrument>` parser 规则：

- price 有限且大于 0，size 有限且大于 0 时，该侧有效。
- bid 侧有效、ask 侧有效：四个字段均为 string。
- 仅 bid 侧有效：bid 字段为 string，ask 字段为 null。
- 仅 ask 侧有效：ask 字段为 string，bid 字段为 null。
- 两侧都无效：四个字段均为 null。
- 以上四种都必须走 multiplexer `data` route，并作为 `RawL1BookUpdate` 通过 `onUpdate` 进入 manager。正常盘口状态不得再通过 `routeMessage: "status"`、`onNoQuote` 或任何 status-only callback 表达，否则 `lease.ready` 和事件流会继续沿用旧超时语义。

Binance bookTicker 正常仍产生四个字段均为 string 的 two-sided 快照。

## Manager Behavior

`lease.ready` 改为首份可解释 top-of-book 状态到达后 resolve。`empty` 也是可解释状态，因此不会因为 Deribit 长期空盘口而自动释放 lease。

`l1_book.updated` 在 top-of-book 状态到达时发布，包括单边 quote 或四字段全 null 的 empty book。`getL1Book()` 返回最新状态。

`status.ready` 表示已经有该 stream 的市场状态，不表示双边可交易。`empty` 是 fresh/readable market state：收到 empty update 后 `status.ready = true`、`status.freshness = "fresh"`、`status.reason` 为空。连接断线 / heartbeat timeout / reconciling 这类运行时问题才通过 `status.freshness = "stale"` 和 `status.reason` 表达。

`handleL1NoQuote()` 和 `RawL1NoQuoteUpdate` 可删除，或先作为内部过渡但不能再影响 public status。推荐直接删除，避免旧语义继续存在。

## Compatibility

这是 beta breaking change：

- `book.bidPrice` / `book.askPrice` 从 `string` 变为 `string | null`。
- `status.reason` union 移除 `"no_quote"`。
- `lease.ready` 对 L1 Book 的含义从“首份完整双边 book”变为“首份 top-of-book 状态”。

需要新增 `.changeset/*.md`，按当前 pre-1.0 beta 策略使用 `minor`。

## Documentation

更新用户文档：

- `docs/quickstart.md`: `lease.ready` 语义和 nullable 字段用法。
- `docs/managers.md`: 状态字段、Deribit option L1、批量订阅建议。
- `docs/types.md`: nullable scalar 及其 four-state 推导规则。
- `README.md`: 示例避免直接假设 bid/ask 都存在。

更新项目规范：

- `.trellis/spec/sdk/public-api.md`: public decimal string 字段可以是 `string | null`，null 表示已知无该侧报价。
- `.trellis/spec/sdk/managers.md`: 移除旧 `no_quote` ready/status contract。
- `.trellis/spec/sdk/adapters.md`: `RawL1BookUpdate` nullable scalar，删除 `onNoQuote` 旧语义。
- `.trellis/spec/sdk/venues/deribit.md`: Deribit 单边/empty quote 映射新 contract。

## Risks

- 内部脚本和测试中直接 `new BigNumber(book.bidPrice)` 的调用必须先做 null check。
- 文档刚补的旧 `no_quote` 说明会被本任务替换；实现时不要保留相互矛盾的段落。
- 四字段全 null 的 empty book 是否频繁发布取决于交易所推送频率；事件流已有 conflate 机制，仍需测试慢消费者场景不被破坏。
