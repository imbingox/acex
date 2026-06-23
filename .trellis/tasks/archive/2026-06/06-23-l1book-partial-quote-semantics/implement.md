# Implementation Plan

## Checklist

- [x] 更新 public market types
  - [x] 将 `L1Book` bid/ask price/size 改为 `string | null`。
  - [x] 不新增 `quoteState` 或其它冗余报价状态字段；four-state 从 nullable 字段推导。
  - [x] 从 `MarketDataStatus["reason"]` 移除 `"no_quote"`。

- [x] 更新 adapter SPI
  - [x] 修改 `src/adapters/types.ts` 的 `RawL1BookUpdate` 为 nullable scalar。
  - [x] 删除或停用 `RawL1NoQuoteUpdate` / `onNoQuote` 旧通道。
  - [x] 确认 `L1BookStreamCallbacks` 只通过 `onUpdate` 表达 four-state quote。

- [x] 更新 manager 行为
  - [x] `createL1Book()` 对非 null 数值 canonical 化，对 null 原样保留。
  - [x] `createL1Book()` 保持 bid price/size 与 ask price/size 各自成对为 string 或 null。
  - [x] 删除 `handleL1NoQuote()` 旧状态路径。
  - [x] 确认 `lease.ready` 在 first update（包括 empty）后 resolve。
  - [x] 确认 status ready / freshness / reason 不再依赖 `no_quote`。

- [x] 更新 Binance adapter
  - [x] `src/adapters/binance/adapter.ts` / `stream-protocol.ts` 输出四个非 null bid/ask 字段。
  - [x] 保持现有 bookTicker 行为和测试。

- [x] 更新 Deribit adapter
  - [x] `src/adapters/deribit/stream-protocol.ts` 将 quote payload 映射为 four-state nullable 字段组合：two-sided、bid-only、ask-only、empty。
  - [x] 确保四种 nullable 字段组合都走 multiplexer `data` route / `onUpdate`，不再通过 `status` route、`onNoQuote` 或 status-only callback 表达正常盘口状态。
  - [x] `src/adapters/deribit/adapter.ts` 不再调用 `onNoQuote`。
  - [x] 测试单边 quote 首包 resolve ready，并发布 `l1_book.updated`。
  - [x] 测试 empty 首包 resolve ready，book 四个 price/size 都为 null。
  - [x] 测试 two-sided -> bid-only -> ask-only -> empty -> two-sided transition 都发布 `l1_book.updated`、`version` 递增、getter 返回最新状态。
  - [x] 测试 heartbeat stale 后，下一条 empty / partial update 能恢复 `fresh`，且不写入 `reason: "no_quote"`。
  - [x] 测试 reconnect replay 后 partial / empty 仍走 data update 路径，不回退到旧 status-only 语义。

- [x] 更新使用点
  - [x] 修复 `scripts/live-order-smoke.ts` 中对 `book.bidPrice` 的非 null 假设。
  - [x] 修复 `scripts/live-market-smoke.ts`、`scripts/bench-market-tick.ts` 和 soak tests 中相关输出。
  - [x] 修复所有单元 / 集成测试 fixture 的 expected shape。

- [x] 更新文档和项目规范
  - [x] `README.md`
  - [x] `docs/quickstart.md`
  - [x] `docs/managers.md`
  - [x] `docs/types.md`
  - [x] `.trellis/spec/sdk/public-api.md`
  - [x] `.trellis/spec/sdk/managers.md`
    - [x] 替换旧的“ready 前 `no_quote` 不算 data / 不 resolve ready”段落。
  - [x] `.trellis/spec/sdk/adapters.md`
    - [x] 替换 `onNoQuote` contract 和“缺任一侧 quote 不发布 L1Book”的旧说明。
    - [x] 明确 `RawL1BookUpdate` nullable scalar，four-state nullable 组合都走 `onUpdate`。
  - [x] `.trellis/spec/sdk/venues/deribit.md`
    - [x] 替换 “only publish complete quote” 和旧 `status.reason = "no_quote"` 章节。

- [x] 残留语义审计
  - [x] `rg "no_quote|onNoQuote|RawL1NoQuote"`：除 changelog / 历史说明外，不应有新 runtime contract 残留。
  - [x] `rg "bidPrice|askPrice"`：检查 BigNumber 构造、脚本输出、fixtures、docs 示例是否都处理 null。
  - [x] 更新 `tests/unit/public-decimal-contract.test.ts` 或等价 public contract 测试，确认非 null decimal 仍 canonical，null 表示已知无该侧报价。

- [x] 新增 changeset
  - [x] `.changeset/<kebab-name>.md`
  - [x] bump 使用 `minor`，说明 beta breaking L1 Book nullable / ready 语义变化。

## Validation Commands

至少执行：

```bash
bun run lint
bun run type-check
bun test tests/unit/deribit-stream-protocol.test.ts
bun test --max-concurrency=1 tests/integration/deribit-market.test.ts
bun run test
```

如改动 live smoke 脚本，只做 type-check；真实网络 live smoke 不在默认验证中运行。

## Risk Points

- `book.bidPrice` / `book.askPrice` 变 nullable 后，任何 BigNumber 构造前都要检查 null。
- 删除 `"no_quote"` 会让旧文档、旧 spec 和测试同时失效；实现时要一次性收敛，避免新旧语义并存。
- `empty` book 的 `version` 应随收到的市场状态递增；否则下游可能看不到状态变化。
- 如果 Deribit 连续推送相同 empty 状态，事件是否重复发布沿用现有 stream 行为，不在本任务增加去重策略。

## Rollback

如实现中发现 nullable scalar 影响面过大，可回滚本任务全部代码和文档改动，保留 PRD/design 作为后续拆分依据。不要只回滚 public type 而保留 adapter/manager 的 partial quote 行为。
