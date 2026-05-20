# acex 使用手册

本手册是 `@imbingox/acex` 的对外参考文档。安装与项目定位见 [README](../README.md)。

## 目录

1. [关于 acex](#1-关于-acex)
2. [快速上手](#2-快速上手)
3. [核心概念](#3-核心概念)
4. [Client 生命周期](#4-client-生命周期)
5. [MarketManager](#5-marketmanager)
6. [AccountManager](#6-accountmanager)
7. [OrderManager](#7-ordermanager)
8. [健康与错误事件](#8-健康与错误事件)
9. [数据类型参考](#9-数据类型参考)
10. [错误处理](#10-错误处理)
11. [当前限制](#11-当前限制)

## 1. 关于 acex

`acex` 是一个面向交易场景的 **状态型** SDK：调用方只持有一个 `AcexClient`，通过统一的 `market` / `account` / `order` manager 读取最新快照、消费增量事件、观察健康状态，并执行下单/撤单命令。SDK 内部维护本地缓存、ready barrier 和 websocket 生命周期，调用方不需要自己做这些事。

SDK 的心智模型是一组三元语义：

| 动作 | 语义 |
|---|---|
| `subscribe*()` | 让 SDK 开始持续维护这份数据。`await` 返回时，对应 `get*()` 已可用 |
| `get*()` | 读取本地快照。不走网络、不阻塞 |
| `events.*()` | 订阅增量事件流。只消费，不会隐式触发 `subscribe` |

当前 MVP 阶段覆盖：Binance 现货与 USDⓈ-M / COIN-M 合约的 L1 Book、Binance 永续合约 Funding Rate，Binance PAPI UM 私有链路的账户与订单，Juplend 只读借贷账户视图，以及第一版下单/撤单命令。详见 [§11 当前限制](#11-当前限制)。

## 2. 快速上手

```bash
bun add @imbingox/acex
```

```ts
import { createClient } from "@imbingox/acex";

const client = createClient();
await client.start();

await client.market.subscribeL1Book({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

const book = client.market.getL1Book({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});
console.log(`bid=${book?.bidPrice.toFixed()} ask=${book?.askPrice.toFixed()}`);

for await (const event of client.market.events.l1BookUpdates({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
})) {
  console.log(event.snapshot.bidPrice.toFixed());
  break;
}

await client.stop();
```

同一个 client 可以同时注册 Binance 交易账户和 Juplend 借贷只读账户。`account.binance.riskPollIntervalMs` 只配置 Binance 风险/仓位校准间隔；`account.juplend.pollIntervalMs` 只配置 Juplend polling 间隔，不会把 client 限定为某个 venue：

```ts
const client = createClient({
  account: {
    binance: {
      riskPollIntervalMs: 5_000,
    },
    juplend: {
      pollIntervalMs: 30_000,
    },
  },
});
await client.start();

await client.registerAccount({
  accountId: "main-binance",
  venue: "binance",
  credentials: {
    apiKey: process.env.BINANCE_PAPI_API_KEY,
    secret: process.env.BINANCE_PAPI_SECRET,
  },
});

await client.registerAccount({
  accountId: "jup-loop-a",
  venue: "juplend",
  credentials: { apiKey: process.env.JUPITER_API_KEY! },
  options: {
    walletAddress: "<solana-wallet-address>",
    positionId: "<optional-nft-position-id>",
  },
});

await client.account.subscribeAccount({ accountId: "main-binance" });
await client.account.subscribeAccount({ accountId: "jup-loop-a" });

const binanceRisk = client.account.getRiskSnapshot("main-binance");
const juplendRisk = client.account.getRiskSnapshot("jup-loop-a");

console.log(binanceRisk?.riskRatio?.toFixed());
console.log(juplendRisk?.riskRatio?.toFixed());
```

需要账户或订单能力时，在 `start()` 前后任意时刻 `registerAccount()`：

```ts
const client = createClient();
await client.start();

await client.registerAccount({
  accountId: "main-binance",
  venue: "binance",
  credentials: {
    apiKey: process.env.BINANCE_PAPI_API_KEY,
    secret: process.env.BINANCE_PAPI_SECRET,
  },
});

await client.account.subscribeAccount({ accountId: "main-binance" });
await client.order.subscribeOrders({ accountId: "main-binance" });

await client.stop();
```

## 3. 核心概念

### 3.1 状态型 SDK

SDK 本地维护最新快照。读快照用 `get*()`，**不会** 触发网络请求。这意味着：

- `get*()` 返回 `undefined` 表示「从未订阅」或「首次快照还没到」
- 跨 symbol 做决策（套利、对冲）时，在事件回调里用 `get*()` 拿各 symbol 最新值，比读 `event.snapshot` 更一致

### 3.2 subscribe 是 ready barrier

```ts
await client.market.subscribeL1Book({ venue, symbol });
// await 返回之后，getL1Book({ venue, symbol }) 一定已经有值
```

`subscribe*()` 会等首条可用快照到达后才 resolve。超时则抛出 `MARKET_STREAM_TIMEOUT`。默认超时 15s，可通过 `CreateClientOptions.market.l1InitialMessageTimeoutMs` 调整。

### 3.2.1 subscribe / unsubscribe 行为

- 同一个 `(venue, symbol)` 反复调用 `subscribe*()` 是幂等的：已存在的流不会重复创建，只会继续等待原有流进入 ready
- `unsubscribe*()` 可以和 `subscribe*()` 动态交替调用；退订后该 stream 停止维护，但 `get*()` 仍可读到最后一份快照
- `unsubscribe*()` 对未订阅目标是安全的 no-op
- 退订后再次 `subscribe*()` 会重新恢复该 stream 的维护与更新
- `subscribeL1Book()` 和 `subscribeFundingRate()` 彼此独立；退订其中一个不会影响另一个

### 3.3 event vs snapshot

`event.snapshot` 是事件发生那一刻的快照。由于事件是异步消费的，你在 `for await` 处理时，SDK 内部状态可能已经更新到下一版。因此：

- 单 symbol 场景，直接用 `event.snapshot` 即可
- 跨 symbol 决策场景，把事件当触发器，用 `get*()` 读所有 symbol 的当下值

### 3.4 activity vs freshness vs runtime status

| 字段 | 语义 | 出现在 |
|---|---|---|
| `activity` | `"active"` 表示 SDK 仍在维护；`"inactive"` 表示已退订或未订阅 | 所有 `*DataStatus` |
| `freshness` | market 数据的新鲜度：`"fresh"` / `"stale"` / `"reconciling"` | `MarketDataStatus` |
| `runtimeStatus` | 私有链路运行态：`"bootstrap_pending"` / `"healthy"` / `"degraded"` / `"reconnecting"` / `"reconciling"` / `"stopped"` | `AccountDataStatus`、`OrderDataStatus` |

退订后 `activity` 变为 `"inactive"`，但最后一份快照仍可读——不要把它当实时值。

### 3.5 BigNumber 约定

输出侧的价格、数量、金额统一是 `BigNumber`（来自 [bignumber.js](https://github.com/MikeMcl/bignumber.js)，SDK 已 re-export）：

```ts
import { BigNumber } from "@imbingox/acex";

const book = client.market.getL1Book({ venue, symbol });
const spread = book!.askPrice.minus(book!.bidPrice); // BigNumber
console.log(spread.toFixed());
```

**输入侧不对称**：`createOrder()` 的 `price` / `amount` 仍接受 decimal string。这是为了让调用方直接从交易所精度（`MarketDefinition.priceStep` / `amountStep`）做字符串格式化，不必先转 BigNumber 再转字符串。

## 4. Client 生命周期

### 4.1 `createClient(options?)`

```ts
function createClient(options?: CreateClientOptions): AcexClient;
```

只创建对象，不建立任何网络连接。`CreateClientOptions` 见 [§9 数据类型参考](#9-数据类型参考)。

运行时真正生效的配置当前是 `market.*` 与 `account.*`：

```ts
const client = createClient({
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
    },
    juplend: {
      pollIntervalMs: 30_000,
    },
  },
});
```

`sandbox`、`logger`、`logLevel` 是预留位，当前不生效。

### 4.2 `start()` / `stop()`

```ts
await client.start();
// ...
await client.stop();
await client.stop({ graceful: true, timeoutMs: 5_000 });
```

Client 状态机：`idle → starting → running → stopping → stopped`，可通过 `client.getStatus()` 读取。`start()` / `stop()` 都幂等。

在 `start()` 之前调 `subscribe*()` 会直接失败，抛 `CLIENT_NOT_STARTED`。

### 4.3 Venue capabilities

```ts
const binance = client.getVenueCapabilities("binance");
const allVenues = client.listVenueCapabilities();
```

`getVenueCapabilities()` / `listVenueCapabilities()` 不需要 `start()`，也不会建立网络连接。返回值表达的是 **当前 SDK runtime 已实现能力**，不是交易所官网完整能力，也不会检查 API key 是否开通交易权限。

典型用途是在 UI 或策略启动前预检查 venue 能力：

```ts
if (!client.getVenueCapabilities("juplend").order.supported) {
  // Juplend 是只读 lending 账户，不能通过 OrderManager 下单
}
```

当前 venue 级能力摘要：

| Venue | runtimeStatus | readOnly | Market | Account | Order |
|---|---|---:|---|---|---|
| `binance` | `available` | false | catalog / L1 支持；funding rate 为 `market_dependent` | WebSocket 私有账户流 | 支持 `limit` / `market` 下单、撤单、按 symbol 全撤 |
| `juplend` | `available` | true | 不支持 | polling 只读 lending 账户 | 不支持，`reason = "read_only"` |
| `okx` / `bybit` / `gate` | `type_only` | false | 当前未实现 | 当前未实现 | 当前未实现，`reason = "not_implemented"` |

第一版只提供 venue 级查询，不提供 symbol/market 级 capability。像 funding rate 这类依赖 market type 的能力会用 `market_dependent` 表达，具体 symbol 仍以实际 `subscribeFundingRate()` / `MARKET_FUNDING_RATE_UNSUPPORTED` 为准。

Binance 的 `order.supported = true` 只表示当前 SDK 有 Binance 订单命令链路；第一版命令固定走 Binance PAPI UM，主要面向 USDⓈ-M symbol，不代表 Binance spot、COIN-M 或交割合约都可通过 `OrderManager` 下单。需要按具体 symbol 预检时，应等后续 market-level capability。

### 4.4 账户注册

```ts
await client.registerAccount({
  accountId: "main-binance",
  venue: "binance",
  credentials: { apiKey, secret },
});

await client.updateAccountCredentials("main-binance", { apiKey, secret });

await client.removeAccount("main-binance");
```

`RegisterAccountInput` 是按 `venue` 区分的 union。不同 venue 的初始化参数不同，TypeScript 会在注册时提示/校验：

```ts
await client.registerAccount({
  accountId: "main-binance",
  venue: "binance",
  credentials: { apiKey, secret },
  options: {
    recvWindow: 5000,
    timestamp: Date.now(),
  },
});

await client.registerAccount({
  accountId: "jup-loop-a",
  venue: "juplend",
  credentials: { apiKey: jupiterApiKey },
  options: {
    walletAddress,
    positionId: "101", // 可选；不传则聚合该钱包全部 Juplend positions
  },
});
```

约束：

- `accountId` 在单个 `AcexClient` 实例内全局唯一。重复注册抛 `ACCOUNT_ALREADY_EXISTS`
- 凭证校验发生在 `subscribeAccount()` / `subscribeOrders()` 时，不是注册时
- `updateAccountCredentials()` 可以在私有订阅活跃时调用，SDK 会按需重建私有链路
- `removeAccount()` 比 `unsubscribeAccount()` 更彻底：账户配置、凭证、账户级缓存都会清理
- Juplend 的 `accountId` 是自定义逻辑账户名；Solana 钱包地址必须放在 `options.walletAddress`，可用 `options.positionId` 把同钱包下单个 NFT position 映射为独立账户

### 4.5 `getStatus()` / `getHealth()`

```ts
client.getStatus();   // ClientStatus
client.getHealth();   // ClientHealthSnapshot（聚合所有 market/account/order 状态）
```

## 5. MarketManager

```ts
interface MarketManager {
  readonly events: MarketEventStreams;

  loadMarkets(): Promise<void>;
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

```ts
await client.market.loadMarkets();

const all = client.market.listMarkets();
const binanceOnly = client.market.listMarkets("binance");

const btcPerp = client.market.getMarket("binance", "BTC/USDT:USDT");
const allBtcPerp = client.market.getMarkets("BTC/USDT:USDT");
```

`getMarkets(symbol)` 严格按完整统一 symbol 匹配。

`MarketDefinition` 见 [§9](#9-数据类型参考)。价格/数量相关字段（`priceStep`、`amountStep`、`contractSize`、`minAmount`、`minNotional`）都是 `BigNumber`。

归一化下单价格和数量：

```ts
await client.market.loadMarkets();

const normalized = client.market.normalizeOrderInput({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  price: "101000.123456789",
  amount: "0.010987654321",
});

if (normalized.accepted) {
  await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: normalized.price,
    amount: normalized.amount,
  });
}
```

`normalizeOrderInput()` 会按该 market 的 `priceStep` / `amountStep` 向下取整，返回 decimal string，避免浮点科学计数法；并基于归一化后的值检查 `minAmount` / `minNotional`。

如果归一化后的结果不满足最小下单条件，接口不会抛错，而是返回 `accepted: false` 和 `rejectReason`，调用方应避免继续下单：

```ts
const normalized = client.market.normalizeOrderInput({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
  price: "1000.09",
  amount: "0.0049",
});

// 示例返回：
// {
//   price: "1000",
//   amount: "0.004",
//   rawPrice: "1000.09",
//   rawAmount: "0.0049",
//   adjusted: true,
//   accepted: false,
//   rejectReason: "notional_below_min",
//   priceStep: "0.1",
//   amountStep: "0.001",
//   minAmount: "0.001",
//   minNotional: "5"
// }
```

`rejectReason` 当前可能是：`price_not_positive`、`amount_not_positive`、`amount_below_min`、`notional_below_min`。

**统一 symbol 约定：**

| 格式 | 含义 | 示例 |
|---|---|---|
| `BASE/QUOTE` | 现货 | `BTC/USDT` |
| `BASE/QUOTE:SETTLE` | USDⓈ-M 永续 | `BTC/USDT:USDT` |
| `BASE/USD:BASE` | COIN-M 永续 | `BTC/USD:BTC` |
| `BASE/USD:BASE-YYYYMMDD` | COIN-M 交割 | `BTC/USD:BTC-20250627` |

`subscribeL1Book()` 内部会自动确保 catalog 已加载，所以不必手动先 `loadMarkets()`；只在需要枚举或读取精度字段时主动调用。

### 5.2 L1 Book

```ts
await client.market.subscribeL1Book({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

const book = client.market.getL1Book({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

if (book) {
  const spread = book.askPrice.minus(book.bidPrice);
  console.log(`spread=${spread.toFixed()}`);
}
```

消费增量事件：

```ts
for await (const event of client.market.events.l1BookUpdates({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
})) {
  console.log(event.snapshot.bidPrice.toFixed());
}
```

不传 filter 会拿到所有 symbol 的更新：

```ts
for await (const event of client.market.events.l1BookUpdates()) {
  console.log(event.venue, event.symbol);
}
```

**事件当触发器模式**（跨 symbol 决策推荐）：

```ts
const pairs = [
  { venue: "binance", symbol: "BTC/USDT:USDT" },
  { venue: "binance", symbol: "BTC/USD:BTC" },
];

for (const pair of pairs) await client.market.subscribeL1Book(pair);

for await (const _ of client.market.events.l1BookUpdates()) {
  const books = pairs.map((p) => ({ ...p, book: client.market.getL1Book(p) }));
  if (books.some((b) => !b.book)) continue;
  // 用 books 里的最新值做决策
}
```

退订：

```ts
await client.market.unsubscribeL1Book({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});
```

退订后最后一份快照仍可读，但 `getMarketStatus().activity` 变为 `"inactive"`。

L1 Book 支持动态重复 `subscribe` / `unsubscribe`；对同一个 market 重复 `subscribeL1Book()` 不会重复开流，退订后再次订阅会恢复维护。

### 5.3 Funding Rate

Funding Rate 当前通过 Binance mark price websocket 实时更新，仅支持永续合约（`MarketDefinition.type === "swap"`）。订阅 spot 或交割合约会抛出 `MARKET_FUNDING_RATE_UNSUPPORTED`。

```ts
await client.market.subscribeFundingRate({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

const funding = client.market.getFundingRate({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

if (funding) {
  console.log(funding.fundingRate.toFixed());
  console.log(funding.markPrice?.toFixed());
  console.log(funding.indexPrice?.toFixed());
  console.log(funding.nextFundingTime);
  console.log(funding.status.freshness);
}
```

消费增量事件：

```ts
for await (const event of client.market.events.fundingRateUpdates({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
})) {
  console.log(event.snapshot.fundingRate.toFixed());
}
```

字段映射来自 Binance mark price stream：`r` → `fundingRate`，`p` → `markPrice`，`i` → `indexPrice`，`T` → `nextFundingTime`，`E` → `exchangeTs`。

Funding Rate 也支持动态重复 `subscribe` / `unsubscribe`；对同一个 market 重复 `subscribeFundingRate()` 不会重复开流，退订后再次订阅会恢复维护。

### 5.4 订阅状态

```ts
const status = client.market.getMarketStatus({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

if (status) {
  status.activity;       // "active" | "inactive"
  status.ready;          // 首次 ready 是否完成
  status.freshness;      // "fresh" | "stale" | "reconciling"
  status.lastReceivedAt; // 最后收到数据的时间
  status.reason;         // "ws_disconnected" | "heartbeat_timeout" | "reconciling"
}
```

`getMarketStatus()` 是 `(venue, symbol)` 级聚合状态：同一个 market 下任意 active stream（例如 L1 Book 或 Funding Rate）变 stale，聚合状态也会 stale。更精确的下游判断应优先读取快照自带的 stream 级状态：

```ts
const book = client.market.getL1Book({ venue, symbol });
book?.status.freshness; // 只代表 L1 Book stream

const funding = client.market.getFundingRate({ venue, symbol });
funding?.status.freshness; // 只代表 Funding Rate stream
```

`freshness` 区分两种异常：

- `ws_disconnected`：底层连接已断
- `heartbeat_timeout`：连接仍在但长时间没收到消息

自动重连由 SDK 负责，调用方不需要手工处理。

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

### 6.1 订阅与退订

```ts
await client.account.subscribeAccount({ accountId: "main-binance" });
await client.account.unsubscribeAccount({ accountId: "main-binance" });
```

- 调用前需要先 `registerAccount()`
- 凭证不足抛 `CREDENTIALS_MISSING`
- bootstrap 失败抛 `ACCOUNT_BOOTSTRAP_FAILED`

### 6.2 读快照

```ts
const snapshot = client.account.getAccountSnapshot("main-binance");
// AccountSnapshot.balances 是 Record<string, BalanceSnapshot>（按 asset 索引）

const balances = client.account.getBalances("main-binance");
// BalanceSnapshot[]（数组视图）

const usdt = client.account.getBalance("main-binance", "USDT");
// BalanceSnapshot | undefined

const positions = client.account.getPositions("main-binance");
const btcPosition = client.account.getPosition({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "long", // 双向持仓时必传；单向持仓可省略
});

const risk = client.account.getRiskSnapshot("main-binance");
```

所有数量字段（`free` / `used` / `total` / `size` / `entryPrice` / `netEquity` / `riskEquity` / ...）都是 `BigNumber`。

`RiskSnapshot.netEquity` 表示不含风控折算的净资产价值；`riskEquity` 表示抵押系数或清算阈值折算后的风控净权益。Binance 使用 `actualEquity` / `accountEquity` 映射这两个字段；Juplend 使用 `totalCollateralUsd - totalDebtUsd` / `Σ(suppliedValue × liquidationThreshold) - totalDebtUsd`。

> **注意**：`AccountSnapshot.balances` 是 `Record<string, BalanceSnapshot>`，不是数组；需要数组视图用 `getBalances()`。

### 6.3 事件

```ts
for await (const event of client.account.events.updates({
  accountId: "main-binance",
})) {
  switch (event.type) {
    case "balance.updated":
      console.log(event.asset, event.snapshot.free.toFixed());
      break;
    case "position.updated":
      console.log(event.symbol, event.snapshot.size.toFixed());
      break;
    case "risk.updated":
      console.log(event.snapshot.riskRatio?.toFixed());
      break;
    case "account.snapshot_replaced":
      // 私有链路重连/重对账后的全量替换
      break;
  }
}
```

### 6.4 订阅状态

```ts
const status = client.account.getAccountStatus("main-binance");
status?.runtimeStatus;
// "bootstrap_pending" | "healthy" | "degraded" | "reconnecting" | "reconciling" | "stopped"
status?.reason;
// "credentials_missing" | "auth_failed" | "http_failed" | "rate_limited" | "ws_disconnected" | "heartbeat_timeout" | "reconciling"
```

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

### 7.1 订阅订单流

```ts
await client.order.subscribeOrders({ accountId: "main-binance" });
await client.order.unsubscribeOrders({ accountId: "main-binance" });
```

- 需要先 `registerAccount()`
- 凭证不足抛 `CREDENTIALS_MISSING`
- bootstrap（open orders 拉取）失败抛 `ORDER_BOOTSTRAP_FAILED`

### 7.2 读快照

```ts
const openOrders = client.order.getOpenOrders("main-binance");
const btcOrders = client.order.getOpenOrders("main-binance", "BTC/USDT:USDT");

const order = client.order.getOrder({
  accountId: "main-binance",
  orderId: "12345",
  // 或 clientOrderId: "my-order-1"
});

const status = client.order.getOrderStatus("main-binance");
```

### 7.3 下单

`createOrder()` 第一版支持 `limit` / `market` 两种类型。`price` / `amount` 是 decimal string。

```ts
const limit = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71830.6",
  amount: "0.001",
  clientOrderId: "my-order-1", // 可选
  reduceOnly: false,           // 可选
  postOnly: true,              // 可选：仅限 limit，Binance 映射为 GTX
});

const market = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "sell",
  type: "market",
  amount: "0.001",
});
```

**双向持仓模式（hedge mode）必须显式传 `positionSide`**：

```ts
const hedge = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71900.9",
  amount: "0.001",
  positionSide: "long", // "long" | "short"
});
```

单向持仓模式可以省略 `positionSide`，返回的 snapshot 通常归一成 `"net"`。

`postOnly` 仅对 `limit` 单有效；当前 Binance PAPI UM adapter 会把普通 limit 单映射为 `timeInForce=GTC`，把 `postOnly: true` 映射为 `timeInForce=GTX`。

失败时抛 `ORDER_CREATE_FAILED`；输入本身不合法（比如 limit 单缺 price）抛 `ORDER_INPUT_INVALID`。

### 7.4 撤单

```ts
const canceled = await client.order.cancelOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  orderId: "12345",
  // 或 clientOrderId: "my-order-1"
});

const batch = await client.order.cancelAllOrders({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT", // 当前必填，不支持账户级全撤
});
```

`cancelOrder()` 要求 `orderId` / `clientOrderId` 至少一个，否则本地校验失败抛 `ORDER_INPUT_INVALID`。命令失败抛 `ORDER_CANCEL_FAILED` / `ORDER_CANCEL_ALL_FAILED`。

### 7.5 命令结果 vs 事件流

- `createOrder()` / `cancelOrder()` resolve 的是 **REST 成功后标准化的 `OrderSnapshot`**
- `events.updates()` 是订单的 **后续生命周期变化流**，不是唯一 ack 来源

也就是说，命令 resolve 不代表订单已终结。想追踪完整生命周期（部分成交 → 完全成交 / 撤销 / 拒绝）要同时消费事件。

### 7.6 事件

```ts
for await (const event of client.order.events.updates({
  accountId: "main-binance",
})) {
  switch (event.type) {
    case "order.updated":
      console.log("更新", event.snapshot.status, event.snapshot.filled.toFixed());
      break;
    case "order.filled":
      console.log("全部成交", event.snapshot.avgFillPrice?.toFixed());
      break;
    case "order.canceled":
      console.log("已撤单");
      break;
    case "order.rejected":
      console.log("被拒绝");
      break;
    case "order.snapshot_replaced":
      // 私有链路重连/重对账后的全量订单集合替换
      break;
  }
}
```

### 7.7 Binance PAPI UM 精度约束

`price` / `amount` 必须满足 `MarketDefinition.priceStep`、`amountStep`、`minAmount`、`minNotional`。**SDK 第一版不自动纠偏**——调用方自己用这些字段做字符串格式化。违反约束的订单会被交易所拒绝，SDK 对外表现为对应命令失败。

## 8. 健康与错误事件

### 8.1 `getHealth()`

```ts
const health = client.getHealth();
// {
//   clientStatus: "running",
//   markets: MarketDataStatus[],
//   accounts: AccountDataStatus[],
//   orders: OrderDataStatus[],
//   updatedAt: 1710000000000,
// }
```

### 8.2 `events.health()`

```ts
for await (const event of client.events.health()) {
  switch (event.type) {
    case "client.status_changed":
      console.log("client", event.status);
      break;
    case "market.status_changed":
      console.log("market", event.venue, event.symbol, event.status.activity);
      break;
    case "account.status_changed":
      console.log("account", event.accountId, event.status.runtimeStatus);
      break;
    case "order.status_changed":
      console.log("order", event.accountId, event.status.runtimeStatus);
      break;
  }
}
```

可以用 `HealthEventFilter` 过滤：

```ts
// 只看 market 范围
for await (const e of client.events.health({ scope: "market" })) { /* ... */ }

// 只看某个 venue
for await (const e of client.events.health({ venue: "binance" })) { /* ... */ }

// 只看某个 account
for await (const e of client.events.health({ accountId: "main-binance" })) { /* ... */ }
```

### 8.3 `events.errors()`

```ts
for await (const err of client.events.errors()) {
  console.error(`[${err.source}] ${err.error.message}`, {
    venue: err.venue,
    accountId: err.accountId,
    symbol: err.symbol,
  });
}
```

`AcexInternalError.source` 枚举：`"client" | "market" | "account" | "order" | "adapter" | "runtime"`。适合桥接到日志或告警系统。

## 9. 数据类型参考

所有 public 类型都从包顶层 import：

```ts
import type {
  Venue, ClientStatus, CreateClientOptions, VenueCapabilities,
  VenueRuntimeStatus, VenueCapabilitySupport, VenueCapabilityReason,
  FundingRateCapability, PrivateUpdateCapability,
  CancelAllOrdersCapability, PositionSideCapability,
  OrderTimeInForceCapability,
  AccountCredentials,
  MarketDefinition, L1Book, FundingRateSnapshot, MarketDataStatus,
  MarketDataStreamStatus,
  BalanceSnapshot, PositionSnapshot, RiskSnapshot, AccountSnapshot,
  AccountDataStatus, CreateOrderInput, CancelOrderInput, CancelAllOrdersInput,
  OrderSnapshot, OrderDataStatus, OrderSide, OrderStatus, PositionSide,
  MarketEvent, AccountEvent, OrderEvent, HealthEvent,
  AcexInternalError,
} from "@imbingox/acex";
import { BigNumber, AcexError } from "@imbingox/acex";
```

### 9.1 基础

```ts
const SUPPORTED_VENUES = ["binance", "okx", "bybit", "gate", "juplend"] as const;
type Venue = (typeof SUPPORTED_VENUES)[number];

type ClientStatus = "idle" | "starting" | "running" | "stopping" | "stopped";
type VenueRuntimeStatus = "available" | "type_only" | "reserved";
type VenueCapabilitySupport = "supported" | "unsupported";
type VenueCapabilityReason =
  | "not_implemented" | "read_only"
  | "market_type_unsupported" | "sdk_reserved";

type SubscriptionActivity = "active" | "inactive";
type MarketFreshness = "fresh" | "stale" | "reconciling";
type PrivateRuntimeStatus =
  | "bootstrap_pending" | "healthy" | "degraded"
  | "reconnecting" | "reconciling" | "stopped";
type PrivateRuntimeReason =
  | "credentials_missing" | "auth_failed" | "http_failed" | "rate_limited"
  | "ws_disconnected" | "heartbeat_timeout" | "reconciling";

type OrderSide = "buy" | "sell";
type OrderStatus =
  | "open" | "partially_filled" | "filled"
  | "canceled" | "rejected" | "expired";
type PositionSide = "long" | "short" | "net";
type CreateOrderType = "limit" | "market";
type MarketType = "spot" | "swap" | "future";
```

### 9.2 Client 配置

```ts
interface MarketRuntimeOptions {
  l1InitialMessageTimeoutMs?: number; // 默认 15_000
  l1StaleAfterMs?: number;            // 默认 15_000
  l1ReconnectDelayMs?: number;        // 默认 1_000
  l1ReconnectMaxDelayMs?: number;     // 默认 10_000
}

interface AccountRuntimeOptions {
  streamOpenTimeoutMs?: number;
  streamReconnectDelayMs?: number;
  streamReconnectMaxDelayMs?: number;
  listenKeyKeepAliveMs?: number;
  binance?: {
    riskPollIntervalMs?: number; // 默认 5_000
  };
  juplend?: {
    pollIntervalMs?: number;
  };
}

interface CreateClientOptions {
  sandbox?: boolean;   // 预留，当前不生效
  logger?: Logger;     // 预留
  logLevel?: LogLevel; // 预留
  market?: MarketRuntimeOptions;
  account?: AccountRuntimeOptions;
}

interface AccountCredentials {
  apiKey?: string;
  secret?: string;
  password?: string;
  extra?: Record<string, string>;
}

interface BinanceAccountOptions {
  timestamp?: number;
  recvWindow?: number;
}

interface JuplendAccountCredentials {
  apiKey: string;
}

interface JuplendAccountOptions {
  walletAddress: string;
  positionId?: string;
}

type RegisterAccountInput =
  | {
      accountId: string;
      venue: "binance" | "okx" | "bybit" | "gate";
      credentials?: AccountCredentials;
      options?: BinanceAccountOptions;
    }
  | {
      accountId: string;
      venue: "juplend";
      credentials: JuplendAccountCredentials;
      options: JuplendAccountOptions;
    };

interface RegisterAccountResult {
  accountId: string;
  venue: Venue;
}

interface StopOptions {
  graceful?: boolean;
  timeoutMs?: number;
}
```

### 9.2.1 Venue Capabilities

```ts
type FundingRateCapability =
  | VenueCapabilitySupport
  | "market_dependent";

type PrivateUpdateCapability =
  | "websocket"
  | "polling"
  | "unsupported";

type CancelAllOrdersCapability =
  | "symbol"
  | "account"
  | "unsupported";

type PositionSideCapability =
  | "optional"
  | "required_for_hedge"
  | "unsupported";

type OrderTimeInForceCapability = "gtc" | "post_only";

interface VenueCapabilities {
  venue: Venue;
  runtimeStatus: VenueRuntimeStatus;
  readOnly: boolean;
  notes: string[];
  market: {
    catalog: VenueCapabilitySupport;
    l1Book: VenueCapabilitySupport;
    fundingRate: FundingRateCapability;
    marketTypes: MarketType[];
  };
  account: {
    register: VenueCapabilitySupport;
    snapshot: VenueCapabilitySupport;
    updates: PrivateUpdateCapability;
    balances: VenueCapabilitySupport;
    positions: VenueCapabilitySupport;
    risk: VenueCapabilitySupport;
    lending: VenueCapabilitySupport;
    credentialsRequired: boolean;
  };
  order: {
    supported: boolean;
    openOrders: VenueCapabilitySupport;
    updates: PrivateUpdateCapability;
    create: VenueCapabilitySupport;
    cancel: VenueCapabilitySupport;
    cancelAll: CancelAllOrdersCapability;
    orderTypes: CreateOrderType[];
    timeInForce: OrderTimeInForceCapability[];
    postOnly: boolean;
    reduceOnly: boolean;
    positionSide: PositionSideCapability;
    clientOrderId: boolean;
    reason?: VenueCapabilityReason;
  };
}
```

### 9.3 Market

```ts
interface MarketDefinition {
  venue: Venue;
  symbol: string;           // 统一 symbol
  id: string;               // 交易所原始 symbol
  type: MarketType;
  base: string;
  quote: string;
  settle?: string;
  active: boolean;
  contract: boolean;
  linear?: boolean;
  inverse?: boolean;
  contractSize?: BigNumber;
  pricePrecision: number;
  amountPrecision: number;
  priceStep: BigNumber;
  amountStep: BigNumber;
  minAmount?: BigNumber;
  minNotional?: BigNumber;
  expiry?: number;
  raw: Record<string, unknown>;
}

interface MarketKeyInput {
  venue: Venue;
  symbol: string;
}

type DecimalInput = string | number | BigNumber;

type NormalizeOrderInputRejectReason =
  | "price_not_positive"
  | "amount_not_positive"
  | "amount_below_min"
  | "notional_below_min";

interface NormalizeOrderInputInput extends MarketKeyInput {
  price: DecimalInput;
  amount: DecimalInput;
}

interface NormalizedOrderInput {
  price: string;
  amount: string;
  rawPrice: string;
  rawAmount: string;
  adjusted: boolean;
  accepted: boolean;
  rejectReason?: NormalizeOrderInputRejectReason;
  priceStep: string;
  amountStep: string;
  minAmount?: string;
  minNotional?: string;
}

interface SubscribeL1BookInput extends MarketKeyInput {}

interface SubscribeFundingRateInput extends MarketKeyInput {}

interface MarketEventFilter {
  venue?: Venue;
  symbol?: string;
}

interface L1Book {
  venue: Venue;
  symbol: string;
  bidPrice: BigNumber;
  bidSize: BigNumber;
  askPrice: BigNumber;
  askSize: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
  status: MarketDataStreamStatus;
}

interface FundingRateSnapshot {
  venue: Venue;
  symbol: string;
  fundingRate: BigNumber;
  nextFundingTime?: number;
  markPrice?: BigNumber;
  indexPrice?: BigNumber;
  exchangeTs?: number;
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

interface MarketDataStatus {
  venue: Venue;
  symbol: string;
  activity: SubscriptionActivity;
  ready: boolean;
  freshness?: MarketFreshness;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: "ws_disconnected" | "heartbeat_timeout" | "reconciling";
}
```

### 9.4 Account

```ts
interface BalanceSnapshot {
  accountId: string;
  venue: Venue;
  asset: string;
  free: BigNumber;
  used: BigNumber;
  total: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: LendingBalanceFacet;
}

interface LendingBalanceFacet {
  supplied: BigNumber;
  borrowed: BigNumber;
  interest: BigNumber;
  netAsset: BigNumber;
  supplyAPY?: BigNumber;
  borrowAPY?: BigNumber;
}

interface PositionSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  side: PositionSide;
  size: BigNumber;
  entryPrice?: BigNumber;
  markPrice?: BigNumber;
  unrealizedPnl?: BigNumber;
  leverage?: BigNumber;
  liquidationPrice?: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  netEquity?: BigNumber;
  riskEquity?: BigNumber;
  riskRatio?: BigNumber;
  riskLeverage?: BigNumber;
  initialMargin?: BigNumber;
  maintenanceMargin?: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  lending?: LendingRiskFacet;
}

interface LendingRiskFacet {
  marginLevel?: BigNumber;
  healthFactor?: BigNumber;
  ltv?: BigNumber;
  liquidationThreshold?: BigNumber;
  totalCollateralUSD?: BigNumber;
  totalDebtUSD?: BigNumber;
}

interface AccountSnapshot {
  accountId: string;
  venue: Venue;
  balances: Record<string, BalanceSnapshot>; // 按 asset 索引
  positions: PositionSnapshot[];
  risk?: RiskSnapshot;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}

interface AccountDataStatus {
  accountId: string;
  venue: Venue;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: PrivateRuntimeReason;
}
```

### 9.5 Order

```ts
// limit / market 两个 variant
type CreateOrderInput =
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "limit";
      price: string;   // decimal string
      amount: string;  // decimal string
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
      amount: string;  // decimal string
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

interface GetOrderInput {
  accountId: string;
  orderId?: string;
  clientOrderId?: string;
}

interface OrderSnapshot {
  accountId: string;
  venue: Venue;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: string;              // 交易所原始 type 字符串
  status: OrderStatus;
  price?: BigNumber;
  triggerPrice?: BigNumber;
  amount: BigNumber;
  filled: BigNumber;
  remaining?: BigNumber;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
  avgFillPrice?: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

interface OrderDataStatus {
  accountId: string;
  venue: Venue;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: PrivateRuntimeReason;
}
```

### 9.6 事件

```ts
// Market
type MarketEvent =
  | { type: "l1_book.updated"; venue: Venue; symbol: string; snapshot: L1Book; ts: number }
  | { type: "funding_rate.updated"; venue: Venue; symbol: string; snapshot: FundingRateSnapshot; ts: number }
  | { type: "market.status_changed"; venue: Venue; symbol: string; status: MarketDataStatus; ts: number };

// Account
type AccountEvent =
  | { type: "balance.updated"; accountId: string; venue: Venue; ts: number; asset: string; snapshot: BalanceSnapshot }
  | { type: "position.updated"; accountId: string; venue: Venue; ts: number; symbol: string; snapshot: PositionSnapshot }
  | { type: "risk.updated"; accountId: string; venue: Venue; ts: number; snapshot: RiskSnapshot }
  | { type: "account.snapshot_replaced"; accountId: string; venue: Venue; ts: number; snapshot: AccountSnapshot };

// Order
type OrderEvent =
  | { type: "order.updated"; accountId: string; venue: Venue; symbol: string; ts: number; snapshot: OrderSnapshot }
  | { type: "order.filled"; accountId: string; venue: Venue; symbol: string; ts: number; snapshot: OrderSnapshot }
  | { type: "order.canceled"; accountId: string; venue: Venue; symbol: string; ts: number; snapshot: OrderSnapshot }
  | { type: "order.rejected"; accountId: string; venue: Venue; symbol: string; ts: number; snapshot: OrderSnapshot }
  | { type: "order.snapshot_replaced"; accountId: string; venue: Venue; ts: number; snapshot: OrderSnapshot[] };

// Health
type HealthEvent =
  | { type: "client.status_changed"; status: ClientStatus; ts: number }
  | { type: "market.status_changed"; venue: Venue; symbol: string; status: MarketDataStatus; ts: number }
  | { type: "account.status_changed"; accountId: string; venue: Venue; status: AccountDataStatus; ts: number }
  | { type: "order.status_changed"; accountId: string; venue: Venue; status: OrderDataStatus; ts: number };
```

过滤器：

```ts
interface MarketEventFilter  { venue?: Venue; symbol?: string; }
interface AccountEventFilter { accountId?: string; venue?: Venue; symbol?: string; }
interface OrderEventFilter   { accountId?: string; venue?: Venue; symbol?: string; }
interface HealthEventFilter  {
  scope?: "client" | "market" | "account" | "order";
  venue?: Venue;
  accountId?: string;
  symbol?: string;
}
```

### 9.7 错误

```ts
interface AcexInternalError {
  source: "client" | "market" | "account" | "order" | "adapter" | "runtime";
  venue?: Venue;
  accountId?: string;
  symbol?: string;
  error: Error;
  ts: number;
}

class AcexError extends Error {
  readonly code: AcexErrorCode;
}
```

## 10. 错误处理

可预期错误统一通过 `AcexError` 抛出，`code` 字段可用于分支判断：

```ts
import { AcexError } from "@imbingox/acex";

try {
  await client.market.subscribeL1Book({ venue: "binance", symbol: "X/Y:Z" });
} catch (err) {
  if (err instanceof AcexError) {
    console.log(err.code, err.message);
  }
}
```

完整错误码列表：

| Code | 典型场景 |
|---|---|
| `CLIENT_NOT_STARTED` | 未 `start()` 就调用 `subscribe*()` |
| `VENUE_NOT_SUPPORTED` | venue 当前未实现，或 Juplend 这类只读 venue 被用于下单 |
| `MARKET_CATALOG_LOAD_FAILED` | `loadMarkets()` 拉取失败 |
| `MARKET_NOT_FOUND` | 指定 symbol 不存在 |
| `MARKET_INACTIVE` | 指定 symbol 在 catalog 中但不可交易 |
| `MARKET_FUNDING_RATE_UNSUPPORTED` | 指定 market 不支持资金费率订阅 |
| `MARKET_STREAM_TIMEOUT` | market stream 首条消息超时 |
| `ACCOUNT_ALREADY_EXISTS` | 重复注册同一个 `accountId` |
| `ACCOUNT_NOT_FOUND` | `accountId` 未注册或已被移除 |
| `ACCOUNT_BOOTSTRAP_FAILED` | `subscribeAccount()` 过程中账户快照拉取失败，例如 Juplend HTTP/API 失败或缺 `options.walletAddress` |
| `CREDENTIALS_MISSING` | 私有订阅 / 下单缺必要凭证，例如 Binance 缺 `apiKey/secret` 或 Juplend 缺 `apiKey` |
| `ORDER_BOOTSTRAP_FAILED` | `subscribeOrders()` 过程中 open orders 拉取失败 |
| `ORDER_INPUT_INVALID` | 下单/撤单本地输入校验失败（如缺 price、缺 id） |
| `ORDER_CREATE_FAILED` | 交易所拒单 / REST 报错 |
| `ORDER_CANCEL_FAILED` | 撤单失败 |
| `ORDER_CANCEL_ALL_FAILED` | 批量撤单失败 |

## 11. 当前限制

- **Venue**：market/order 运行时只支持 `binance`；account 运行时支持 `binance` 与只读 `juplend`。`okx` / `bybit` / `gate` 仅在 `SUPPORTED_VENUES` 类型里声明，未接入
- **市场数据**：真实落地 Binance L1 Book（Spot + USDⓈ-M + COIN-M）和 Binance 永续 Funding Rate
- **私有链路**：Binance PAPI UM 使用 listenKey/WebSocket；Juplend 使用 HTTP polling，只提供账户只读视图
- **Juplend 写操作**：不支持 supply / borrow / repay / withdraw，不支持 `OrderManager` 下单撤单
- **Juplend 数量精度**：Portfolio API 提供 USD 聚合值，token 数量由 USD / vault oracle price 反算
- **Funding Rate**：仅永续合约支持，来自 mark price websocket；不支持现货和交割合约
- **下单类型**：`createOrder()` 仅支持 `limit` / `market`；条件单、改单不支持
- **撤单范围**：`cancelAllOrders()` 必须传 `symbol`，不支持账户级全撤
- **双向持仓**：hedge mode 下 `createOrder()` 必须显式传 `positionSide`
- **精度纠偏**：SDK 不自动按 `priceStep` / `amountStep` / `minNotional` 调整下单输入
- **Client options**：`sandbox` / `logger` / `logLevel` 是预留位，当前不生效
