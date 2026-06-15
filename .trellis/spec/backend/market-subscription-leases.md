# Market Subscription Leases

## Scenario: market websocket 订阅通过 per-consumer lease 管理生命周期

### 1. Scope / Trigger

- Trigger: 新增或修改 `MarketManager` 的 market websocket 订阅 API、L1 book / funding rate stream 生命周期、client stop/start 恢复语义。
- 目标: 多个上层消费者共享同一个 `AcexClient` 时，每个消费者持有独立 lease；一个消费者释放订阅不得误关其它消费者仍在使用的同一条 market stream。

### 2. Signatures

Public 类型放在 `src/types/market.ts`：

```ts
export interface AcquireL1BookSubscriptionInput extends MarketKeyInput {}

export interface AcquireFundingRateSubscriptionInput extends MarketKeyInput {}

export interface MarketSubscriptionLease {
  readonly ready: Promise<void>;
  close(): void;
}

export interface MarketManager {
  acquireL1BookSubscription(
    input: AcquireL1BookSubscriptionInput,
  ): Promise<MarketSubscriptionLease>;
  acquireFundingRateSubscription(
    input: AcquireFundingRateSubscriptionInput,
  ): Promise<MarketSubscriptionLease>;
}
```

旧 `subscribeL1Book()` / `unsubscribeL1Book()` / `subscribeFundingRate()` / `unsubscribeFundingRate()` 不再是 public `MarketManager` API。

### 3. Contracts

- `acquire*Subscription()` 只完成 client started 校验、market resolution、logical lease 注册和底层 stream 启动；不等待首条 market data。
- 调用方必须 `await lease.ready` 等待该 lease 的首次可用数据。
- 每次 acquire 返回独立 lease；`lease.close()` 只释放当前 lease，且必须幂等。
- 同一 `venue:symbol` + channel 只维护一条真实底层 `StreamHandle`；L1 book 与 funding rate 的 lease/ref-count 彼此独立。
- 最后一个 active lease 关闭时，manager 才关闭该 channel 的底层 stream，并把对应 snapshot status 标为 inactive。
- `client.stop()` 关闭所有底层 market websocket，但保留 active logical leases；`client.start()` 后按仍 active 的 leases 自动恢复底层 stream。
- stopped 期间调用 `lease.close()` 正常减少引用；某 channel 最后一个 lease 关闭后，后续 start 不再恢复该 channel。
- `MarketSubscriptionLease.ready` 是首次 ready barrier，不是可重置生命周期 signal；restart 后恢复状态通过 snapshot/status/events 观察。

### 4. Validation & Error Matrix

| 场景 | 结果 |
|---|---|
| client 未 started 时 acquire | `acquire*Subscription()` reject `CLIENT_NOT_STARTED`，不创建 lease |
| market 不存在 / inactive / venue 不支持 | `acquire*Subscription()` reject 对应 market error，且不创建 lease |
| funding rate 用在非 swap contract market | reject `MARKET_FUNDING_RATE_UNSUPPORTED` |
| 首条 market data timeout / stream initial ready reject | `lease.ready` reject `MARKET_STREAM_TIMEOUT`，pending lease 自动释放，底层 stream 关闭并清空 |
| 多个 pending leases 共享同一条初始 stream 且该 stream 失败 | 所有仍 pending 的相关 leases 都 reject，且引用不泄漏 |
| `lease.close()` 发生在 ready settle 前 | 当前 lease 释放，`lease.ready` reject 明确 close-before-ready 错误 |
| `lease.close()` 发生在 ready resolved 后 | 当前 lease 释放；不是最后一个 lease 时底层 stream 保持运行 |
| restart 恢复失败，lease 此前已 ready | 不自动释放 logical lease；发布 runtime error，状态转 stale/disconnected |

### 5. Good / Base / Bad Cases

#### Good

```ts
const lease = await client.market.acquireL1BookSubscription({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

try {
  await lease.ready;
  const book = client.market.getL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });
} finally {
  lease.close();
}
```

#### Base

```ts
const l1 = await client.market.acquireL1BookSubscription(key);
const funding = await client.market.acquireFundingRateSubscription(key);
await Promise.all([l1.ready, funding.ready]);

l1.close(); // funding stream stays active
```

#### Bad

```ts
await client.market.acquireL1BookSubscription(key);
const book = client.market.getL1Book(key);
```

问题：`acquire*Subscription()` 不等待首条数据；未等待 `lease.ready` 时 getter 可能还没有 snapshot。

### 6. Tests Required

修改 market websocket subscription 语义时至少覆盖：

- `Promise.all` 并发 acquire 同一 L1 / funding key，只创建一条底层 stream。
- close 非最后一个 lease 不关闭底层 stream；close 最后一个 lease 才关闭。
- close 幂等。
- 初始 ready timeout/failure 会 reject pending leases、关闭并清空底层 stream、允许后续 fresh acquire。
- ready 前 close 会 reject 当前 lease 的 `ready`，其它 active leases 不受影响。
- `client.stop()` 在 ready 前关闭底层 stream 但保留 lease；`client.start()` 后恢复并 resolve 原 lease ready。
- stopped 期间 close 最后一个 lease 后，后续 start 不恢复。
- L1 与 funding rate channel 独立，聚合 `MarketDataStatus` 不因关闭一个 channel 而误报另一个 active channel inactive。
- README / `docs/api.md` / live scripts / soak tests 使用 `acquire*Subscription()` + `lease.ready` + `lease.close()`。

### 7. Wrong vs Correct

#### Wrong

```ts
// 按 venue:symbol 保存一条 stream，然后任意消费者 unsubscribe 都直接 close。
record.l1BookStream?.close();
record.l1BookStream = undefined;
```

问题：共享 client 场景下，一个消费者退出会关闭其它消费者仍在使用的同一 symbol 订阅。

#### Correct

```ts
const lease = await client.market.acquireL1BookSubscription(key);
await lease.ready;

// 只释放当前消费者。只有最后一个 active lease close 后，manager 才关闭底层 stream。
lease.close();
```
