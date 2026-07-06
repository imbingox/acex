# 快速接入

## 安装和初始化

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

## 订阅 Binance L1 Book

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
    console.log(event.snapshot.bidPrice ?? "no bid");
    break;
  }
} finally {
  l1Lease.close();
}
```

`acquireL1BookSubscription()` 只完成输入校验、market resolution 和 logical lease 注册；`lease.ready` 会等待该 lease 的底层 logical subscription 被交易所接受后 resolve，通常对应 subscribe ACK。如果交易所先推送了可确认属于该订阅的首条 data，也会视为订阅已建立。`lease.ready` 不保证 `getL1Book()` 已经有值；低流动性 symbol 可能已订阅成功但暂时没有首条 quote。L1 Book 的 `bidPrice` / `bidSize` / `askPrice` / `askSize` 是 nullable：有 ask 表示当前可按 ask 买入该腿，有 bid 表示当前可按 bid 卖出该腿，四个字段全为 `null` 表示交易所已推送当前无可执行报价。订阅 ACK 超时或被交易所拒绝会 reject `MARKET_STREAM_TIMEOUT`，并自动释放该 lease。释放订阅时调用 `lease.close()`，该方法幂等；只有最后一个 active lease 关闭后，SDK 才会关闭底层 websocket stream。

从旧版本迁移时，不要再把 `await lease.ready` 当作“已有完整双边报价”或“已有首份盘口”。它只表示订阅已经建立；执行前应先确认 `book !== undefined`，再按方向检查字段：买入检查 `askPrice !== null && askSize !== null`，卖出检查 `bidPrice !== null && bidSize !== null`。旧的 `status.reason` quote 状态已移除；交易所推送的空盘口由四个 bid/ask 字段全为 `null` 表达。

## 注册 Binance 交易账户

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

Binance 账户能力当前面向 PAPI UM / margin。账户风险字段会由私有 WS 事件和 `/papi/v1/account` + `/papi/v1/um/positionRisk` REST refresh 共同维护；默认每 60s 还会用 `/papi/v1/balance`、`/papi/v1/account`、`/papi/v1/um/positionRisk` 和订单 REST 接口做 private reconcile。Binance 全账户 `/papi/v1/um/openOrders` 与 `/papi/v1/margin/openOrders` 不带 symbol 时 request weight 较高，默认 60s 是保守值。读取余额、仓位或风险数据时必须订阅 `client.account.subscribeAccount()`；`client.order.subscribeOrders()` 只维护订单缓存，即使底层复用同一条 private WS，也不会维护 account 仓位缓存。

## 读取 Binance 风控档位并设置杠杆

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

## 注册 Juplend 只读账户

```ts
const client = createClient({
  account: {
    venues: {
      juplend: {
        pollIntervalMs: 30_000,
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

也可以在同一钱包返回的仓位里按 vault + position 过滤单仓：

```ts
await client.registerAccount({
  accountId: "jup-loop-filtered",
  venue: "juplend",
  options: {
    walletAddress: "<solana-wallet-address>",
    vaultId: "<vault-id>",
    positionId: "<nft-position-id>",
  },
});
```

Juplend 不需要私钥或 Solana RPC，不支持 supply / borrow / repay / withdraw。`accountId` 是 SDK 内的逻辑账户名，不是钱包地址。

## 下单和撤单

```ts
const order = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "60000",
  amount: "0.001",
  postOnly: true,
  clientOrderId: "client-001",
  um: {
    positionSide: "long",
  },
});

const marginOrder = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT",
  side: "buy",
  type: "market",
  amount: "0.001",
  margin: {
    sideEffectType: "auto_borrow_repay",
    autoRepayAtCancel: true,
  },
});

const canceled = await client.order.cancelOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  clientOrderId: "client-001",
});

const batch = await client.order.cancelAllOrders({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});
```

下单命令由 `accountId` 对应的 venue 决定，不在 order input 里再传 venue。Juplend 和 type-only venue 会被 runtime 拒绝。
