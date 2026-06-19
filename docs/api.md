# @imbingox/acex API 使用手册

本文面向 SDK 下游调用方：策略服务、风控面板、交易执行器和数据采集进程。目标是说明如何正确持有 `AcexClient`、查询当前 runtime 能力、订阅状态型数据、执行订单命令，以及在接入时处理错误和限制。

## 目录

- [1. 当前能力](#1-当前能力)
- [2. 快速接入](#2-快速接入)
- [3. 核心概念](#3-核心概念)
- [4. Client 生命周期](#4-client-生命周期)
- [5. MarketManager](#5-marketmanager)
- [6. AccountManager](#6-accountmanager)
- [7. OrderManager](#7-ordermanager)
- [8. FeeManager](#8-feemanager)
- [9. RiskLimitManager](#9-risklimitmanager)
- [10. 健康与错误事件](#10-健康与错误事件)
- [11. 数据类型速查](#11-数据类型速查)
- [12. 错误处理](#12-错误处理)
- [13. 当前限制](#13-当前限制)

## 1. 当前能力

`@imbingox/acex` 是状态型多 venue SDK。调用方创建一个 `AcexClient`，通过 `market` / `account` / `order` / `fee` / `riskLimit` 五个 manager 读取最新快照、消费事件流、执行命令、查询手续费费率和交易所硬风控限制；SDK 内部维护本地缓存、ready barrier、WebSocket 生命周期、自动重连、REST timeout / retry / 错误脱敏和 reactive rate limiter。

当前 runtime 落地：

| Venue | Market | Account | Order |
|---|---|---|---|
| `binance` | Spot / USDⓈ-M / COIN-M catalog（含 TradFi Perps）；L1 Book；永续 funding rate；历史 funding rate；USDM server time | PAPI UM 私有账户流 + REST risk refresh | PAPI UM `limit` / `market` 下单、撤单、按 symbol 全撤 |
| `juplend` | 不支持 | Jupiter Lend 只读账户 polling | 不支持，read-only |
| `okx` / `bybit` / `gate` | 类型占位 | 类型占位 | 类型占位 |

FeeManager 当前可对 Binance `swap` 通过 PAPI UM `commissionRate` 读取账号级真实费率；其他 venue 或 Binance spot/future 先返回默认费率。

RiskLimitManager 当前可对 Binance PAPI UM 读取 leverage bracket / notional tier，缓存按账户全量后台刷新，并支持设置 symbol leverage。其他 venue 会明确抛 `VENUE_NOT_SUPPORTED`。

## 2. 快速接入

### 2.1 安装和初始化

```bash
bun add @imbingox/acex
```

```ts
import { createClient } from "@imbingox/acex";

const client = createClient();

await client.start();
// ... use client.market / client.account / client.order
await client.stop();
```

`createClient()` 不建立网络连接。`start()` 后才能调用订阅类方法；`loadMarkets()`、`reloadMarkets()`、`fetchServerTime()`、`fetchPublicTrades()`、`fetchPublicRawTrades()`、`fetchFundingRateHistory()` 和 capability 查询不要求 client 已 start。

### 2.2 订阅 Binance L1 Book

```ts
await client.start();

const l1Lease = await client.market.acquireL1BookSubscription({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});
try {
  await l1Lease.ready;

  const book = client.market.getL1Book({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  });

  console.log(book?.bidPrice, book?.askPrice, book?.status.freshness);

  for await (const event of client.market.events.l1BookUpdates({
    venue: "binance",
    symbol: "BTC/USDT:USDT",
  })) {
    console.log(event.snapshot.bidPrice);
    break;
  }
} finally {
  l1Lease.close();
}
```

`acquireL1BookSubscription()` 只完成输入校验、market resolution 和 logical lease 注册；`lease.ready` 会等待该 lease 的首条有效数据到达后 resolve。首条数据超时会 reject `MARKET_STREAM_TIMEOUT`，并自动释放该 lease。释放订阅时调用 `lease.close()`，该方法幂等；只有最后一个 active lease 关闭后，SDK 才会关闭底层 websocket stream。

### 2.3 注册 Binance 交易账户

```ts
await client.registerAccount({
  accountId: "main-binance",
  venue: "binance",
  credentials: {
    apiKey: process.env.BINANCE_PAPI_API_KEY,
    secret: process.env.BINANCE_PAPI_SECRET,
  },
  options: {
    recvWindow: 5_000,
  },
});

await client.start();

await client.account.subscribeAccount({ accountId: "main-binance" });
await client.order.subscribeOrders({ accountId: "main-binance" });

const risk = client.account.getRiskSnapshot("main-binance");
const openOrders = client.order.getOpenOrders("main-binance");
```

Binance 账户能力当前面向 PAPI UM。账户风险字段会由私有 WS 事件和 `/papi/v1/account` + `/papi/v1/um/positionRisk` REST refresh 共同维护；默认每 60s 还会用 `/papi/v1/balance`、`/papi/v1/account`、`/papi/v1/um/positionRisk` 和订单 REST 接口做 private reconcile。Binance 全账户 `/papi/v1/um/openOrders` 不带 symbol 时 request weight 较高，默认 60s 是保守值。读取余额、仓位或风险数据时必须订阅 `client.account.subscribeAccount()`；`client.order.subscribeOrders()` 只维护订单缓存，即使底层复用同一条 private WS，也不会维护 account 仓位缓存。

### 2.4 读取 Binance 风控档位并设置杠杆

```ts
const cached = client.riskLimit.getSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

if (cached.tiers.source === "missing" || cached.tiers.stale) {
  await client.riskLimit.fetchRiskLimits({ accountId: "main-binance" });
}

const snapshot = client.riskLimit.getSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

const leverage = await client.riskLimit.setSymbolLeverage({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  leverage: "4",
});
```

`getSymbolRiskLimit()` 只读本地缓存，不发 REST；未命中时返回 `tiers.source: "missing"` / `stale: true`。client 启动后会按账户周期性全量刷新 risk limit cache；需要等待最新交易所数据时调用 `fetchRiskLimits()` 或 `fetchSymbolRiskLimit()`。

### 2.5 注册 Juplend 只读账户

```ts
const client = createClient({
  account: {
    venues: {
      juplend: {
        pollIntervalMs: 30_000,
        rpcUrl: process.env.SOL_HELIUS_RPC,
        jupApiKey: process.env.JUP_API,
      },
    },
  },
  fee: {
    refreshIntervalMs: 24 * 60 * 60 * 1000,
    defaultRates: {
      binance: {
        swap: { maker: "0.0002", taker: "0.0005" },
      },
    },
  },
});

await client.registerAccount({
  accountId: "jup-loop-a",
  venue: "juplend",
  options: {
    walletAddress: "<solana-wallet-address>",
    positionId: "<optional-nft-position-id>",
  },
});

await client.start();
await client.account.subscribeAccount({ accountId: "jup-loop-a" });

const balances = client.account.getBalances("jup-loop-a");
const risk = client.account.getRiskSnapshot("jup-loop-a");
```

也可以用已知 vault + position 直接读取单仓，不扫全钱包：

```ts
await client.registerAccount({
  accountId: "jup-loop-direct",
  venue: "juplend",
  options: {
    vaultId: "<vault-id>",
    positionId: "<nft-position-id>",
  },
});
```

Juplend 不需要私钥，不支持 supply / borrow / repay / withdraw。`accountId` 是 SDK 内的逻辑账户名，不是钱包地址。

### 2.6 下单和撤单

```ts
const order = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "60000",
  amount: "0.001",
  postOnly: true,
  clientOrderId: "strategy-001",
  positionSide: "long",
});

const canceled = await client.order.cancelOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  clientOrderId: "strategy-001",
});

const batch = await client.order.cancelAllOrders({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});
```

下单命令由 `accountId` 对应的 venue 决定，不在 order input 里再传 venue。Juplend 和 type-only venue 会被 runtime 拒绝。

## 3. 核心概念

### 3.1 Stateful client

`AcexClient` 是长生命周期对象。manager 内部持有快照、状态、事件总线和订阅句柄。下游服务应复用同一个 client，而不是每次读取都重新创建。

### 3.2 Ready barrier

`acquire*Subscription()` 返回 lease 后，调用方用 `lease.ready` 等待第一份可读快照：

```ts
const lease = await client.market.acquireL1BookSubscription({
  venue: "binance",
  symbol,
});
try {
  await lease.ready;
  const snapshot = client.market.getL1Book({ venue: "binance", symbol });
} finally {
  lease.close();
}
```

如果首条数据迟迟不到，`lease.ready` 会 reject，SDK 会自动释放该 lease。稳态期间断线不会清空旧快照；快照上的 `status.freshness` 会转为 `stale`。行情多路复用连接健康时，单个 symbol 长时间没有新盘口推送不会被标记为 `stale`；这通常表示盘口未变化，若需要 per-symbol 活跃度请用 `lastReceivedAt` 自行计算 age。

### 3.3 Decimal string

所有 public snapshot / market 数值字段都是 canonical decimal string：无损、无科学计数法、不补尾零。SDK 仍 re-export `BigNumber` 作为下游计算工具：

```ts
import { BigNumber } from "@imbingox/acex";

const book = client.market.getL1Book({ venue: "binance", symbol });
const spread = new BigNumber(book!.askPrice).minus(book!.bidPrice);
```

不要用 `parseFloat()` 处理金额、数量、价格和比率。`createOrder()` 的 `price` / `amount` 必须传 decimal string；`normalizeOrderInput()` 的 `DecimalInput` 可接受 string / number / `BigNumber`。

### 3.4 状态字段

常见状态字段：

| 字段 | 语义 |
|---|---|
| `activity` | `"active"` 表示当前订阅活跃；`"inactive"` 表示已退订或停止 |
| `ready` | 是否已有首份可读数据 |
| `freshness` | market stream 新鲜度：`"fresh"` / `"stale"` / `"reconciling"` |
| `runtimeStatus` | private stream 状态：`"bootstrap_pending"` / `"healthy"` / `"degraded"` / `"reconnecting"` / `"reconciling"` / `"stopped"` |
| `reason` | 状态原因，如 `credentials_missing`、`http_failed`、`rate_limited`、`ws_disconnected` |

退订后旧快照仍可读，但不再代表实时值。

## 4. Client 生命周期

### 4.1 `createClient(options?)`

```ts
const client = createClient({
  clock: {
    now: () => Date.now(),
  },
  onMetric(name, value, type, tags) {
    metrics.record(name, value, type, tags);
  },
  market: {
    l1InitialMessageTimeoutMs: 15_000,
    l1StaleAfterMs: 15_000,
    l1ReconnectDelayMs: 1_000,
    l1ReconnectMaxDelayMs: 10_000,
  },
  account: {
    streamOpenTimeoutMs: 15_000,
    streamReconnectDelayMs: 1_000,
    streamReconnectMaxDelayMs: 10_000,
    venues: {
      binance: {
        riskPollIntervalMs: 5_000,
        privateReconcileIntervalMs: 60_000,
        privateStreamStaleAfterMs: 65 * 60_000,
        listenKeyKeepAliveMs: 30 * 60_000,
      },
      juplend: {
        pollIntervalMs: 30_000,
        rpcUrl: process.env.SOL_HELIUS_RPC,
        jupApiKey: process.env.JUP_API,
      },
    },
  },
  riskLimit: {
    refreshIntervalMs: 5 * 60 * 1000,
  },
});
```

`clock` 只用于 outbound request / signing timestamp，不驱动 WebSocket freshness 的 received-at 时钟。需要自定义 REST 限流行为时可传 `rateLimiter`，否则使用默认 bucket-aware budget limiter：它会注册 Binance REST topology，在 `beforeRequest` 中按固定窗口和 `rateLimit.utilizationTarget`（默认 0.9）主动预扣预算，接近上限时 sleep 到下一窗口；Binance PAPI request-weight 桶为 `priority:"cancel"` 保留 headroom，撤单请求仍计入真实 weight 但可使用保留区；risk limit 设置杠杆请求使用 `priority:"risk"`。响应后的 Binance usage header 会回填校正 bucket 用量，429/418 block 也会落到对应 bucket，缺少 `Retry-After` 的 429 会冷却到窗口结束并带小 jitter。Binance `account.venues.binance.riskPollIntervalMs` 默认 5s，用于风险和 mark-to-market 仓位刷新；`account.venues.binance.privateReconcileIntervalMs` 默认 60s，用于账户余额、仓位和订单状态 REST 对账，显式传 `0` 可关闭 private reconcile，但不关闭 risk polling。`riskLimit.refreshIntervalMs` 默认 5 分钟，用于账户级 leverage bracket / notional tier 全量后台刷新。Juplend 只使用 `account.venues.juplend.pollIntervalMs` 驱动 adapter polling，不继承 Binance 的 reconcile/risk polling 默认。`onMetric` 是同步可观测性钩子；callback 抛错会被 SDK 吞掉，不会打断下单、订阅或事件发布流程。未传 `onMetric` 时，热路径不会计算 latency 或构造 tags。`sandbox`、`logger`、`logLevel` 目前是预留位。

### 4.1.1 Metrics

```ts
import { METRIC_NAMES, type MetricType, type OnMetric } from "@imbingox/acex";

const onMetric: OnMetric = (name, value, type, tags) => {
  metrics.record(name, value, type, tags);
};

const client = createClient({ onMetric });
```

| name | type | tags | 触发时机 |
|---|---|---|---|
| `order.command.rtt` | `timing` | `venue`, `op` (`create` / `cancel` / `cancelAll`), `accountId`, `outcome` (`success` / `error`) | `order.createOrder()` / `cancelOrder()` / `cancelAllOrders()` 的 private command await 完成或失败后；value 为单调时钟 RTT 毫秒 |
| `ws.message.latency` | `timing` | L1: `venue`, `channel=l1book`, `symbol`; private: `venue`, `channel=account|order`, `accountId` | WebSocket update 带 `exchangeTs` 时；value 为 `receivedAt - exchangeTs` 毫秒 |
| `ws.reconnect` | `counter` | `venue`, `channel` (`private`, `l1book`, `fundingRate`) | 已建立过的 private 或 market WebSocket 再次 open 时 |
| `event.buffer.overflow` | `counter` | `stream` | `AsyncEventBus` buffer 模式慢消费者超过 `maxBuffer` 并丢弃最旧事件时 |

### 4.2 `start()` / `stop()`

```ts
await client.start();
await client.stop();
```

状态机是 `idle → starting → running → stopping → stopped`。`start()` 和 `stop()` 幂等。

`stop()` 默认执行 graceful drain：先把 client 状态切到 `stopping`，拒绝新的订单命令，然后等待已在途的 `createOrder()` / `cancelOrder()` / `cancelAllOrders()` 以及私有账户/订单 refresh、reconcile 完成；`timeoutMs` 默认 5000ms，超时后继续关闭流、timer 和 lifecycle。传 `{ graceful: false }` 会跳过等待并立即执行 teardown。

### 4.3 Venue capabilities

```ts
const binance = client.getVenueCapabilities("binance");
const all = client.listVenueCapabilities();
```

Capability 查询不访问网络，不要求 `start()`。返回值表达当前 SDK runtime 已实现能力，不代表交易所官网完整能力，也不检查 API key 权限。

当前摘要：

| Venue | runtimeStatus | readOnly | 关键能力 |
|---|---|---:|---|
| `binance` | `available` | false | market catalog / server time / L1；funding rate 为 `market_dependent`；order supported |
| `juplend` | `available` | true | account polling + lending；order reason 为 `read_only` |
| `okx` / `bybit` / `gate` | `type_only` | false | runtime 未接入，order reason 为 `not_implemented` |

下游应先查 capability 再展示或启用功能：

```ts
if (!client.getVenueCapabilities("juplend").order.supported) {
  // 不展示下单按钮
}
```

### 4.4 账户管理

```ts
await client.registerAccount(input);
await client.updateAccountCredentials("main-binance", { apiKey, secret });
await client.removeAccount("main-binance");
```

`RegisterAccountInput` 按 venue 区分。CEX venue 使用 `AccountCredentials`；Juplend 必须显式提供 `walletAddress` 或 `vaultId + positionId`。虽然 public `Venue` 包含 type-only venue，但注册成功不代表该 venue runtime 能订阅或下单，仍以 capability 和实际调用结果为准。

## 5. MarketManager

```ts
interface MarketManager {
  readonly events: MarketEventStreams;

  loadMarkets(): Promise<void>;
  reloadMarkets(venue?: Venue): Promise<MarketCatalogReloadSummary[]>;
  fetchServerTime(venue: Venue): Promise<VenueServerTime>;
  fetchPublicTrades(
    input: FetchPublicTradesInput,
  ): Promise<FetchPublicTradesResult>;
  fetchPublicRawTrades(
    input: FetchPublicRawTradesInput,
  ): Promise<FetchPublicRawTradesResult>;
  fetchFundingRateHistory(
    input: FetchFundingRateHistoryInput,
  ): Promise<FetchFundingRateHistoryResult>;

  listMarkets(venue?: Venue): MarketDefinition[];
  getMarket(venue: Venue, symbol: string): MarketDefinition | undefined;
  getMarkets(symbol: string): MarketDefinition[];
  normalizeOrderInput(input: NormalizeOrderInputInput): NormalizedOrderInput;

  acquireL1BookSubscription(input: AcquireL1BookSubscriptionInput): Promise<MarketSubscriptionLease>;
  getL1Book(key: MarketKeyInput): L1Book | undefined;
  getL1Books(symbol: string): L1Book[];

  acquireFundingRateSubscription(input: AcquireFundingRateSubscriptionInput): Promise<MarketSubscriptionLease>;
  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined;
  getFundingRates(symbol: string): FundingRateSnapshot[];

  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined;
}

interface MarketSubscriptionLease {
  readonly ready: Promise<void>;
  close(): void;
}
```

### 5.1 Market catalog

`loadMarkets()` 懒加载所有已实现 market runtime 的 venue 目录；`reloadMarkets(venue?)` 主动刷新目录，返回新增/移除/总数/错误摘要。订阅方法会自动确保对应 venue 的 catalog 已加载。

```ts
await client.market.loadMarkets();
const markets = client.market.listMarkets("binance");
const market = client.market.getMarket("binance", "BTC/USDT:USDT");
```

`MarketDefinition` 里的 `priceStep`、`amountStep`、`contractSize`、`minAmount`、`minNotional` 都是 decimal string。

Binance TradFi Perps 会按 USDⓈ-M 永续合约暴露，例如 `AAPLUSDT` 归一为 `AAPL/USDT:USDT`，可使用同一套 L1 Book 与 Funding Rate 订阅接口。

### 5.2 订单输入归一

```ts
const normalized = client.market.normalizeOrderInput({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  price: "60000.123",
  amount: "0.001234",
});

if (!normalized.accepted) {
  console.log(normalized.rejectReason);
}
```

`normalizeOrderInput()` 会按 `priceStep` / `amountStep` 向下取整，并检查 `minAmount` / `minNotional`。它不会自动帮你下单，调用方需要把归一后的 string 放入 `createOrder()`。

### 5.3 Server time

```ts
const time = await client.market.fetchServerTime("binance");
console.log(time.serverTime, time.roundTripMs, time.estimatedOffsetMs);
```

当前 Binance server time 测量源固定为 USDⓈ-M REST `/fapi/v1/time`。失败会包装为 `MARKET_SERVER_TIME_FETCH_FAILED`。

### 5.4 Public trades

```ts
const result = await client.market.fetchPublicTrades({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  startTs: 1710000000000,
  endTs: 1710000000600,
});

for (const trade of result.trades) {
  console.log(trade.id, trade.price, trade.amount, trade.side, trade.exchangeTs);
}
```

`fetchPublicTrades()` 查询公开市场成交，不是账号成交。当前 Binance 实现走 `aggTrades`，返回的是聚合成交：`PublicTrade.id` 是 aggregate trade id，`raw` 中保留 Binance 原始 `a/f/l/T/m` 等字段。`startTs` 必填，`endTs` 是排他上界；`endTs` 和 `limit` 至少传一个。只传 `limit` 时，从 `startTs` 开始返回最多 N 条；只传 `endTs` 时返回 `[startTs, endTs)` 内成交，adapter 会使用安全上限；两者都传时同时生效，返回时间窗口内最多 `limit` 条。命中上限时 `truncated = true`。

```ts
const raw = await client.market.fetchPublicRawTrades({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  startTs: 1710000000000,
  limit: 100,
});
```

`fetchPublicRawTrades()` 查询 Binance 逐笔 raw public trades，内部先用 `aggTrades` 按 `startTs` 定位起始 raw trade id，再带 `X-MBX-APIKEY` 调 `historicalTrades`，并按 raw trade 的 `time` 做 `[startTs, endTs)` 本地过滤。SDK 不会把用户的完整 `endTs` 窗口传给 locator 请求；如果定位到的首条 aggregate trade 已晚于 `endTs`，会返回空结果。该方法需要 Binance market API key；可通过 `createClient({ market: { venues: { binance: { apiKey } } } })` 显式传入，未显式传入时默认读取 `BINANCE_MARKET_API_KEY`。缺少 key 会在加载 market catalog 前本地失败并包装为 `MARKET_PUBLIC_TRADES_FETCH_FAILED`。可查询范围同时受 Binance `aggTrades` locator 与 `historicalTrades`/MARKET_DATA 端点自身的数据可用性限制。

### 5.5 Funding rate history

```ts
const history = await client.market.fetchFundingRateHistory({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  startTs: 1710000000000,
  endTs: 1710100000000,
  limit: 100,
});

for (const rate of history.rates) {
  console.log(rate.fundingRate, rate.fundingTime, rate.markPrice);
}
```

`fetchFundingRateHistory()` 查询公开历史 funding rate，不是账号实际收付的 funding income。`startTs` 和 `endTs` 都是 funding time 的 inclusive 边界；两者都不传时返回交易所默认最近记录。`limit` 可选，Binance 最大 1000。返回的 `FundingRateHistoryEntry.fundingTime` 是交易所历史结算/生效时间，`receivedAt` 是 SDK 本次 REST 响应到达本地的时间。USDⓈ-M 返回 `markPrice`，COIN-M 可能没有该字段。

当前 Binance 支持 USDⓈ-M 和 COIN-M 永续合约。spot 或 dated future 会抛 `MARKET_FUNDING_RATE_UNSUPPORTED`；远端请求或响应结构失败会包装为 `MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED`。

### 5.6 Funding rate

Funding Rate 当前通过 Binance mark price websocket 更新，仅支持永续合约（`MarketDefinition.type === "swap"`，包括 Binance TradFi Perps）。spot 或 future 订阅会抛 `MARKET_FUNDING_RATE_UNSUPPORTED`。

### 5.7 事件流 options

Market 事件流支持可选第二参：

```ts
type EventStreamOptions = {
  mode?: "conflate" | "buffer";
  maxBuffer?: number;
};

client.market.events.l1BookUpdates(
  { venue: "binance", symbol: "BTC/USDT:USDT" },
  { mode: "buffer", maxBuffer: 50_000 },
);
```

`l1BookUpdates()` 与 `fundingRateUpdates()` 默认使用 `conflate`，同一 `venue:symbol` 慢消费者只保留最新事件，适合策略热路径。需要录制每个 tick 时显式传 `{ mode: "buffer" }`。`market.events.all()` 与 `market.events.status()` 默认使用 `buffer`；显式传 `{ mode: "conflate" }` 时，`all()` 按 `type:venue:symbol` 合并，`status()` 按 `venue:symbol` 合并。

`buffer` 模式默认每个订阅者最多积压 `10_000` 条事件，超过后丢弃最旧事件。每次积压 episode 只会向 `client.events.errors()` 发布一次 `EVENT_BUFFER_OVERFLOW` runtime error，事件 metadata 包含 `stream` 与 `maxBuffer`；队列排空后再次溢出会再次告警。`conflate` 模式天然有界，不使用 `maxBuffer`。

## 6. AccountManager

```ts
interface AccountManager {
  readonly events: AccountEventStreams;

  subscribeAccount(input: SubscribeAccountInput): Promise<void>;
  unsubscribeAccount(input: UnsubscribeAccountInput): Promise<void>;

  getAccountSnapshot(accountId: string): AccountSnapshot | undefined;
  getBalances(accountId: string): BalanceSnapshot[];
  getBalance(accountId: string, asset: string): BalanceSnapshot | undefined;
  getPositions(accountId: string, symbol?: string): PositionSnapshot[];
  getPosition(input: PositionKeyInput): PositionSnapshot | undefined;
  getRiskSnapshot(accountId: string): RiskSnapshot | undefined;
  getAccountStatus(accountId: string): AccountDataStatus | undefined;
}
```

`AccountSnapshot.balances` 是 `Record<string, BalanceSnapshot>`，数组视图用 `getBalances()`。

Binance account update 是 REST bootstrap + WS 增量 + REST risk refresh + private reconcile 的组合。WS `ACCOUNT_UPDATE` 会更新发生变化的余额和仓位；当已保存仓位有 `markPrice` 且已有 `riskEquity` 时，SDK 会用当前仓位按 mark price 派生 `RiskSnapshot.riskLeverage`，全平时该字段更新为 `"0"`，缺少 mark price 时等待 REST 校准。PAPI 私有流的 `ACCOUNT_CONFIG_UPDATE` 会用 `ac.s/ac.l` 更新已有仓位的 `PositionSnapshot.leverage`。PAPI 私有流的账户风控告警是 `riskLevelChange`，SDK 会发布 `account.risk_level_change` 并用事件里的 `u/eq/ae/m` 回填 `RiskSnapshot.riskRatio/netEquity/riskEquity/maintenanceMargin` 和 `riskLevel`；如果可基于事件 `ae` 与当前仓位 mark price 计算，也会同步回填 `riskLeverage`。`riskLevelChange` 是账户级聚合事件，没有 symbol 或逐仓位数组；USDⓈ-M 独立合约流的 `MARGIN_CALL` 形状不适用于 PAPI。`/papi/v1/account` + `/papi/v1/um/positionRisk` refresh 用于校准风险字段和 mark-to-market 仓位字段，REST `accountStatus` 存在时会映射到 `RiskSnapshot.riskLevel`。risk refresh 是增量语义，不会因 REST 缺失项删除本地 position；private reconcile 是全量校准语义，会清理 REST 全量余额/仓位中缺失或归零的本地记录。Juplend 每次 poll 都是全量快照，成功 poll 会替换 balances / positions / risk，用于清理已关闭或不再匹配的 position。

Account 事件用于消费余额、仓位、风险或全量快照替换：

```ts
for await (const event of client.account.events.updates({
  accountId: "main-binance",
}, { maxBuffer: 20_000 })) {
  if (event.type === "risk.updated") {
    console.log(event.snapshot.riskRatio);
  }
  if (event.type === "account.risk_level_change") {
    console.log(event.riskLevel, event.riskRatio);
  }
  break;
}
```

Account 事件流只支持 `{ maxBuffer?: number }`，不提供 conflate；余额、仓位、风险和状态事件默认按 buffer 语义保留顺序。

## 7. OrderManager

```ts
interface OrderManager {
  readonly events: OrderEventStreams;

  subscribeOrders(input: SubscribeOrdersInput): Promise<void>;
  unsubscribeOrders(input: UnsubscribeOrdersInput): Promise<void>;

  createOrder(input: CreateOrderInput): Promise<OrderSnapshot>;
  cancelOrder(input: CancelOrderInput): Promise<OrderSnapshot>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<OrderSnapshot[]>;

  getOrder(input: GetOrderInput): OrderSnapshot | undefined;
  getOpenOrders(accountId: string, symbol?: string): OrderSnapshot[];
  getOrderStatus(accountId: string): OrderDataStatus | undefined;
}

interface OrderEventStreams {
  updates(filter?: OrderEventFilter, options?: { maxBuffer?: number }): AsyncIterable<OrderEvent>;
  trades(filter?: OrderEventFilter, options?: { maxBuffer?: number }): AsyncIterable<OrderTradeEvent>;
  status(filter?: OrderEventFilter, options?: { maxBuffer?: number }): AsyncIterable<OrderStatusChangedEvent>;
}
```

### 7.1 支持范围

- `createOrder()` 支持 `limit` / `market`
- `limit` 可传 `postOnly: true`，Binance PAPI UM 映射为 `timeInForce=GTX`
- 未传 `clientOrderId` 时，`createOrder()` 由 SDK 生成合规 client id（`acex-<entropy>-<ts>-<seq>`，≤32）并作为 Binance `newClientOrderId` 发送，返回 snapshot 的 `clientOrderId` 即该值；自带 `clientOrderId` 超长或含非法字符会抛 `ORDER_INPUT_INVALID`
- `cancelOrder()` 必须传 `orderId` 或 `clientOrderId`
- `cancelAllOrders()` 必须传 `symbol`，不支持账户级全撤
- hedge mode 下必须显式传 `positionSide: "long" | "short"`

### 7.2 精度限制

`createOrder()` 不会自动纠偏。调用方应先用 `MarketDefinition.priceStep`、`amountStep`、`minAmount`、`minNotional` 和 `normalizeOrderInput()` 处理输入。交易所拒单会包装成 `ORDER_CREATE_FAILED`。

### 7.3 本地缓存与查询

- OrderManager 内部按 open / closed 分层缓存订单。**closed（filled / canceled / rejected / expired / unknown）订单按 symbol 各保留最近 N 个**，`N = CreateClientOptions.order.maxClosedOrdersPerSymbol`（默认 500，非正或非整数回退默认），超限按 FIFO 裁剪最旧；**open 订单不受此上限限制**。`getOpenOrders()` 查询复杂度与历史终态订单数量无关。
- `getOrder(input)` 需带 `orderId` 或 `clientOrderId`（否则返回 `undefined`），`symbol` 可选：
  - **精确查单推荐传 `symbol + orderId`**（O(1) 精确索引、唯一命中）。
  - 仅 `clientOrderId` 查询可命中 open 与未被裁剪的 closed；当 `clientOrderId` 唯一（你自定义的或 SDK 生成的 `acex-*`）时可精确命中，但同一 `clientOrderId` 命中多笔时返回**最新一笔**（精确定位历史某一笔请用 `symbol + orderId`）。
  - 仅传 `orderId`（不带 `symbol`）时，跨 symbol 同 `orderId` 可能多命中，返回最新一笔；ADL / 系统单会共享 `clientOrderId`（如 `adl_autoclose`），必须用 `symbol + orderId` 精确定位。
  - 同时给 `orderId` 与 `clientOrderId` 时，两者都匹配才命中。
  - 已超出保留上限被裁剪的 closed 订单将查不到（返回 `undefined`）。

Order 事件用于消费订单状态变化和 open orders 快照校准。Binance private reconcile 会先用 `/papi/v1/um/openOrders` 校验当前 open set；本地 open order 从 open set 消失时，SDK 会优先查询单笔订单终态并发布 `order.filled` / `order.canceled` 等事件。若单笔查询连续确认订单不存在（默认 3 次，`CreateClientOptions.order.missingOrderEvictionThreshold` 可配置），SDK 会把该订单终态化为 `status: "unknown"`、移出 open 缓存并发布一次 runtime error；网络/超时/限流等 transport 错误不会计入该阈值。`createOrder()` 超时保留的 pending claim 会在 reconcile 周期里按 `CreateClientOptions.order.pendingClaimTtlMs`（默认 90s）过期回查：查到订单则正常入库，确认不存在则清理 claim 并发布 runtime error；无 `fetchOrder` 能力的 venue 会保守保留 claim。

```ts
for await (const event of client.order.events.updates({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
}, { maxBuffer: 20_000 })) {
  if (event.type === "order.filled") {
    console.log(event.snapshot.filled);
  }
  break;
}
```

Binance 私有 WS 的逐笔成交、已发生手续费金额与 realized PnL 通过独立 `order.trade` 事件消费，不挂在 `OrderSnapshot` 上：

```ts
for await (const event of client.order.events.trades({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
}, { maxBuffer: 50_000 })) {
  console.log(event.orderId, event.trade.price, event.trade.qty, event.trade.fee);
  break;
}
```

`OrderTradeEvent.seq` 是该账户订单成交流的单调序号，可用于检测慢消费者 buffer 溢出造成的缺口；`orderSeq` 在同一交易所 update 成功推进订单快照时关联 `OrderSnapshot.seq`。REST 订单查询/命令回包不含逐笔手续费，不会发布 `order.trade`。如果需要“已发生手续费按 symbol 汇总”，下游应消费 `order.trade` 并按 `event.symbol` 聚合；`client.fee.getSymbolFeeRate()` 只返回当前账号 symbol 费率。

Order 事件流只支持 `{ maxBuffer?: number }`，不提供 conflate；订单中间状态、逐笔成交和错误恢复信号默认按 buffer 语义保留顺序。慢消费者超过 buffer 上限时会丢弃最旧事件，并通过 `EVENT_BUFFER_OVERFLOW` runtime error 上报对应 stream（例如 `order.trades`）。

## 8. FeeManager

```ts
interface FeeManager {
  subscribe(input: SubscribeFeeRatesInput): Promise<void>;
  unsubscribe(input: UnsubscribeFeeRatesInput): Promise<void>;
  getSymbolFeeRate(input: GetSymbolFeeRateInput): SymbolFeeRate;
  getSymbolFeeRates(accountId?: string): SymbolFeeRate[];
  fetchSymbolFeeRate(input: GetSymbolFeeRateInput): Promise<SymbolFeeRate>;
}
```

FeeManager 查询的是账号级交易费率，不是已发生成交手续费汇总。费率会受交易所账号等级、折扣和 symbol 规则影响；未读取到真实值时返回默认值。

```ts
await client.fee.subscribe({
  accountId: "main-binance",
  symbols: ["BTC/USDT:USDT"],
});

const local = client.fee.getSymbolFeeRate({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

const fresh = await client.fee.fetchSymbolFeeRate({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});
```

- `subscribe()` 多次调用是增量维护；`unsubscribe({ accountId })` 移除该账号全部 fee 维护记录。
- `getSymbolFeeRate()` 是同步本地读取；未维护 symbol 会自动加入维护集合并先返回默认值。
- `fetchSymbolFeeRate()` 立即远端查询单个 symbol，成功后写回同一份 cache，后续 `getSymbolFeeRate()` 返回 `source: "venue"`。
- 返回的 `maker` / `taker` 是费率小数，例如 `"0.0002"` 表示 0.02%，并且是 canonical decimal string。
- 默认刷新周期是 24h，可用 `CreateClientOptions.fee.refreshIntervalMs` 覆盖。
- 默认费率按 `Venue + MarketType` 区分，可用 `CreateClientOptions.fee.defaultRates` 覆盖。Binance 内置默认值：spot `0.001/0.001`、swap `0.0002/0.0005`、future `0.0001/0.0005`。
- Binance 当前只对 `swap` 使用 PAPI UM `commissionRate` 真实刷新；`spot` / `future` 先返回默认值，显式 `fetchSymbolFeeRate()` 会抛 `VENUE_NOT_SUPPORTED`。
- 远端查询失败会包装为 `FEE_RATE_FETCH_FAILED`；后台刷新失败保留旧真实值或默认值，并通过 `client.events.errors()` 发布 `source: "fee"`。

## 9. RiskLimitManager

```ts
interface RiskLimitManager {
  getSymbolRiskLimit(input: GetSymbolRiskLimitInput): SymbolRiskLimitSnapshot;
  getSymbolRiskLimits(accountId?: string): SymbolRiskLimitSnapshot[];
  fetchSymbolRiskLimit(
    input: GetSymbolRiskLimitInput,
  ): Promise<SymbolRiskLimitSnapshot>;
  fetchRiskLimits(
    input: FetchRiskLimitsInput,
  ): Promise<SymbolRiskLimitSnapshot[]>;
  setSymbolLeverage(
    input: SetSymbolLeverageInput,
  ): Promise<SymbolLeverageUpdate>;
}
```

RiskLimitManager 查询的是交易所硬风控限制：leverage bracket、notional tier、当前账户 / symbol 的 notional coefficient，以及最近一次 SDK 设置杠杆的交易所回包。它不维护仓位、挂单或真实当前杠杆；真实当前杠杆仍以 `AccountManager` 的 `PositionSnapshot.leverage` 为准。

```ts
const cached = client.riskLimit.getSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

if (cached.tiers.source === "missing" || cached.tiers.stale) {
  await client.riskLimit.fetchRiskLimits({ accountId: "main-binance" });
}

const fresh = await client.riskLimit.fetchSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

const leverage = await client.riskLimit.setSymbolLeverage({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  leverage: "4",
});
```

- `getSymbolRiskLimit()` 是同步本地读取；未命中会返回 `tiers.source: "missing"`、`tiers.stale: true`、`tiers.items: []`，不会发起 REST 请求。
- client 启动后，已注册账户会按 `CreateClientOptions.riskLimit.refreshIntervalMs` 做账户级全量后台刷新；默认 5 分钟。后台刷新调用交易所全量 endpoint 并批量写入该账户的 symbol cache。
- `fetchSymbolRiskLimit()` 立即远端查询单个 symbol，成功后写回缓存。
- `fetchRiskLimits()` 立即远端全量刷新账户下所有返回的 symbol，成功后批量写回缓存。
- `setSymbolLeverage()` 先做本地输入校验；leverage 必须是 1 到 125 的整数。成功后只更新 `snapshot.leverage.lastSet`，不会把旧的 `snapshot.tiers.stale` 改成 `false`。
- `snapshot.leverage.lastSet` 只表示本 SDK 最近一次 `setSymbolLeverage()` 成功回包，不代表账户真实当前杠杆。账户真实当前杠杆仍由 `AccountManager.position.leverage` 通过 private account stream / account refresh 维护。
- 凭证更新会把该账户已有 tier cache 降级为 missing/stale；旧 in-flight 结果不会写回。凭证更新后的显式 `fetchRiskLimits()` 会用新 generation 发起新请求，不复用旧请求。
- 账户移除会清理该账户全部 risk limit cache。
- Binance PAPI UM 当前使用 `GET /papi/v1/um/leverageBracket` 和 `POST /papi/v1/um/leverage`；两个 endpoint request weight 都是 1。`notionalCoef` 映射为 `snapshot.tiers.notionalCoefficient`，设置杠杆回包里的 `maxNotionalValue` 映射为 `SymbolLeverageUpdate.maxNotionalValue`。
- 远端查询失败会包装为 `RISK_LIMIT_FETCH_FAILED`；设置杠杆失败会包装为 `LEVERAGE_SET_FAILED`；无凭证会抛 `CREDENTIALS_MISSING`；非 Binance 或未实现 venue 会抛 `VENUE_NOT_SUPPORTED`。

## 10. 健康与错误事件

```ts
const health = client.getHealth();

for await (const event of client.events.health(
  { venue: "binance" },
  { maxBuffer: 20_000 },
)) {
  console.log(event.type);
  break;
}

for await (const error of client.events.errors({ maxBuffer: 20_000 })) {
  console.error(error.source, error.error);
  break;
}
```

`getHealth()` 聚合 client、market、account、order 的当前状态。`events.health(filter, options?)` 只返回满足 filter 的事件；如果事件没有 filter 请求的字段，会被过滤掉。`events.health()` 与 `events.errors()` 只支持 `{ maxBuffer?: number }`，默认 buffer 上限同样是 `10_000`；`errors()` 自身溢出时只丢弃最旧错误事件，不再发布新的 overflow 错误，避免递归。

## 11. 数据类型速查

以下类型均从 `@imbingox/acex` 根入口导出；以 package public types 为准。这里列常用形状，完整字段可由 TypeScript 自动补全。

```ts
type Venue = "binance" | "okx" | "bybit" | "gate" | "juplend";
type ClientStatus = "idle" | "starting" | "running" | "stopping" | "stopped";
type MarketType = "spot" | "swap" | "future";
type PositionSide = "long" | "short" | "net";
type CreateOrderType = "limit" | "market";
type OrderType =
  | CreateOrderType
  | "stop"
  | "stop_market"
  | "take_profit"
  | "take_profit_market"
  | "trailing_stop_market"
  | "unknown";
type OrderSide = "buy" | "sell";
type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown";

type PrivateRuntimeReason =
  | "credentials_missing"
  | "auth_failed"
  | "http_failed"
  | "rate_limited"
  | "ws_disconnected"
  | "heartbeat_timeout"
  | "reconciling";

type SubscriptionActivity = "active" | "inactive";
type MarketFreshness = "fresh" | "stale" | "reconciling";
type PrivateRuntimeStatus =
  | "bootstrap_pending"
  | "healthy"
  | "degraded"
  | "reconnecting"
  | "reconciling"
  | "stopped";
```

```ts
interface VenueCapabilities {
  venue: Venue;
  runtimeStatus: "available" | "type_only" | "reserved";
  readOnly: boolean;
  notes: string[];
  market: {
    catalog: "supported" | "unsupported";
    serverTime: "supported" | "unsupported";
    publicTrades: "supported" | "unsupported";
    publicRawTrades: "supported" | "unsupported";
    fundingRateHistory: "supported" | "unsupported";
    l1Book: "supported" | "unsupported";
    fundingRate: "supported" | "unsupported" | "market_dependent";
    marketTypes: MarketType[];
  };
  account: {
    register: "supported" | "unsupported";
    snapshot: "supported" | "unsupported";
    updates: "websocket" | "polling" | "unsupported";
    balances: "supported" | "unsupported";
    positions: "supported" | "unsupported";
    risk: "supported" | "unsupported";
    lending: "supported" | "unsupported";
    credentialsRequired: boolean;
  };
  order: {
    supported: boolean;
    openOrders: "supported" | "unsupported";
    updates: "websocket" | "polling" | "unsupported";
    create: "supported" | "unsupported";
    cancel: "supported" | "unsupported";
    cancelAll: "symbol" | "account" | "unsupported";
    orderTypes: CreateOrderType[];
    timeInForce: Array<"gtc" | "post_only">;
    postOnly: boolean;
    reduceOnly: boolean;
    positionSide: "optional" | "required_for_hedge" | "unsupported";
    clientOrderId: boolean;
    reason?:
      | "not_implemented"
      | "read_only"
      | "market_type_unsupported"
      | "sdk_reserved";
  };
}
```

```ts
interface CreateClientOptions {
  sandbox?: boolean;
  clock?: {
    now(): number;
    requestResync?(): void;
  };
  rateLimiter?: RateLimiter;
  rateLimit?: {
    utilizationTarget?: number;
  };
  onMetric?: OnMetric;
  logger?: Logger;
  logLevel?: "debug" | "info" | "warn" | "error";
  market?: {
    l1InitialMessageTimeoutMs?: number;
    l1StaleAfterMs?: number;
    l1ReconnectDelayMs?: number;
    l1ReconnectMaxDelayMs?: number;
    venues?: {
      binance?: {
        /** Used by fetchPublicRawTrades(); secret/signature not required. */
        apiKey?: string;
      };
    };
  };
  account?: {
    streamOpenTimeoutMs?: number;
    streamReconnectDelayMs?: number;
    streamReconnectMaxDelayMs?: number;
    venues?: {
      binance?: {
        riskPollIntervalMs?: number;
        privateReconcileIntervalMs?: number;
        privateStreamStaleAfterMs?: number;
        listenKeyKeepAliveMs?: number;
      };
      juplend?: {
        pollIntervalMs?: number;
        rpcUrl?: string;
        jupApiKey?: string;
      };
    };
  };
  order?: {
    maxClosedOrdersPerSymbol?: number;
    missingOrderEvictionThreshold?: number;
    pendingClaimTtlMs?: number;
  };
  fee?: {
    /** ms; defaults to 24h */
    refreshIntervalMs?: number;
    /**
     * Defaults keyed by Venue + MarketType.
     * Binance built-ins: spot 0.001/0.001, swap 0.0002/0.0005,
     * future 0.0001/0.0005.
     */
    defaultRates?: Partial<
      Record<
        Venue,
        Partial<Record<MarketType, { maker: string; taker: string }>>
      >
    >;
  };
  riskLimit?: {
    /** ms; defaults to 5 minutes */
    refreshIntervalMs?: number;
  };
}

interface RateLimitScope {
  venue: Venue;
  accountId?: string;
  endpointKey: string;
}

interface RateLimitUsage {
  weight?: Record<string, number>;
  orderCount?: Record<string, number>;
}

type RateLimitPriority = "normal" | "cancel" | "risk" | (string & {});
type RateLimitBucketKind = "request_weight" | "orders" | (string & {});
type RateLimitScopeDimension = "venue" | "account" | "endpoint";
type MetricType = "counter" | "gauge" | "timing";

type OnMetric = (
  name: string,
  value: number,
  type: MetricType,
  tags?: Record<string, string>,
) => void;

const METRIC_NAMES = {
  orderCommandRtt: "order.command.rtt",
  wsMessageLatency: "ws.message.latency",
  wsReconnect: "ws.reconnect",
  eventBufferOverflow: "event.buffer.overflow",
} as const;

interface RateLimitBucketReserve {
  priority: RateLimitPriority;
  units: number;
}

interface RateLimitBucketDescriptor {
  id: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  scope: readonly RateLimitScopeDimension[];
  utilizationTarget?: number;
  reserve?: RateLimitBucketReserve;
}

interface RateLimitCost {
  bucketId: string;
  cost: number;
}

interface RateLimitPlan {
  id: string;
  costs: readonly RateLimitCost[];
  priority?: RateLimitPriority;
}

interface RateLimitTopology {
  id: string;
  buckets: readonly RateLimitBucketDescriptor[];
  plans: readonly RateLimitPlan[];
}

interface RateLimitReservation {
  readonly __opaqueRateLimitReservation?: never;
}

interface RateLimitTopologyRegistry {
  registerRateLimitTopology(topology: RateLimitTopology): void;
}

interface RateLimitBucketSnapshot {
  bucketId: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  utilizationTarget?: number;
  reserve?: RateLimitBucketReserve;
  used?: number;
  windowStartMs?: number;
  windowEndMs?: number;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: "ok" | "rate_limited" | "banned";
  updatedAt?: number;
}

interface RateLimitRequestContext {
  scope: RateLimitScope;
  planId?: string;
  priority?: RateLimitPriority;
}

interface RateLimitResponseContext {
  status: number;
  headers?: Headers;
  usage?: RateLimitUsage;
  reservation?: RateLimitReservation;
}

interface RateLimitTransportErrorContext {
  status?: number;
  headers?: Headers;
  retryAfterMs?: number;
  usage?: RateLimitUsage;
  reservation?: RateLimitReservation;
  requestNotSent?: boolean;
}

interface RateLimitSnapshot {
  scope: RateLimitScope;
  usage?: RateLimitUsage;
  blockedUntil?: number;
  retryAfterMs?: number;
  state: "ok" | "rate_limited" | "banned";
  updatedAt?: number;
  buckets?: RateLimitBucketSnapshot[];
}

interface RateLimiter {
  beforeRequest(
    ctx: RateLimitRequestContext,
  ): Promise<RateLimitReservation | void> | RateLimitReservation | void;
  afterResponse(
    ctx: RateLimitRequestContext,
    response: RateLimitResponseContext,
  ): Promise<void> | void;
  onTransportError(
    ctx: RateLimitRequestContext,
    error: RateLimitTransportErrorContext,
  ): Promise<void> | void;
  getSnapshot(scope: RateLimitScope): RateLimitSnapshot | undefined;
}

interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

type RegisterAccountInput =
  | {
      accountId: string;
      venue: "binance" | "okx" | "bybit" | "gate";
      credentials?: AccountCredentials;
      options?: {
        timestamp?: number;
        recvWindow?: number;
      };
    }
  | {
      accountId: string;
      venue: "juplend";
      credentials?: AccountCredentials;
      options:
        | {
            walletAddress: string;
            vaultId?: string;
            positionId?: string;
          }
        | {
            walletAddress?: string;
            vaultId: string;
            positionId: string;
          };
    };

interface AccountCredentials {
  apiKey?: string;
  secret?: string;
  password?: string;
  extra?: Record<string, string>;
}
```

`clock` 只用于私有签名请求的 `timestamp`，不参与 `receivedAt`、WebSocket freshness 或本地状态时间。默认不传 `clock` 时，runtime 会为 Binance 签名请求启用 venue 级 server-time 自动校准；当交易所返回 `timestamp_out_of_sync` 时，SDK 会触发一次去抖后的重校。显式传入 `clock` 表示调用方完全接管签名时间，SDK 不会创建默认 server-time sampler 或同步 timer。

```ts
interface MarketDefinition {
  venue: Venue;
  symbol: string;
  id: string;
  type: MarketType;
  base: string;
  quote: string;
  settle?: string;
  active: boolean;
  contract: boolean;
  linear?: boolean;
  inverse?: boolean;
  contractSize?: string;
  pricePrecision: number;
  amountPrecision: number;
  priceStep: string;
  amountStep: string;
  minAmount?: string;
  minNotional?: string;
  expiry?: number;
  raw: Record<string, unknown>;
}

interface VenueServerTime {
  serverTime: number;
  requestSentAt: number;
  responseReceivedAt: number;
  roundTripMs: number;
  estimatedOffsetMs: number;
}

interface PublicTrade {
  venue: Venue;
  symbol: string;
  id: string;
  price: string;
  amount: string;
  cost?: string;
  side?: "buy" | "sell";
  exchangeTs: number;
  receivedAt: number;
  raw: Record<string, unknown>;
}

interface FetchPublicTradesInput {
  venue: Venue;
  symbol: string;
  startTs: number;
  endTs?: number;
  limit?: number;
}

interface FetchPublicTradesResult {
  trades: PublicTrade[];
  startTs: number;
  endTs?: number;
  limit?: number;
  truncated: boolean;
}

interface FetchPublicRawTradesInput {
  venue: Venue;
  symbol: string;
  startTs: number;
  endTs?: number;
  limit?: number;
}

interface FetchPublicRawTradesResult {
  trades: PublicTrade[];
  startTs: number;
  endTs?: number;
  limit?: number;
  truncated: boolean;
}

interface FundingRateHistoryEntry {
  venue: Venue;
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice?: string;
  receivedAt: number;
  raw: Record<string, unknown>;
}

interface FetchFundingRateHistoryInput {
  venue: Venue;
  symbol: string;
  startTs?: number;
  endTs?: number;
  limit?: number;
}

interface FetchFundingRateHistoryResult {
  rates: FundingRateHistoryEntry[];
  startTs?: number;
  endTs?: number;
  limit?: number;
  truncated: boolean;
}

interface L1Book {
  venue: Venue;
  symbol: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  receivedAt: number;
  updatedAt: number;
  version: number;
  status: MarketDataStreamStatus;
}

interface MarketDataStreamStatus {
  activity: SubscriptionActivity;
  ready: boolean;
  freshness?: MarketFreshness;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: "ws_disconnected" | "heartbeat_timeout" | "reconciling";
}

interface MarketDataStatus extends MarketDataStreamStatus {
  venue: Venue;
  symbol: string;
}

interface FundingRateSnapshot {
  venue: Venue;
  symbol: string;
  fundingRate: string;
  nextFundingTime?: number;
  markPrice?: string;
  indexPrice?: string;
  receivedAt: number;
  updatedAt: number;
  version: number;
  status: MarketDataStreamStatus;
}

interface BalanceSnapshot {
  accountId: string;
  venue: Venue;
  asset: string;
  free: string;
  used: string;
  total: string;
  lending?: {
    supplied: string;
    borrowed: string;
    interest: string;
    netAsset: string;
    supplyAPY?: string;
    borrowAPY?: string;
  };
}

interface PositionSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  side: PositionSide;
  size: string;
  entryPrice?: string;
  markPrice?: string;
  unrealizedPnl?: string;
  leverage?: string;
  liquidationPrice?: string;
}

type RiskLevel =
  | "normal"
  | "margin_call"
  | "reduce_only"
  | "force_liquidation";

type RiskAlertLevel = Exclude<RiskLevel, "normal">;

interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  riskLevel?: RiskLevel;
  netEquity?: string;
  riskEquity?: string;
  riskRatio?: string;
  riskLeverage?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  lending?: {
    marginLevel?: string;
    healthFactor?: string;
    ltv?: string;
    liquidationThreshold?: string;
    totalCollateralUSD?: string;
    totalDebtUSD?: string;
  };
}

interface AccountSnapshot {
  accountId: string;
  venue: Venue;
  balances: Record<string, BalanceSnapshot>;
  positions: PositionSnapshot[];
  risk?: RiskSnapshot;
}

interface AccountDataStatus {
  accountId: string;
  venue: Venue;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  reason?: PrivateRuntimeReason;
}
```

```ts
type CreateOrderInput =
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "limit";
      price: string;
      amount: string;
      postOnly?: boolean;
      clientOrderId?: string;
      reduceOnly?: boolean;
      positionSide?: PositionSide;
    }
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "market";
      amount: string;
      clientOrderId?: string;
      reduceOnly?: boolean;
      positionSide?: PositionSide;
    };

interface CancelOrderInput {
  accountId: string;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}

interface CancelAllOrdersInput {
  accountId: string;
  symbol: string;
}

interface SubscribeFeeRatesInput {
  accountId: string;
  symbols: string[];
}

interface UnsubscribeFeeRatesInput {
  accountId: string;
  symbols?: string[];
}

interface GetSymbolFeeRateInput {
  accountId: string;
  symbol: string;
}

interface SymbolFeeRate {
  accountId: string;
  venue: Venue;
  symbol: string;
  marketType: MarketType;
  maker: string;
  taker: string;
  source: "default" | "venue";
  receivedAt: number;
}

interface GetSymbolRiskLimitInput {
  accountId: string;
  symbol: string;
}

interface FetchRiskLimitsInput {
  accountId: string;
}

interface SetSymbolLeverageInput {
  accountId: string;
  symbol: string;
  leverage: string;
}

interface RiskLimitTier {
  tier: number;
  initialLeverage: string;
  notionalFloor?: string;
  notionalCap?: string;
  maintenanceMarginRatio?: string;
  cumulativeMaintenanceAmount?: string;
}

interface SymbolLeverageUpdate {
  accountId: string;
  venue: Venue;
  symbol: string;
  leverage: string;
  maxNotionalValue?: string;
  receivedAt: number;
}

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

interface OrderSnapshot {
  accountId: string;
  venue: Venue;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  rawType?: string;
  status: OrderStatus;
  price?: string;
  amount: string;
  filled: string;
  remaining?: string;
  positionSide?: PositionSide;
}

interface OrderDataStatus {
  accountId: string;
  venue: Venue;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  reason?: PrivateRuntimeReason;
}

interface OrderTrade {
  tradeId?: string;
  price: string;
  qty: string;
  fee?: {
    cost: string;
    asset: string;
  };
  realizedPnl?: string;
  maker?: boolean;
  positionSide?: PositionSide;
  exchangeTs?: number;
  receivedAt: number;
}

```

```ts
type MarketEvent =
  | { type: "l1_book.updated"; venue: Venue; symbol: string; snapshot: L1Book; ts: number }
  | { type: "funding_rate.updated"; venue: Venue; symbol: string; snapshot: FundingRateSnapshot; ts: number }
  | { type: "market.status_changed"; venue: Venue; symbol: string; status: MarketDataStatus; ts: number };

type AccountEvent =
  | { type: "balance.updated"; accountId: string; venue: Venue; asset: string; snapshot: BalanceSnapshot; ts: number }
  | { type: "position.updated"; accountId: string; venue: Venue; symbol: string; snapshot: PositionSnapshot; ts: number }
  | { type: "risk.updated"; accountId: string; venue: Venue; snapshot: RiskSnapshot; ts: number }
  | { type: "account.risk_level_change"; accountId: string; venue: Venue; riskLevel: RiskAlertLevel; riskRatio?: string; netEquity?: string; riskEquity?: string; riskLeverage?: string; maintenanceMargin?: string; exchangeTs?: number; receivedAt: number; ts: number }
  | { type: "account.snapshot_replaced"; accountId: string; venue: Venue; snapshot: AccountSnapshot; ts: number };

type OrderEvent =
  | { type: "order.updated"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.filled"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.canceled"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.rejected"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.snapshot_replaced"; accountId: string; venue: Venue; snapshot: OrderSnapshot[]; ts: number };

type OrderTradeEvent = {
  type: "order.trade";
  accountId: string;
  venue: Venue;
  symbol: string;
  side: OrderSide;
  orderId?: string;
  clientOrderId?: string;
  trade: OrderTrade;
  seq: number;
  orderSeq?: number;
  ts: number;
};
```

## 12. 错误处理

可预期错误统一抛 `AcexError`：

```ts
import { AcexError, isOrderStateUnknown } from "@imbingox/acex";

try {
  await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "101000",
    amount: "0.01",
    postOnly: true,
  });
} catch (error) {
  if (error instanceof AcexError) {
    console.log(error.code);
    console.log(error.details?.venueError?.code);
    console.log(error.details?.venueError?.reason);
    console.log(error.details?.orderState);
    console.log(error.details?.transport?.status);
    console.log(isOrderStateUnknown(error));
  }
}
```

`details.venueError` 是读取交易所结构化拒绝原因的首选字段；`details.venueError.reason` 是 SDK 归一后的稳定原因，原始 `code/message` 会继续保留。`details.orderState` 只在订单命令错误中填写：`not_placed` 表示 SDK 判定订单未落地，`unknown` 表示请求可能已经到达交易所，应由调用方后续查询或对账确认。`details.transport` 保存已脱敏的 HTTP / transport 诊断信息；`cause` 保留底层错误链。

归一错误原因：

| `VenueErrorReason` | 典型含义 |
|---|---|
| `insufficient_balance` | 余额或保证金不足 |
| `would_take` | Post Only / maker-only 订单会吃单而被拒 |
| `order_not_found` | 订单不存在、已不在可撤订单簿或超过交易所可查询范围 |
| `filter_violation` | 价格、数量、精度、最小名义金额或订单数量限制不满足 |
| `rate_limited` | 请求权重、订单频率或账户排队被限流 |
| `timestamp_out_of_sync` | 请求时间戳或 `recvWindow` 与交易所时间不匹配 |
| `unknown` | 交易所原始码未归入稳定语义，调用方仍可读取原始 `code/message` |

完整错误码：

| Code | 典型场景 |
|---|---|
| `CLIENT_NOT_STARTED` | 未 start 就调用订阅方法 |
| `VENUE_NOT_SUPPORTED` | venue runtime 未实现，或 read-only venue 被用于下单 |
| `MARKET_CATALOG_LOAD_FAILED` | market catalog 拉取失败 |
| `MARKET_SERVER_TIME_FETCH_FAILED` | server time 请求失败或响应结构不合法 |
| `MARKET_INPUT_INVALID` | market REST 查询输入不合法，例如时间窗口或 limit 无效 |
| `MARKET_PUBLIC_TRADES_FETCH_FAILED` | public trades / raw trades 请求失败、缺少 Binance market API key 或响应结构不合法 |
| `MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED` | 历史 funding rate 请求失败或响应结构不合法 |
| `MARKET_INACTIVE` | catalog 中 market 不活跃 |
| `MARKET_FUNDING_RATE_UNSUPPORTED` | 指定 market 不支持 funding rate |
| `MARKET_NOT_FOUND` | 指定 symbol 不存在 |
| `MARKET_STREAM_TIMEOUT` | market stream 首条消息超时 |
| `ACCOUNT_ALREADY_EXISTS` | 重复注册 accountId |
| `ACCOUNT_BOOTSTRAP_FAILED` | account bootstrap 失败 |
| `ACCOUNT_NOT_FOUND` | accountId 未注册或已移除 |
| `CREDENTIALS_MISSING` | private 订阅或下单缺凭证 |
| `FEE_RATE_FETCH_FAILED` | 单 symbol 手续费费率远端查询失败 |
| `RISK_LIMIT_FETCH_FAILED` | risk limit / leverage bracket 远端查询失败 |
| `RISK_LIMIT_INPUT_INVALID` | risk limit 本地输入校验失败，例如 leverage 不是 1 到 125 的整数 |
| `LEVERAGE_SET_FAILED` | 设置 symbol leverage REST 失败或交易所拒绝 |
| `ORDER_BOOTSTRAP_FAILED` | open orders bootstrap 失败 |
| `ORDER_INPUT_INVALID` | 本地订单输入校验失败 |
| `ORDER_CREATE_FAILED` | 下单 REST 失败或交易所拒单 |
| `ORDER_CANCEL_FAILED` | 撤单失败 |
| `ORDER_CANCEL_ALL_FAILED` | 批量撤单失败 |

## 13. 当前限制

- market/order runtime 当前只支持 `binance`
- account runtime 支持 `binance` 和只读 `juplend`
- `okx` / `bybit` / `gate` 只在 `Venue` 类型中声明
- Funding Rate 仅支持 Binance 永续合约，包括 Binance TradFi Perps
- Binance order 命令固定走 PAPI UM，venue 级 `order.supported = true` 不代表 spot、COIN-M 或交割合约都能下单
- Binance fee 真实远端刷新当前只覆盖 `swap`；spot / future 返回默认费率，显式 fetch 抛 `VENUE_NOT_SUPPORTED`
- Binance risk limit 当前只覆盖 PAPI UM leverage bracket / set leverage；不覆盖 spot、COIN-M 或交割合约，也不计算下单前剩余名义价值
- `client.riskLimit.getSymbolRiskLimit()` 只读缓存，不保证首次调用已有交易所数据；需要强一致时调用显式 `fetchRiskLimits()` / `fetchSymbolRiskLimit()`
- `cancelAllOrders()` 必须带 `symbol`，不支持账户级全撤
- `createOrder()` 不支持条件单、改单
- SDK 不自动纠偏订单精度；下游应使用 `normalizeOrderInput()`
- Juplend 只读，不支持链上写操作和 `OrderManager`
- `sandbox`、`logger`、`logLevel` 为预留位
