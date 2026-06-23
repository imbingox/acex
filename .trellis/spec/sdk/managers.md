# Manager Contracts

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
- 调用方必须 `await lease.ready` 等待该 lease 的 logical subscription 被底层 stream / venue 接受。`lease.ready` 不保证 snapshot 已存在。
- 每次 acquire 返回独立 lease；`lease.close()` 只释放当前 lease，且必须幂等。
- 同一 `venue:symbol` + channel 只维护一条真实底层 `StreamHandle`；L1 book 与 funding rate 的 lease/ref-count 彼此独立。
- 最后一个 active lease 关闭时，manager 才关闭该 channel 的底层 stream，并把对应 snapshot status 标为 inactive。
- `client.stop()` 关闭所有底层 market websocket，但保留 active logical leases；`client.start()` 后按仍 active 的 leases 自动恢复底层 stream。
- stopped 期间调用 `lease.close()` 正常减少引用；某 channel 最后一个 lease 关闭后，后续 start 不再恢复该 channel。
- `MarketSubscriptionLease.ready` 是首次 ready barrier，不是可重置生命周期 signal；restart 后恢复状态通过 snapshot/status/events 观察。
- 对 L1 Book，`lease.ready` 在订阅 ACK / 等价订阅接受信号到达后 resolve。可确认属于该 pending subscription 的真实 top-of-book 如果先于 ACK 到达，也属于等价订阅接受信号。首条真实 top-of-book 到达后才创建 `L1Book`；two-sided、bid-only、ask-only 和四字段全 `null` 的 empty 都是可读 L1 state。
- Empty L1 Book 是 fresh/readable market state：`status.ready = true`、`freshness = "fresh"`、`reason` 为空。空盘口不得通过 status reason 表达。

### 4. Validation & Error Matrix

| 场景 | 结果 |
|---|---|
| client 未 started 时 acquire | `acquire*Subscription()` reject `CLIENT_NOT_STARTED`，不创建 lease |
| market 不存在 / inactive / venue 不支持 | `acquire*Subscription()` reject 对应 market error，且不创建 lease |
| funding rate 用在非 swap contract market | reject `MARKET_FUNDING_RATE_UNSUPPORTED` |
| subscribe ACK timeout / stream initial ready reject | `lease.ready` reject `MARKET_STREAM_TIMEOUT`，pending lease 自动释放，底层 stream 关闭并清空 |
| L1 ready 后暂时没有首条 quote | `lease.ready` 已 resolve，`getL1Book()` 仍可为 `undefined` |
| ACK 前收到可路由 quote data | 更新 `L1Book` 并 resolve 对应 `lease.ready`；后续 ACK success 幂等 |
| 收到 bid-only / ask-only / empty quote | getter 返回 nullable `L1Book`，并发布 `l1_book.updated` |
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
- README / `docs/quickstart.md` / `docs/managers.md` / live scripts / soak tests 使用 `acquire*Subscription()` + `lease.ready` + `lease.close()`。

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

## Scenario: AccountManager 查询账户实际资金费历史

### 1. Scope / Trigger

- Trigger: 新增或修改 `client.account.fetchFundingFeeHistory()`、账户级 funding fee history public type、private adapter income history contract、或 funding fee history pagination 语义时。
- 目标: 让下游查询账户实际发生的资金费收付流水，而不是公开 funding rate history；同时隐藏 Binance income history 不支持多 symbol 批量查询的细节。

### 2. Signatures

Public 类型放在 `src/types/account.ts`，并通过 `AccountManager` 暴露：

```ts
interface FetchFundingFeeHistoryInput {
  accountId: string;
  symbols?: string[];
  startTs?: number;
  endTs?: number;
  page?: number;
  limit?: number;
}

interface FundingFeeHistoryEntry {
  accountId: string;
  venue: Venue;
  symbol: string;
  asset: string;
  amount: string;
  fundingTime: number;
  receivedAt: number;
  venueTransactionId?: string;
  tradeId?: string;
  positionSide?: PositionSide;
  raw: Record<string, unknown>;
}

interface FetchFundingFeeHistoryResult {
  fees: FundingFeeHistoryEntry[];
  startTs?: number;
  endTs?: number;
  page: number;
  limit: number;
  truncated: boolean;
  nextPage?: number;
}
```

Adapter SPI 在 `PrivateUserDataAdapter` 上保持可选：

```ts
fetchFundingFeeHistory?(
  credentials: AccountCredentials,
  request: FetchFundingFeeHistoryRequest,
  accountOptions?: Record<string, unknown>,
): Promise<RawFundingFeeHistoryResult>;
```

### 3. Contracts

- `symbols === undefined` 表示全账户 account-scan；`symbols: []` 直接返回空结果且不得发远端请求。
- 去重后 `symbols.length <= 5` 时，manager 内部按 symbol 循环调用 context；`symbols.length > 5` 时，manager 走 account-scan 并在本地按 symbol 过滤。
- internal strategy 不属于 public contract，下游只使用 query-level `page` / `nextPage`。
- `page` 默认 1；`limit` 默认 1000，最大 1000。`limit` 是底层 request page size，不保证合并后的 `fees.length <= limit`。
- `truncated` 是 query-level 语义：
  - per-symbol 路径：任意底层 symbol result truncated，则 public result truncated。
  - account-scan 路径：底层 account page truncated，则 public result truncated，即使过滤后结果少于 `limit`。
  - `truncated === true` 时 `nextPage = page + 1`。
- Entries 必须按 `fundingTime`、`symbol`、`venueTransactionId ?? ""` 稳定排序；`amount` 必须在 manager 出口 canonical 化。
- 不生成 SDK synthetic id；Binance `tranId` 映射为 `venueTransactionId`，其它 venue 没有等价字段时可省略。
- Binance adapter 使用 `GET /papi/v1/um/income`，固定 `incomeType=FUNDING_FEE`，request weight 30，单 symbol 请求用 UM venue symbol，account-scan 不传 `symbol`。

### 4. Validation & Error Matrix

| 场景 | 行为 |
|---|---|
| client 未 start | 抛 `CLIENT_NOT_STARTED` |
| accountId 未注册 | 抛 `ACCOUNT_NOT_FOUND` |
| 缺 private credentials | 抛 `CREDENTIALS_MISSING`，不得发远端请求 |
| venue capability 或 adapter hook 不支持 | 抛 `VENUE_NOT_SUPPORTED` |
| `page < 1`、非整数、`limit < 1`、`limit > 1000`、时间戳非法或 `startTs > endTs` | 抛 `ACCOUNT_INPUT_INVALID`，不得发远端请求 |
| symbol 循环中任一 symbol 失败 | 整个调用失败，不返回 partial success |
| adapter 请求、响应结构、symbol mapping 或远端失败 | manager 包装为 `ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED`，保留 `cause` 和 `details.venue/accountId/symbol` |

### 5. Good / Base / Bad Cases

Good:

```ts
const result = await client.account.fetchFundingFeeHistory({
  accountId: "main-binance",
  symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  startTs,
  endTs,
  limit: 1000,
});
```

Base:

```ts
const endTs = Date.now();
let page = 1;

for (;;) {
  const result = await client.account.fetchFundingFeeHistory({
    accountId,
    symbols,
    startTs,
    endTs,
    page,
  });
  ingest(result.fees);
  if (!result.nextPage) break;
  page = result.nextPage;
}
```

Bad:

```ts
// 错误：把 truncated 理解为 ETH 这个 symbol 一定还有下一页。
if (result.truncated) {
  fetchOnlyEthNextPage();
}
```

### 6. Tests Required

修改该能力时至少覆盖：

- 本地输入校验失败不发远端请求。
- `symbols: []` 返回空结果且不调用 context。
- small symbol set 逐 symbol 调用；下一页仍用同一 query page 循环所有 symbol，未打满 symbol 返回空页可接受。
- account-scan + filter 下，过滤后结果少于 `limit` 时仍按底层 truncated 暴露 `nextPage`。
- `tranId` → `venueTransactionId`、canonical decimal、稳定排序。
- Binance adapter 固定 `incomeType=FUNDING_FEE`，单 symbol 请求带 `symbol`，account-scan 不带 `symbol`。
- `/papi/v1/um/income` rate-limit plan 使用 PAPI request-weight cost 30。
- runtime capability、缺 credentials、unsupported venue / missing hook 的错误路径。

### 7. Wrong vs Correct

#### Wrong

```ts
return {
  pageInfo: symbols.map((symbol) => ({
    symbol,
    truncated: symbolResult.fees.length === limit,
  })),
};
```

问题：account-scan 模式没有正确的 per-symbol completeness 语义；暴露该字段会误导下游按 symbol 分页。

#### Correct

```ts
return {
  fees,
  page,
  limit,
  truncated: rawResult.truncated,
  nextPage: rawResult.truncated ? page + 1 : undefined,
};
```

效果：所有内部查询路径都只暴露 query-level pagination，下游保持同一查询条件翻页即可。

## Scenario: 账户级 RiskLimitManager 维护交易所硬风控限制

### 1. Scope / Trigger

- Trigger: 新增或修改 `client.riskLimit` public API、risk limit 缓存语义、Binance PAPI UM leverage bracket / leverage REST 映射，或扩展其它 venue 的 risk tier / leverage 能力。
- 目标: 下游能按 `accountId + symbol` 读取 leverage tier / notional tier 缓存，并通过统一 API 设置 symbol leverage，同时不把仓位、挂单和手续费职责混入同一个 manager。

### 2. Signatures

Public manager 落点固定在 `src/types/risk-limit.ts`，并通过 `AcexClient.riskLimit` 暴露：

```ts
interface RiskLimitManager {
  getSymbolRiskLimit(input: GetSymbolRiskLimitInput): SymbolRiskLimitSnapshot;
  getSymbolRiskLimits(accountId?: string): SymbolRiskLimitSnapshot[];
  fetchSymbolRiskLimit(input: GetSymbolRiskLimitInput): Promise<SymbolRiskLimitSnapshot>;
  fetchRiskLimits(input: FetchRiskLimitsInput): Promise<SymbolRiskLimitSnapshot[]>;
  setSymbolLeverage(input: SetSymbolLeverageInput): Promise<SymbolLeverageUpdate>;
}
```

Snapshot 必须使用两个独立 facet：

```ts
interface SymbolRiskLimitSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  tiers: {
    source: "missing" | "venue";
    stale: boolean;
    receivedAt?: number;
    items: RiskLimitTier[];
    maxInitialLeverage?: string;
    notionalCoefficient?: string;
  };
  leverage: {
    lastSet?: SymbolLeverageUpdate;
  };
  updatedAt: number;
}
```

Adapter SPI 在 `PrivateUserDataAdapter` 上保持可选：

```ts
fetchSymbolRiskLimit?(credentials, request, accountOptions): Promise<RawSymbolRiskLimit>;
fetchRiskLimits?(credentials, request, accountOptions): Promise<RawSymbolRiskLimit[]>;
setSymbolLeverage?(credentials, request, accountOptions): Promise<RawSymbolLeverageUpdate>;
```

### 3. Contracts

- `RiskLimitManagerImpl` 持有 `Map<JSON.stringify([accountId, symbol]), RiskLimitRecord>`；缓存不得只按 symbol 共享。
- `getSymbolRiskLimit()` 是同步读缓存：未命中返回 `tiers.source: "missing"`、`tiers.stale: true`、`tiers.items: []`，不得发起 lazy 单 symbol REST 请求。
- 账户注册或 client 启动后，`RiskLimitManagerImpl` 必须调度账户级后台 worker；worker 对到期账户调用 `fetchRiskLimits({ accountId })` 全量刷新并批量写入该账户 symbol cache。
- 账户级后台刷新周期由 `CreateClientOptions.riskLimit.refreshIntervalMs` 控制，默认 5 分钟；这是 RiskLimitManager 的 manager 级策略，和 `CreateClientOptions.fee.refreshIntervalMs` 保持同一配置模型。
- `fetchSymbolRiskLimit()` / `fetchRiskLimits()` 是显式 REST 刷新，成功后写入 `tiers` facet。
- `setSymbolLeverage()` 成功后只写入 `leverage.lastSet` 和 `updatedAt`，不得把旧的 `tiers.stale` 改成 `false`。
- `leverage.lastSet` 只表示 SDK 最近一次 set leverage 成功响应，不代表账户真实当前杠杆；真实当前杠杆继续由 `AccountManager.position.leverage` 维护。
- 凭证更新必须 bump account generation，并把该账户已有 `tiers` 降级为 missing/stale，旧 in-flight risk limit 结果不得写回。
- 账户级 full refresh 的 in-flight 去重必须同时匹配 account generation 和 client runGeneration；凭证更新或 client restart 后，新的显式 `fetchRiskLimits()` 必须发起新请求，不能复用旧 generation 的 in-flight promise。
- 账户移除必须删除该账户全部 risk limit records。
- public decimal 输出必须是 canonical decimal string；adapter raw 层可提前 canonical，manager 出口仍必须 canonical。
- Binance PAPI UM endpoints:
  - `GET /papi/v1/um/leverageBracket`，request weight 1。
  - `POST /papi/v1/um/leverage`，request weight 1，`leverage` 为 1 到 125 的整数。
  - Binance `notionalCoef` 必须映射为 `snapshot.tiers.notionalCoefficient`，不能丢弃。
- Binance adapter 出站 symbol 必须复用 `toUsdmVenueIdForCommand()`；入站全量 risk limit 结果里仍无法映射的 venue symbol 不得写入主缓存，应复用 catalog miss report 机制。

### 4. Validation & Error Matrix

| 场景 | 行为 |
|---|---|
| client 未 started 时显式 fetch / set | `CLIENT_NOT_STARTED` |
| 未注册 accountId | `ACCOUNT_NOT_FOUND` |
| 缺 private credentials | `CREDENTIALS_MISSING` |
| adapter 未实现 risk limit 查询 / set leverage | `VENUE_NOT_SUPPORTED` |
| leverage 非整数、小于 1、或大于 125 | `RISK_LIMIT_INPUT_INVALID`，不得发远端请求 |
| risk limit REST / parse / venue error | manager 包装为 `RISK_LIMIT_FETCH_FAILED`，保留 `cause`、`details.transport`、`details.venueError` |
| set leverage REST / parse / venue error | manager 包装为 `LEVERAGE_SET_FAILED`，保留 `cause`、`details.transport`、`details.venueError` |
| 设置杠杆成功但 tier 已 stale | `leverage.lastSet` 更新，`tiers.stale` 保持原值 |
| 凭证更新期间旧请求完成 | generation check 丢弃旧结果；凭证更新后的显式 fetch 不等待旧请求，必须用新 generation 发起请求 |

### 5. Good / Base / Bad Cases

Good:

```ts
const risk = await client.riskLimit.fetchSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

if (risk.tiers.source === "venue" && !risk.tiers.stale) {
  // 用 risk.tiers.items / maxInitialLeverage 判断交易所硬限制
}

const leverage = await client.riskLimit.setSymbolLeverage({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  leverage: "4",
});
```

Base:

```ts
const cached = client.riskLimit.getSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

if (cached.tiers.source === "missing" || cached.tiers.stale) {
  // 调用方决定是否等待 explicit fetch；get 不阻塞也不发请求
}
```

Bad:

```ts
// 错误：把最近一次 SDK set leverage 结果当成账户真实当前杠杆
const currentLeverage = snapshot.leverage.lastSet?.leverage;
```

原因：账户真实当前杠杆仍以 `AccountManager.position.leverage` 为准，`lastSet` 只是本 SDK 调用成功回包。

### 6. Tests Required

修改 risk limit 相关 contract 时至少执行：

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- public `client.riskLimit` 从根入口可用，类型从 `src/types/index.ts` 导出。
- get 未命中返回 missing/stale 空 facet，且不触发单 symbol REST 请求。
- 账户注册 / client 启动后默认触发账户级 full refresh；后台 refresh 通过 `fetchRiskLimits()` 批量写入缓存。
- explicit fetch 写入 tier cache，且 `notionalCoefficient` 保留。
- set leverage 成功只更新 `leverage.lastSet`，不刷新 `tiers.stale`。
- leverage 非整数、低于 1、高于 125 都本地失败且不发 REST。
- `accountId + symbol` 缓存隔离、账户移除清理、凭证更新防旧结果写回，且凭证更新后的显式 full fetch 不复用旧 in-flight。
- Binance adapter 映射 leverage bracket / set leverage，并断言 PAPI request-weight plan 为 1。
- unsupported venue 和缺凭证场景返回稳定 `AcexError`。

### 7. Wrong vs Correct

#### Wrong

```ts
record.tiers.stale = false;
record.leverage.lastSet = update;
```

问题：设置杠杆成功不代表 leverage bracket / notional tier 数据被刷新。

#### Correct

```ts
record.leverage = { lastSet: update };
record.updatedAt = now;
// 保留 record.tiers 原状态
```

效果：下游可以独立判断 tier freshness 和最近一次 leverage 设置结果。
