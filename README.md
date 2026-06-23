# @imbingox/acex

`acex` 是一个面向交易系统的 **状态型** 多 venue SDK。调用方持有一个 `AcexClient`，通过统一的 `market` / `account` / `order` 等 manager 读取最新快照、消费增量事件、执行下单撤单命令；SDK 内部负责本地缓存、ready barrier、WebSocket 生命周期和自动重连。

## 当前支持能力

| 图标 | 状态 |
|---|---|
| ✅ | 支持 |
| ⚠️ | 部分支持 |
| ❌ | 不支持 |
| ➖ | 不适用 |

### Venue 总览

| Venue | Public market data | Private account |
|---|---|---|
| Binance | ✅ |  ✅  |
| Deribit | ⚠️ | ❌ |
| Juplend | ➖ | ✅ |

### Public market data

| Venue | Spot | Swap | Future | Option |
|---|---|---|---|---|
| Binance | ✅ | ✅ | ✅ | ❌ |
| Deribit | ❌ | ❌ | ❌ | ⚠️ |
| Juplend | ➖ | ➖ | ➖ | ➖ |

### Private account

| Venue | Spot | Margin | Swap | Future | Option | Lending |
|---|---|---|---|---|---|---|
| Binance | ❌ | ✅ | ✅ | ⚠️ | ❌ | ✅ |
| Deribit | ❌ | ❌ | ❌ | ❌ | ❌ | ➖ |
| Juplend | ➖ | ➖ | ➖ | ➖ | ➖ | ✅ |

Binance private account 还支持账户实际资金费流水查询：`client.account.fetchFundingFeeHistory()` 会返回 PAPI UM `FUNDING_FEE` income history，并在 [Manager API](./docs/managers.md#账户资金费历史) 中说明分页和去重建议。

## 安装

```bash
bun add @imbingox/acex
```

## 最小示例

```ts
import { createClient, type MarketSubscriptionLease } from "@imbingox/acex";

const client = createClient({ venues: ["binance"] });
let lease: MarketSubscriptionLease | undefined;

try {
  await client.start();

  lease = await client.market.acquireL1BookSubscription({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
  await lease.ready;

  const book = client.market.getL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  if (book) {
    console.log({
      hasBid: book.bidPrice !== null,
      bidPrice: book.bidPrice,
      hasAsk: book.askPrice !== null,
      askPrice: book.askPrice,
    });
  }
} finally {
  lease?.close();
  await client.stop();
}
```

## 文档入口

| 主题 | 文档 |
|---|---|
| 文档首页 | [docs/api.md](./docs/api.md) |
| 快速接入 | [docs/quickstart.md](./docs/quickstart.md) |
| 支持能力 | [docs/capabilities.md](./docs/capabilities.md) |
| Manager API | [docs/managers.md](./docs/managers.md) |
| 类型字段 | [docs/types.md](./docs/types.md) |
| 错误处理 | [docs/errors.md](./docs/errors.md) |
