# @imbingox/acex

`acex` 是一个面向交易场景的状态型 SDK。调用方只需要持有一个 `AcexClient`，就可以通过统一的 `market`、`account`、`order` manager 读取最新快照、订阅增量事件、观察健康状态，并在当前 Binance MVP 范围内执行第一版下单/撤单命令，而不需要自己维护本地缓存、ready barrier 或 websocket 生命周期。

## 安装

```bash
bun add @imbingox/acex
```

## 完整用法

### 1. 创建 client

```ts
import { createClient } from "@imbingox/acex";
// SDK re-exports BigNumber，调用方无需单独安装 bignumber.js
import { BigNumber } from "@imbingox/acex";

const client = createClient();
```

`createClient` 接受一个可选的配置对象，当前真正生效的是 `market.*` 运行时参数：

```ts
const client = createClient({
  market: {
    l1InitialMessageTimeoutMs: 15_000, // L1 Book 首条消息超时（默认 15s）
    l1StaleAfterMs: 15_000,            // 多久没收到消息标记 stale（默认 15s）
    l1ReconnectDelayMs: 1_000,         // 断线重连初始延迟
    l1ReconnectMaxDelayMs: 10_000,     // 断线重连最大延迟（指数退避上限）
  },
});
```

> `sandbox`、`logger`、`logLevel` 已预留但当前未生效。

### 2. 生命周期

```ts
// 启动 client（必须在所有 subscribe 之前）
await client.start();

// ... 使用 client ...

// 停止 client（释放所有 websocket、订阅关系）
await client.stop();

// 也可以指定优雅退出选项
await client.stop({ graceful: true, timeoutMs: 5000 });
```

Client 的状态机：`idle` → `starting` → `running` → `stopping` → `stopped`。

可以通过 `client.getStatus()` 随时查看当前状态。

### 3. Market Catalog（市场列表）

加载市场列表后可以发现可用交易对、读取精度参数：

```ts
// 拉取并缓存所有交易所的 market catalog
await client.market.loadMarkets();

// 列出所有 market
const markets = client.market.listMarkets();
// → MarketDefinition[]

// 只列出指定交易所的 market
const binanceMarkets = client.market.listMarkets("binance");

// 按交易所 + 统一 symbol 查询单个 market
const btcPerp = client.market.getMarket("binance", "BTC/USDT:USDT");
// → MarketDefinition | undefined

// 查询一个 symbol 在所有交易所的 market（多交易所场景）
const allBtcPerp = client.market.findMarkets("BTC/USDT:USDT");
// → MarketDefinition[]
```

返回的 `MarketDefinition` 包含以下字段：

```ts
{
  exchange: "binance",
  symbol: "BTC/USDT:USDT",    // 统一 symbol
  id: "BTCUSDT",              // 交易所原始 symbol
  type: "swap",               // "spot" | "swap" | "future"
  base: "BTC",
  quote: "USDT",
  settle: "USDT",             // 结算币种（swap/future 才有）
  active: true,               // 是否可交易
  contract: true,             // 是否合约
  linear: true,               // U 本位
  inverse: false,             // 币本位
  contractSize: BigNumber(1),
  pricePrecision: 1,
  amountPrecision: 3,
  priceStep: BigNumber(0.10),          // 最小价格变动
  amountStep: BigNumber(0.001),        // 最小数量变动
  minNotional: BigNumber(5),           // 最小名义价值
  raw: { ... },               // 交易所原始数据
}
```

> 所有价格、数量、金额字段均为 `BigNumber` 类型（来自 [bignumber.js](https://github.com/MikeMcl/bignumber.js)），可直接进行算术运算。

**统一 symbol 约定：**

| symbol 格式 | 含义 | 示例 |
|---|---|---|
| `BASE/QUOTE` | spot 现货 | `BTC/USDT` |
| `BASE/QUOTE:SETTLE` | USDⓈ-M 永续 | `BTC/USDT:USDT` |
| `BASE/USD:BASE` | COIN-M 永续 | `BTC/USD:BTC` |
| `BASE/USD:BASE-YYYYMMDD` | COIN-M 交割 | `BTC/USD:BTC-20250627` |

### 4. L1 Book（最优买卖价）

这是当前最核心的实时数据能力。

#### 订阅

```ts
// subscribeL1Book 是 ready barrier：
// await 返回后，getL1Book 已经可以拿到首个可用快照
await client.market.subscribeL1Book({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});
```

`subscribeL1Book` 会自动确保 market catalog 已加载，所以不必手动先调 `loadMarkets()`。

#### 读取快照

```ts
const book = client.market.getL1Book({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});

if (book) {
  console.log(book.bidPrice, book.bidSize); // 最优买（BigNumber）
  console.log(book.askPrice, book.askSize); // 最优卖（BigNumber）
  // 直接算术运算
  const spread = book.askPrice.minus(book.bidPrice);
  console.log(`spread: ${spread.toFixed()}`);
}
```

`L1Book` 完整结构：

```ts
{
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
  bidPrice: BigNumber("104321.50"),
  bidSize: BigNumber("1.234"),
  askPrice: BigNumber("104321.60"),
  askSize: BigNumber("0.567"),
  exchangeTs: 1710000000000,  // 交易所时间戳（可能为空）
  receivedAt: 1710000000001,  // SDK 收到时间
  updatedAt: 1710000000001,   // SDK 更新时间
  version: 42,                // 递增序号
}
```

> 所有价格和数量都是 `BigNumber` 类型，避免浮点精度问题，可直接进行算术运算。

#### 消费增量事件

```ts
// events.* 只消费事件，不会隐式触发订阅
// 必须先 subscribeL1Book 才会有数据流
for await (const event of client.market.events.l1BookUpdates({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
})) {
  console.log(event.snapshot.bidPrice, event.snapshot.askPrice);
}
```

也可以手动控制迭代器：

```ts
const iterator = client.market.events
  .l1BookUpdates({ exchange: "binance", symbol: "BTC/USDT:USDT" })
  [Symbol.asyncIterator]();

const { value, done } = await iterator.next();
if (!done) {
  console.log(value.snapshot);
}

// 不再消费时，释放迭代器
await iterator.return?.();
```

不传 filter 可以接收所有 symbol 的更新：

```ts
for await (const event of client.market.events.l1BookUpdates()) {
  console.log(event.exchange, event.symbol, event.snapshot.bidPrice);
}
```

#### 事件当触发器（推荐模式）

`event.snapshot` 是事件发生那一刻的快照，但由于事件异步消费，处理时内部状态可能已被更新。如果你需要同时读取多个 symbol 的最新价格（如套利、对冲），推荐把事件当触发器，用 `getL1Book()` 读最新值：

```ts
const pairs = [
  { exchange: "binance", symbol: "BTC/USDT:USDT" },
  { exchange: "binance", symbol: "BTC/USD:BTC" },
];

for (const pair of pairs) {
  await client.market.subscribeL1Book(pair);
}

// 不带 filter — 任何 symbol 变动都触发
for await (const event of client.market.events.l1BookUpdates()) {
  const books = pairs.map((pair) => ({
    ...pair,
    book: client.market.getL1Book(pair),
  }));

  if (books.some((b) => !b.book)) continue;

  // 所有 symbol 的最新价格，执行你的策略逻辑
  doSomething(books);
}
```

#### 查看订阅状态

```ts
const status = client.market.getMarketStatus({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});

if (status) {
  status.activity;      // "active" | "inactive"
  status.ready;         // 首次 ready 是否完成
  status.freshness;     // "fresh" | "stale" | "reconciling"
  status.lastReceivedAt; // 最后收到数据的时间
  status.reason;        // 变 stale 的原因: "ws_disconnected" | "heartbeat_timeout"
}
```

#### 退订

```ts
await client.market.unsubscribeL1Book({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});
```

退订后最后一份快照仍可读，但 `activity` 会变成 `"inactive"`。调用方不应把旧快照当成实时值。

### 5. Account（账户余额和仓位）

> 当前 account 已接通 Binance PAPI UM 私有链路，可读取余额、仓位、风险和账户状态。

```ts
// ① 注册账户（start 之前或之后均可）
await client.registerAccount({
  accountId: "main-binance",
  exchange: "binance",
  credentials: {
    apiKey: process.env.BINANCE_PAPI_API_KEY,
    secret: process.env.BINANCE_PAPI_SECRET,
  },
});

await client.start();

// ② 订阅账户数据流
await client.account.subscribeAccount({ accountId: "main-binance" });

// ③ 读取快照
const snapshot = client.account.getAccountSnapshot("main-binance");
// → AccountSnapshot | undefined

const balances = client.account.getBalances("main-binance");
// → BalanceSnapshot[]

const usdtBalance = client.account.getBalance("main-binance", "USDT");
// → BalanceSnapshot | undefined
// { asset: "USDT", free: BigNumber("1000.00"), used: BigNumber("200.00"), total: BigNumber("1200.00"), ... }

const positions = client.account.getPositions("main-binance");
// → PositionSnapshot[]

const btcPosition = client.account.getPosition({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "long",  // 可选，不传则返回第一个匹配
});
// → PositionSnapshot | undefined
// { symbol, side, size, entryPrice, markPrice, unrealizedPnl, leverage, ... }

const risk = client.account.getRiskSnapshot("main-binance");
// → RiskSnapshot | undefined
// { equity, marginRatio, initialMargin, maintenanceMargin, ... }

// ④ 消费增量事件
for await (const event of client.account.events.updates({
  accountId: "main-binance",
})) {
  switch (event.type) {
    case "balance.updated":
      console.log(event.asset, event.snapshot.free);
      break;
    case "position.updated":
      console.log(event.symbol, event.snapshot.size);
      break;
    case "risk.updated":
      console.log(event.snapshot.marginRatio);
      break;
    case "account.snapshot_replaced":
      console.log("全量快照替换");
      break;
  }
}

// ⑤ 退订 & 移除账户
await client.account.unsubscribeAccount({ accountId: "main-binance" });
await client.removeAccount("main-binance");
```

### 6. Order（订单）

> 当前 order 已接通 Binance PAPI UM 订单私有链路，并支持第一版交易命令：`createOrder()`、`cancelOrder()`、`cancelAllOrders()`。

```ts
// 订阅订单流（需要先 registerAccount）
await client.order.subscribeOrders({ accountId: "main-binance" });

// 读取所有挂单
const openOrders = client.order.getOpenOrders("main-binance");
// → OrderSnapshot[]

// 按 symbol 过滤挂单
const btcOrders = client.order.getOpenOrders("main-binance", "BTC/USDT:USDT");

// 按 orderId 或 clientOrderId 查询单笔
const order = client.order.getOrder({
  accountId: "main-binance",
  orderId: "12345",
});
// → OrderSnapshot | undefined
// { symbol, side, type, status, price, amount, filled, remaining, ... }

// 下单：第一版只支持 limit / market
const created = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71830.6",
  amount: "0.001",
});

// 如果账户是双向持仓模式（hedge mode），必须显式传 positionSide
const hedgeCreated = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71900.9",
  amount: "0.001",
  positionSide: "long",
});

// 撤单：需要 accountId + symbol，并提供 orderId / clientOrderId 其一
const canceled = await client.order.cancelOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  orderId: created.orderId,
});

// 某个 symbol 下全撤
const canceledAll = await client.order.cancelAllOrders({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

// 消费订单事件
for await (const event of client.order.events.updates({
  accountId: "main-binance",
})) {
  switch (event.type) {
    case "order.updated":
      console.log("订单更新", event.snapshot.status);
      break;
    case "order.filled":
      console.log("完全成交", event.snapshot.avgFillPrice);
      break;
    case "order.canceled":
      console.log("已撤单");
      break;
    case "order.rejected":
      console.log("被拒绝");
      break;
  }
}

// 退订
await client.order.unsubscribeOrders({ accountId: "main-binance" });
```

`createOrder()` / `cancelOrder()` resolve 的是 REST 成功后标准化的 `OrderSnapshot`；`events.updates()` 是后续生命周期变化流，不是唯一 ack 来源。

### 7. 健康监控

#### 全局健康快照

```ts
const health = client.getHealth();
// → ClientHealthSnapshot
// {
//   clientStatus: "running",
//   markets: MarketDataStatus[],   // 所有 market 订阅的状态
//   accounts: AccountDataStatus[], // 所有 account 订阅的状态
//   orders: OrderDataStatus[],     // 所有 order 订阅的状态
//   updatedAt: 1710000000000,
// }
```

#### 消费健康事件流

```ts
for await (const event of client.events.health()) {
  switch (event.type) {
    case "client.status_changed":
      console.log("client 状态变化:", event.status);
      break;
    case "market.status_changed":
      console.log("market 状态变化:", event.exchange, event.symbol);
      break;
    case "account.status_changed":
      console.log("account 状态变化:", event.accountId);
      break;
    case "order.status_changed":
      console.log("order 状态变化:", event.accountId);
      break;
  }
}
```

可以按 scope 过滤：

```ts
// 只关心 market 相关的健康变化
for await (const event of client.events.health({ scope: "market" })) {
  // ...
}

// 只关心特定交易所
for await (const event of client.events.health({ exchange: "binance" })) {
  // ...
}
```

#### 消费内部错误流

```ts
for await (const err of client.events.errors()) {
  console.error(`[${err.source}] ${err.error.message}`, {
    exchange: err.exchange,
    symbol: err.symbol,
    accountId: err.accountId,
  });
}
```

适合桥接到日志系统或告警系统。

### 8. 错误处理

SDK 的可预期错误统一通过 `AcexError` 抛出，包含结构化的 `code`：

```ts
import { AcexError } from "@imbingox/acex";

try {
  await client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "INVALID/PAIR",
  });
} catch (error) {
  if (error instanceof AcexError) {
    switch (error.code) {
      case "CLIENT_NOT_STARTED":
        // client 还没 start()
        break;
      case "MARKET_NOT_FOUND":
        // symbol 不存在
        break;
      case "MARKET_INACTIVE":
        // 市场存在但不可交易
        break;
      case "MARKET_STREAM_TIMEOUT":
        // L1 Book 首条消息超时
        break;
      case "EXCHANGE_NOT_SUPPORTED":
        // 交易所未支持
        break;
      case "MARKET_CATALOG_LOAD_FAILED":
        // market catalog 拉取失败
        break;
      case "ACCOUNT_ALREADY_EXISTS":
        // 重复注册同一个 accountId
        break;
      case "ACCOUNT_NOT_FOUND":
        // accountId 不存在
        break;
      case "CREDENTIALS_MISSING":
        // 私有订阅缺少凭证
        break;
    }
  }
}
```

## 完整示例

```ts
import { AcexError, createClient } from "@imbingox/acex";

async function main() {
  const client = createClient({
    market: {
      l1InitialMessageTimeoutMs: 15_000,
      l1StaleAfterMs: 15_000,
    },
  });

  await client.start();

  // 加载市场列表
  await client.market.loadMarkets();
  const symbols = client.market.listMarkets().map((m) => m.symbol);
  console.log(`共 ${symbols.length} 个交易对`);

  // 订阅 BTC 永续 L1 Book
  const exchange = "binance";
  const symbol = "BTC/USDT:USDT";

  await client.market.subscribeL1Book({ exchange, symbol });

  // 读取首个快照
  const book = client.market.getL1Book({ exchange, symbol });
  console.log(`BTC bid=${book?.bidPrice.toFixed()} ask=${book?.askPrice.toFixed()}`);

  // 持续消费 5 条更新后退出
  let count = 0;
  for await (const event of client.market.events.l1BookUpdates({
    exchange,
    symbol,
  })) {
    console.log(
      `#${++count} bid=${event.snapshot.bidPrice.toFixed()} ask=${event.snapshot.askPrice.toFixed()}`,
    );
    if (count >= 5) break;
  }

  await client.market.unsubscribeL1Book({ exchange, symbol });
  await client.stop();
}

main().catch((error) => {
  if (error instanceof AcexError) {
    console.error(error.code, error.message);
  } else {
    console.error(error);
  }
});
```

## 调用顺序总结

```
createClient()
  ↓
registerAccount()          ← 如需私有能力（可选）
  ↓
client.start()
  ↓
loadMarkets()              ← 如需市场列表（可选）
  ↓
subscribe*()               ← 开始维护数据
  ↓
get*() / events.*()        ← 读快照 / 消费增量
  ↓
unsubscribe*()             ← 释放订阅
  ↓
removeAccount()            ← 释放账户（可选）
  ↓
client.stop()
```

## 核心语义

| 概念 | 说明 |
|---|---|
| `get*()` | 读 SDK 本地快照，不阻塞、不发网络请求 |
| `events.*()` | 返回 `AsyncIterable`，持续消费增量变化 |
| `event.snapshot` vs `get*()` | `event.snapshot` 是事件发生时的快照；`get*()` 是调用时的最新值。跨 symbol 比较建议用 `get*()` |
| `subscribe*()` | ready barrier — `await` 返回时对应的 `get*()` 已可用 |
| `events.*()` 与 `subscribe*()` | 独立。`events` 不会隐式触发订阅，必须显式 `subscribe` |
| 退订后的缓存 | 最后一份快照仍可读，但 `activity` 变为 `"inactive"` |

## 当前限制

- 运行时真正支持的市场数据交易所只有 **Binance**（`okx`、`bybit`、`gate` 仅类型定义）
- 真实落地的 market 数据链路当前是 Binance **L1 Book**
- 私有账户与订单链路当前只支持 **Binance PAPI UM**
- `fundingRate` 接口已暴露，但当前是占位快照
- 第一版交易命令只支持 `createOrder()` / `cancelOrder()` / `cancelAllOrders()`
- `createOrder()` 当前只支持 `limit` / `market`
- 双向持仓模式账户下单时必须显式传 `positionSide`
- 条件单、改单、账户级全撤当前还不支持
- `CreateClientOptions` 中 `sandbox`、`logger`、`logLevel` 仍是预留位

## 仓库内开发

```bash
bun install
bun run lint
bun run type-check
bun test
```

### 发布流程

当前仓库使用 **Changesets + GitHub Actions + npm Trusted Publishing**：

1. 开发 PR 时，如果改动会影响用户，执行 `bun run changeset`
2. 按提示选择 `patch` / `minor` / `major`，并写一段对外 release note
3. PR merge 到 `main` 后，[release.yml](/projects/acex-feat-order_account/.github/workflows/release.yml) 会自动：
   - 安装依赖
   - 执行 `bun run lint`
   - 执行 `bun run type-check`
   - 执行 `bun run test`
   - 若存在未消费的 changeset，则创建或更新 release PR
4. merge release PR 后，同一条 workflow 会自动发布到 npm

当前仓库处于 Changesets 的 `beta` prerelease 模式，自动发布默认走 npm `beta` dist-tag。

npm 侧配置 Trusted Publisher 时，需要确保：

- workflow 文件名是 `release.yml`
- `package.json.repository.url` 必须直接写仓库地址，例如 `https://github.com/imbingox/acex`
- npm 包 settings 里绑定的是 GitHub Actions trusted publisher，而不是长期 `NPM_TOKEN`

真实 Binance 公网 smoke test 单独执行，不放进默认 `bun test`：

```bash
bun run test:live:market:smoke
bun run test:live:market:soak
bun run test:live:account:smoke
bun run test:live:account:soak
bun run test:live:order:smoke
bun run test:live:order:soak
```

这些脚本会验证：
- `market`：`loadMarkets()`、`subscribeL1Book()`、`getL1Book()` / `events.l1BookUpdates()`，以及可选的主动断线后自动重连
- `account`：Binance PAPI UM 账户 bootstrap、余额/仓位/风险投影、private stream 更新和可选重连
- `order`：open orders bootstrap、`subscribeOrders()`、订单事件投影和可选重连

约定：
- `smoke` 是快速连通性检查，默认跑 10 秒，不主动断线
- `soak` 是短时稳定性检查，默认跑 60 秒，并做一次主动断线重连验证

更完整的公开接口设计说明见 [docs/sdk-public-api.md](./docs/sdk-public-api.md)。
