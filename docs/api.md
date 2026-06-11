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
- [8. 健康与错误事件](#8-健康与错误事件)
- [9. 数据类型速查](#9-数据类型速查)
- [10. 错误处理](#10-错误处理)
- [11. 当前限制](#11-当前限制)

## 1. 当前能力

`@imbingox/acex` 是状态型多 venue SDK。调用方创建一个 `AcexClient`，通过 `market` / `account` / `order` 三个 manager 读取最新快照、消费事件流、执行命令；SDK 内部维护本地缓存、ready barrier、WebSocket 生命周期、自动重连、REST timeout / retry / 错误脱敏和 reactive rate limiter。

当前 runtime 落地：

| Venue | Market | Account | Order |
|---|---|---|---|
| `binance` | Spot / USDⓈ-M / COIN-M catalog（含 TradFi Perps）；L1 Book；永续 funding rate；USDM server time | PAPI UM 私有账户流 + REST risk refresh | PAPI UM `limit` / `market` 下单、撤单、按 symbol 全撤 |
| `juplend` | 不支持 | Jupiter Lend 只读账户 polling | 不支持，read-only |
| `okx` / `bybit` / `gate` | 类型占位 | 类型占位 | 类型占位 |

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

`createClient()` 不建立网络连接。`start()` 后才能调用订阅类方法；`loadMarkets()`、`reloadMarkets()`、`fetchServerTime()` 和 capability 查询不要求 client 已 start。

### 2.2 订阅 Binance L1 Book

```ts
await client.start();

await client.market.subscribeL1Book({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

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
```

`subscribeL1Book()` 会等待该 logical subscription 的首条有效数据到达后才 resolve。首条数据超时会抛 `MARKET_STREAM_TIMEOUT`。

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

### 2.4 注册 Juplend 只读账户

```ts
const client = createClient({
  account: {
    juplend: {
      pollIntervalMs: 30_000,
      rpcUrl: process.env.SOL_HELIUS_RPC,
      jupApiKey: process.env.JUP_API,
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

### 2.5 下单和撤单

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

订阅方法 resolve 之后，相关 getter 应已有第一份可读快照：

```ts
await client.market.subscribeL1Book({ venue: "binance", symbol });
const snapshot = client.market.getL1Book({ venue: "binance", symbol });
```

如果首条数据迟迟不到，订阅 promise 会 reject。稳态期间断线不会清空旧快照；快照上的 `status.freshness` 会转为 `stale`。

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
    listenKeyKeepAliveMs: 30 * 60_000,
    binance: {
      riskPollIntervalMs: 5_000,
      privateReconcileIntervalMs: 60_000,
      privateStreamStaleAfterMs: 65 * 60_000,
    },
    juplend: {
      pollIntervalMs: 30_000,
      rpcUrl: process.env.SOL_HELIUS_RPC,
      jupApiKey: process.env.JUP_API,
    },
  },
});
```

`clock` 只用于 outbound request / signing timestamp，不驱动 WebSocket freshness 的 received-at 时钟。需要自定义 REST 限流行为时可传 `rateLimiter`，否则使用默认 bucket-aware reactive limiter：它会注册 Binance REST topology，把 429/418 block 落到对应 bucket，但当前仍不做主动预算 admission。`rateLimit.utilizationTarget` 预留给默认 limiter 的预算目标（默认 0.9），阶段 1 只进入 bucket snapshot/配置面。Binance `riskPollIntervalMs` 默认 5s，用于风险和 mark-to-market 仓位刷新；`privateReconcileIntervalMs` 默认 60s，用于账户余额、仓位和订单状态 REST 对账，显式传 `0` 可关闭 private reconcile，但不关闭 risk polling。`sandbox`、`logger`、`logLevel` 目前是预留位。

### 4.2 `start()` / `stop()`

```ts
await client.start();
await client.stop();
```

状态机是 `idle → starting → running → stopping → stopped`。`start()` 和 `stop()` 幂等。`stop(options?)` 的 `graceful` / `timeoutMs` 当前是预留参数，不要依赖它们提供额外 drain 语义。

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

  listMarkets(venue?: Venue): MarketDefinition[];
  getMarket(venue: Venue, symbol: string): MarketDefinition | undefined;
  getMarkets(symbol: string): MarketDefinition[];
  normalizeOrderInput(input: NormalizeOrderInputInput): NormalizedOrderInput;

  subscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  unsubscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  getL1Book(key: MarketKeyInput): L1Book | undefined;
  getL1Books(symbol: string): L1Book[];

  subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;
  unsubscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;
  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined;
  getFundingRates(symbol: string): FundingRateSnapshot[];

  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined;
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

### 5.4 Funding rate

Funding Rate 当前通过 Binance mark price websocket 更新，仅支持永续合约（`MarketDefinition.type === "swap"`，包括 Binance TradFi Perps）。spot 或 future 订阅会抛 `MARKET_FUNDING_RATE_UNSUPPORTED`。

### 5.5 事件流 options

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

Binance account update 是 REST bootstrap + WS 增量 + REST risk refresh + private reconcile 的组合。WS `ACCOUNT_UPDATE` 会更新发生变化的余额和仓位；`/papi/v1/account` + `/papi/v1/um/positionRisk` refresh 用于校准风险字段和 mark-to-market 仓位字段。risk refresh 是增量语义，不会因 REST 缺失项删除本地 position；private reconcile 是全量校准语义，会清理 REST 全量余额/仓位中缺失或归零的本地记录。Juplend 每次 poll 都是全量快照，成功 poll 会替换 balances / positions / risk，用于清理已关闭或不再匹配的 position。

Account 事件用于消费余额、仓位、风险或全量快照替换：

```ts
for await (const event of client.account.events.updates({
  accountId: "main-binance",
}, { maxBuffer: 20_000 })) {
  if (event.type === "risk.updated") {
    console.log(event.snapshot.riskRatio);
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
```

### 7.1 支持范围

- `createOrder()` 支持 `limit` / `market`
- `limit` 可传 `postOnly: true`，Binance PAPI UM 映射为 `timeInForce=GTX`
- 未传 `clientOrderId` 时，`createOrder()` 由 SDK 生成合规 client id（`acex-` 前缀，≤32）并作为 Binance `newClientOrderId` 发送，返回 snapshot 的 `clientOrderId` 即该值；自带 `clientOrderId` 超长或含非法字符会抛 `ORDER_INPUT_INVALID`
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

Order 事件流只支持 `{ maxBuffer?: number }`，不提供 conflate；订单中间状态和错误恢复信号默认按 buffer 语义保留顺序。

## 8. 健康与错误事件

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

## 9. 数据类型速查

以下类型均从 `@imbingox/acex` 根入口导出；以 package public types 为准。这里列常用形状，完整字段可由 TypeScript 自动补全。

```ts
type Venue = "binance" | "okx" | "bybit" | "gate" | "juplend";
type ClientStatus = "idle" | "starting" | "running" | "stopping" | "stopped";
type MarketType = "spot" | "swap" | "future";
type PositionSide = "long" | "short" | "net";
type CreateOrderType = "limit" | "market";
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
  clock?: { now(): number };
  rateLimiter?: RateLimiter;
  rateLimit?: {
    utilizationTarget?: number;
  };
  logger?: Logger;
  logLevel?: "debug" | "info" | "warn" | "error";
  market?: {
    l1InitialMessageTimeoutMs?: number;
    l1StaleAfterMs?: number;
    l1ReconnectDelayMs?: number;
    l1ReconnectMaxDelayMs?: number;
  };
  account?: {
    streamOpenTimeoutMs?: number;
    streamReconnectDelayMs?: number;
    streamReconnectMaxDelayMs?: number;
    listenKeyKeepAliveMs?: number;
    binance?: {
      riskPollIntervalMs?: number;
      privateReconcileIntervalMs?: number;
      privateStreamStaleAfterMs?: number;
    };
    juplend?: {
      pollIntervalMs?: number;
      rpcUrl?: string;
      jupApiKey?: string;
    };
  };
  order?: {
    maxClosedOrdersPerSymbol?: number;
    missingOrderEvictionThreshold?: number;
    pendingClaimTtlMs?: number;
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

interface RateLimitBucketDescriptor {
  id: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  scope: readonly RateLimitScopeDimension[];
  utilizationTarget?: number;
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
  used?: number;
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

interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  netEquity?: string;
  riskEquity?: string;
  riskRatio?: string;
  riskLeverage?: string;
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

interface OrderSnapshot {
  accountId: string;
  venue: Venue;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: string;
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
  | { type: "account.snapshot_replaced"; accountId: string; venue: Venue; snapshot: AccountSnapshot; ts: number };

type OrderEvent =
  | { type: "order.updated"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.filled"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.canceled"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.rejected"; accountId: string; venue: Venue; symbol: string; snapshot: OrderSnapshot; ts: number }
  | { type: "order.snapshot_replaced"; accountId: string; venue: Venue; snapshot: OrderSnapshot[]; ts: number };
```

## 10. 错误处理

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
| `MARKET_INACTIVE` | catalog 中 market 不活跃 |
| `MARKET_FUNDING_RATE_UNSUPPORTED` | 指定 market 不支持 funding rate |
| `MARKET_NOT_FOUND` | 指定 symbol 不存在 |
| `MARKET_STREAM_TIMEOUT` | market stream 首条消息超时 |
| `ACCOUNT_ALREADY_EXISTS` | 重复注册 accountId |
| `ACCOUNT_BOOTSTRAP_FAILED` | account bootstrap 失败 |
| `ACCOUNT_NOT_FOUND` | accountId 未注册或已移除 |
| `CREDENTIALS_MISSING` | private 订阅或下单缺凭证 |
| `ORDER_BOOTSTRAP_FAILED` | open orders bootstrap 失败 |
| `ORDER_INPUT_INVALID` | 本地订单输入校验失败 |
| `ORDER_CREATE_FAILED` | 下单 REST 失败或交易所拒单 |
| `ORDER_CANCEL_FAILED` | 撤单失败 |
| `ORDER_CANCEL_ALL_FAILED` | 批量撤单失败 |

## 11. 当前限制

- market/order runtime 当前只支持 `binance`
- account runtime 支持 `binance` 和只读 `juplend`
- `okx` / `bybit` / `gate` 只在 `Venue` 类型中声明
- Funding Rate 仅支持 Binance 永续合约，包括 Binance TradFi Perps
- Binance order 命令固定走 PAPI UM，venue 级 `order.supported = true` 不代表 spot、COIN-M 或交割合约都能下单
- `cancelAllOrders()` 必须带 `symbol`，不支持账户级全撤
- `createOrder()` 不支持条件单、改单
- SDK 不自动纠偏订单精度；下游应使用 `normalizeOrderInput()`
- Juplend 只读，不支持链上写操作和 `OrderManager`
- `sandbox`、`logger`、`logLevel` 为预留位
