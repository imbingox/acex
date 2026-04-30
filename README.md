# @imbingox/acex

`acex` 是一个面向交易场景的 **状态型** 多交易所 SDK。调用方持有一个 `AcexClient`，通过统一的 `market` / `account` / `order` manager 读取最新快照、消费增量事件、执行下单撤单命令；SDK 内部负责本地缓存、ready barrier、websocket 生命周期和自动重连，调用方不需要自己处理。

当前 MVP 只落地 Binance（Spot + USDⓈ-M + COIN-M 行情，PAPI UM 私有链路）。

## 安装

```bash
bun add @imbingox/acex
```

## 快速上手

### 行情（无需凭证）

```ts
import { createClient } from "@imbingox/acex";

const client = createClient();
await client.start();

await client.market.subscribeL1Book({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});

const book = client.market.getL1Book({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});
const books = client.market.getL1Books("BTC/USDT:USDT");
console.log(`bid=${book?.bidPrice.toFixed()} ask=${book?.askPrice.toFixed()}`);
console.log(`venues=${books.length}`);
console.log(`book freshness=${book?.status.freshness}`);

await client.market.subscribeFundingRate({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});

const funding = client.market.getFundingRate({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});
const fundingRates = client.market.getFundingRates("BTC/USDT:USDT");
console.log(`funding=${funding?.fundingRate.toFixed()}`);
console.log(`funding venues=${fundingRates.length}`);

for await (const event of client.market.events.l1BookUpdates({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
})) {
  console.log(event.snapshot.bidPrice.toFixed());
  break;
}

await client.stop();
```

### 账户与订单

```ts
const client = createClient();
await client.start();

await client.registerAccount({
  accountId: "main-binance",
  exchange: "binance",
  credentials: {
    apiKey: process.env.BINANCE_PAPI_API_KEY,
    secret: process.env.BINANCE_PAPI_SECRET,
  },
});

await client.account.subscribeAccount({ accountId: "main-binance" });
await client.order.subscribeOrders({ accountId: "main-binance" });

const created = await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71830.6",
  amount: "0.001",
});

await client.order.cancelOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  orderId: created.orderId,
});

await client.stop();
```

价格、数量等输出字段统一是 `BigNumber`；`createOrder()` 的 `price` / `amount` 输入仍接受 decimal string。详见手册 [§3 核心概念](./docs/api.md#3-核心概念)。

## 核心能力

| 能力 | 概述 | 详细文档 |
|---|---|---|
| **Market** | Market catalog、L1 Book / Funding Rate 订阅、增量事件、订阅状态与自动重连 | [docs/api.md §5](./docs/api.md#5-marketmanager) |
| **Account** | 账户快照、余额、持仓、风险投影与事件流 | [docs/api.md §6](./docs/api.md#6-accountmanager) |
| **Order** | open orders 投影、订单事件流，`createOrder` / `cancelOrder` / `cancelAllOrders` 第一版命令 | [docs/api.md §7](./docs/api.md#7-ordermanager) |
| **健康与错误** | `getHealth()`、`events.health()`、`events.errors()` | [docs/api.md §8](./docs/api.md#8-健康与错误事件) |

完整手册（接口签名、数据类型、错误码）：[docs/api.md](./docs/api.md)。

## 当前限制

- 运行时只支持 `binance`；`okx` / `bybit` / `gate` 仅类型定义
- 私有链路仅 Binance PAPI UM（统一账户 / Portfolio Margin）
- Funding Rate 仅支持 Binance 永续合约，来自 mark price websocket；不支持现货和交割合约
- `createOrder()` 只支持 `limit` / `market`；条件单、改单、账户级全撤不支持
- 双向持仓账户下单时必须显式传 `positionSide`
- `CreateClientOptions` 中 `sandbox` / `logger` / `logLevel` 是预留位

## 仓库内开发

```bash
bun install
bun run lint
bun run type-check
bun run test
```

### 测试分层

默认 `bun run test` 只运行快速、确定性的本地测试，不访问真实交易所：

| 命令 | 覆盖范围 | 是否进入默认 CI |
|------|----------|----------------|
| `bun run test:unit` | `tests/unit/`，底层工具和无全局副作用的单元测试 | 是 |
| `bun run test:integration` | `tests/integration/`，fake REST + fake WebSocket 的 SDK 跨层集成测试 | 是 |
| `bun run test` | `test:unit` + `test:integration` | 是 |
| `bun run test:soak` | `tests/soak/`，60 秒级稳定性/连续更新测试 | 否 |
| `bun run test:all` | 默认快速测试 + soak 测试 | 否 |

测试 support 结构：

- `tests/support/test-utils.ts`：通用 fake WebSocket、事件等待、Response helper 和全局清理。
- `tests/support/exchanges/binance.ts`：Binance 专用 REST/WS fixtures 与 installer。
- 新增交易所时，优先新增 `tests/support/exchanges/<exchange>.ts`，复用通用 helper，避免把交易所 payload 写进通用测试工具。

GitHub Actions 的 `CI` workflow 会在 PR 和 `main` push 时运行 lint、type-check、unit、integration；release workflow 继续复用 `bun run test`，不会执行 soak/live。

### 真实环境 smoke / soak 脚本

不进默认 `bun run test`，单独执行：

```bash
bun run test:live:market:smoke
bun run test:live:market:soak
bun run test:live:account:smoke
bun run test:live:account:soak
bun run test:live:order:smoke
bun run test:live:order:soak
```

约定：

- `smoke` 默认跑 10 秒，做连通性检查，不主动断线
- `soak` 默认跑 60 秒，并做一次主动断线重连验证

覆盖内容：

- `market`：`loadMarkets()`、`subscribeL1Book()`、`subscribeFundingRate()`、`getL1Book()` / `getL1Books()`、`getFundingRate()` / `getFundingRates()`、对应事件流和可选断线重连（`--disconnect-target funding` 可单独验证资金费率重连）
- `account`：Binance PAPI UM 账户 bootstrap、余额/仓位/风险投影、private stream 更新和可选重连
- `order`：open orders bootstrap、`subscribeOrders()`、订单事件投影和可选重连

### 发布流程

仓库使用 **Changesets + GitHub Actions + npm Trusted Publishing**：

1. 开发 PR 时，如果改动影响用户，执行 `bun run changeset`
2. 按提示选择 `patch` / `minor` / `major`，写一段对外 release note
3. PR merge 到 `main` 后，[release.yml](./.github/workflows/release.yml) 会：
   - 安装依赖
   - 跑 `bun run lint` / `bun run type-check` / `bun run test`
   - 若有未消费的 changeset，创建或更新 release PR
4. merge release PR 后，同一 workflow 自动发布到 npm

当前仓库处于 Changesets 的 `beta` prerelease 模式，自动发布默认走 npm `beta` dist-tag。

npm 侧配置 Trusted Publisher 要求：

- workflow 文件名是 `release.yml`
- `package.json.repository.url` 直接写仓库地址，例如 `https://github.com/imbingox/acex`
- npm 包 settings 绑定 GitHub Actions trusted publisher，不使用长期 `NPM_TOKEN`
