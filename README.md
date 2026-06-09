# @imbingox/acex

`acex` 是一个面向交易场景的 **状态型** 多交易所 SDK。调用方持有一个 `AcexClient`，通过统一的 `market` / `account` / `order` manager 读取最新快照、消费增量事件、执行下单撤单命令；SDK 内部负责本地缓存、ready barrier、websocket 生命周期和自动重连，调用方不需要自己处理。

当前 MVP 落地 Binance（Spot + USDⓈ-M + COIN-M 行情，含 Binance TradFi Perps public market data；PAPI UM 私有链路）以及 Juplend（Jupiter Lend 只读借贷账户视图）。

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
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

const book = client.market.getL1Book({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});
const books = client.market.getL1Books("BTC/USDT:USDT");
console.log(`bid=${book?.bidPrice} ask=${book?.askPrice}`);
console.log(`venues=${books.length}`);
console.log(`book freshness=${book?.status.freshness}`);

await client.market.subscribeFundingRate({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});

const funding = client.market.getFundingRate({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
});
const fundingRates = client.market.getFundingRates("BTC/USDT:USDT");
console.log(`funding=${funding?.fundingRate}`);
console.log(`funding venues=${fundingRates.length}`);

for await (const event of client.market.events.l1BookUpdates({
  venue: "binance",
  symbol: "BTC/USDT:USDT",
})) {
  console.log(event.snapshot.bidPrice);
  break;
}

await client.stop();
```

### 同一个 client 同时使用 Binance + Juplend

`createClient({ account: { binance: { riskPollIntervalMs, privateReconcileIntervalMs }, juplend: { pollIntervalMs, rpcUrl, jupApiKey } } })` 只是分别配置 Binance 风险/仓位校准、Binance private REST 对账和 Juplend 账户 polling / RPC / Jup API，不代表这个 client 只能注册某个 venue。一个 `AcexClient` 可以同时注册 Binance 交易账户和 Juplend 借贷只读账户，用同一个 `AccountManager` 对比风险值。

```ts
const client = createClient({
  account: {
    binance: {
      riskPollIntervalMs: 5_000,
      privateReconcileIntervalMs: 60_000,
    },
    juplend: {
      pollIntervalMs: 30_000,
      rpcUrl: process.env.SOL_HELIUS_RPC,
      jupApiKey: process.env.JUP_API,
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
  options: {
    walletAddress: "<solana-wallet-address>",
    positionId: "<optional-nft-position-id>",
  },
});

await client.registerAccount({
  accountId: "jup-loop-direct",
  venue: "juplend",
  options: {
    vaultId: "<vault-id>",
    positionId: "<nft-position-id>",
  },
});

await client.account.subscribeAccount({ accountId: "jup-loop-a" });
await client.account.subscribeAccount({ accountId: "main-binance" });
await client.order.subscribeOrders({ accountId: "main-binance" });

const binanceRisk = client.account.getRiskSnapshot("main-binance");
const juplendRisk = client.account.getRiskSnapshot("jup-loop-a");
const juplendBalances = client.account.getBalances("jup-loop-a");

for (const balance of juplendBalances) {
  console.log(balance.asset, balance.lending?.netAsset);
}
console.log({
  binanceRiskRatio: binanceRisk?.riskRatio,
  juplendRiskRatio: juplendRisk?.riskRatio,
});

await client.stop();
```

Juplend 使用 `@jup-ag/lend-read` 通过 Solana RPC 读取原生借贷仓位，不需要私钥，也不支持 supply / borrow / repay / withdraw 等写操作。`accountId` 是你自定义的 SDK 账户名。聚合钱包全部仓位时传 `options.walletAddress`；只想观察单个仓位时，可直接传 `options.vaultId + options.positionId`，这样不会先扫整个钱包。`account.juplend.rpcUrl` 可显式指定 RPC；未指定时默认读取 `SOL_HELIUS_RPC`，再 fallback 到 SDK 默认 RPC。token metadata / price 优先走 Jup 官方 `Tokens V2 + Price V3`，可通过 `account.juplend.jupApiKey` 或环境变量 `JUP_API` 注入；拿不到时退回 lite vault metadata。

### 查询 venue 能力

`getVenueCapabilities()` 查询的是当前 SDK runtime 已实现能力，不是交易所官网完整能力，也不会检查 API key 是否有交易权限：

```ts
const binance = client.getVenueCapabilities("binance");
console.log(binance.order.supported); // true
console.log(binance.market.fundingRate); // "market_dependent"

const juplend = client.getVenueCapabilities("juplend");
console.log(juplend.readOnly); // true
console.log(juplend.order.reason); // "read_only"

const capabilities = client.listVenueCapabilities();
```

价格、数量等公共输出字段统一是 canonical decimal string（无科学计数法、不补尾零）；输入侧保持宽进严出，`createOrder()` 的 `price` / `amount` 是 decimal string，`DecimalInput` 仍接受 string / number / `BigNumber`。如需运算，使用 SDK re-export 的 `BigNumber`：`new BigNumber(field)`。详见手册 [§3 核心概念](./docs/api.md#3-核心概念)。

## 核心能力

| 能力 | 概述 | 详细文档 |
|---|---|---|
| **Capabilities** | `getVenueCapabilities` / `listVenueCapabilities` 查询 SDK 当前 runtime 支持能力 | [docs/api.md §4](./docs/api.md#43-venue-capabilities) |
| **Market** | Market catalog、L1 Book / Funding Rate 订阅、增量事件、订阅状态与自动重连 | [docs/api.md §5](./docs/api.md#5-marketmanager) |
| **Account** | 账户快照、余额、持仓、风险投影与事件流 | [docs/api.md §6](./docs/api.md#6-accountmanager) |
| **Order** | open orders 投影、订单事件流，`createOrder` / `cancelOrder` / `cancelAllOrders` 第一版命令 | [docs/api.md §7](./docs/api.md#7-ordermanager) |
| **健康与错误** | `getHealth()`、`events.health()`、`events.errors()` | [docs/api.md §8](./docs/api.md#8-健康与错误事件) |

完整手册（接口签名、数据类型、错误码）：[docs/api.md](./docs/api.md)。

## 当前限制

- 运行时 market/order 能力只支持 `binance`；`okx` / `bybit` / `gate` 仅类型定义
- 账户视图支持 Binance PAPI UM 与 Juplend 只读借贷账户
- Juplend 只读，不支持订单和链上写操作；仓位数量来自 `@jup-ag/lend-read` 原生 position 数据
- Funding Rate 仅支持 Binance 永续合约，来自 mark price websocket；支持 Binance TradFi Perps，不支持现货和交割合约
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
- 新增交易所时，优先新增 `tests/support/exchanges/<venue>.ts`，复用通用 helper，避免把交易所 payload 写进通用测试工具。

GitHub Actions 的 `CI` workflow 会在 PR 和 `main` push 时运行 lint、type-check、unit、integration；release workflow 继续复用 `bun run test`，不会执行 soak/live。

### 真实环境 smoke / soak 脚本

不进默认 `bun run test`，单独执行：

```bash
bun run test:live:market:smoke
bun run test:live:market:soak
bun run test:live:account:smoke
bun run test:live:account:soak
bun run test:live:juplend:smoke
bun run test:live:order:smoke
bun run test:live:order:soak
```

约定：

- `smoke` 默认跑 10 秒，做连通性检查，不主动断线
- `soak` 默认跑 60 秒，并做一次主动断线重连验证

覆盖内容：

- `market`：`loadMarkets()`、`subscribeL1Book()`、`subscribeFundingRate()`、`getL1Book()` / `getL1Books()`、`getFundingRate()` / `getFundingRates()`、对应事件流和可选断线重连（`--disconnect-target funding` 可单独验证资金费率重连）
- `account`：Binance PAPI UM 账户 bootstrap、余额/仓位/风险投影、private stream 更新和可选重连
- `juplend`：`@jup-ag/lend-read` + Jup Tokens/Price API 连通性、lending balance facet、账户级 `riskRatio`、支持 `--wallet-address` 聚合或 `--vault-id + --position-id` 单仓直读
- `order`：open orders bootstrap、`subscribeOrders()`、订单事件投影和可选重连

Juplend live smoke 示例：

```bash
SOL_HELIUS_RPC=... JUPLEND_WALLET_ADDRESS=<wallet> bun run test:live:juplend -- --show-amounts
bun run test:live:juplend -- --account-id jup-loop-a --wallet-address <wallet> --position-id <nftId> --rpc-url <rpc> --show-amounts
bun run test:live:juplend -- --account-id jup-loop-a --vault-id <vaultId> --position-id <nftId> --rpc-url <rpc> --show-amounts
```

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
