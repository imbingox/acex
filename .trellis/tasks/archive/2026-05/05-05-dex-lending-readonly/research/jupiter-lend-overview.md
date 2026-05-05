# Jupiter Lend 调研

> 调研时间：2026-05-05
> 调研者：Research Agent (acex SDK 项目)
> 目标：评估 Jupiter Lend 借贷头寸的「只读接入」可行性

## 1. 产品现状

**Jupiter Lend** 是 Jupiter（jup.ag，Solana 最大 DEX 聚合器）官方推出的**自营**借贷协议，部署在 **Solana mainnet-beta**。它**不是**一个聚合 Kamino / MarginFi / Solend 的入口，而是 Jupiter 自己写的 Anchor program，使用自己的 program ID（前缀以 `jup` 开头，详见第 2 节）。

DefiLlama 描述：「Jupiter Lend is Jupiter's DeFi platform for lending and borrowing crypto」，分类为「Lending」，链为「Solana」。

**时间线**（来自 DefiLlama TVL 历史）：

| 时间 | 状态 | TVL |
| --- | --- | --- |
| 2025-08-19 | DefiLlama 首次收录（早期 alpha/beta） | ~$7.5M |
| 2025-08-28 | 主网正式起量（一夜从 $13M 跃升到 $220M） | ~$220M |
| 2025-09 ~ 2026-01 | 持续增长 | $500M~$1B |
| 2026-05-05（今日） | 已稳定运行约 8 个月 | **~$908M** |

**当前阶段**：production-grade，非 alpha/beta；mainnet 主程序 ID 已稳定（参见第 2 节）。npm 包 `@jup-ag/lend` 仍在 `0.1.x`，最新 `0.1.10-beta.4` 于 2026-05-04 发布——SDK 接口仍可能小幅迭代，但底层 program 已稳定。无公开的协议级 deprecation 信号。

**产品形态**——Jupiter Lend 在产品上拆成两条腿：

- **Earn**：用户存入资产 → 获得 `jlToken`（如 `jlUSDC` / `jlSOL`），对应 ERC4626 风格的 share token，自动累积利息。当前支持 7 个市场：USDC、USDT、SOL、EURC、USDG、USDS、JupUSD。
- **Borrow**：基于 NFT 持仓（每开一个仓位铸一个 position NFT）的孤立借贷市场（vault）。当前 ~78 个 vault，组合包括 SOL/USDC、JLP/USDC、cbBTC/USDC、各类 LST→SOL 杠杆等。每个 vault 有独立的 `collateralFactor` / `liquidationThreshold` / `liquidationPenalty`。

**架构来源观察**（重要）：从 IDL 中 `Tick` / `TickHasDebt` / `TickHasDebtArray` / `Branch` / `TickIdLiquidation` / `isSmartCol` / `isSmartDebt` 这一组特征类型，**几乎可以肯定 Jupiter Lend 是 Instadapp Fluid Protocol 的 Solana 移植**（Fluid 的"smart collateral / smart debt + tick-based liquidation engine"是其独有架构）。Jupiter 官方目前**没有公开承认** Fluid 关系，仓库里也找不到 `fluid` 字符串引用。架构含义：风控字段语义可参照 Fluid 的成熟模型（Health Factor、tick-based 清算机制等）。

## 2. 底层架构

**Jupiter Lend 不包装第三方协议**，是 Jupiter 自己的 Anchor programs，分四个 program 协作：

### 2.1 主网 (mainnet-beta) Program IDs

| Program | 用途 | Address |
| --- | --- | --- |
| **Liquidity** | 底层共享流动性层，所有 supply/borrow 最终汇聚到这里 | `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC` |
| **Lending** (Earn) | jlToken 发行 + 利息累积（ERC4626 风格） | `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` |
| **Lending Reward Rate Model** | jlToken 奖励速率模型 | `jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar` |
| **Vaults** (Borrow) | 借贷 vault + NFT 持仓 + tick 清算引擎 | `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi` |
| **Oracle** | 价格预言机适配层（Pyth / Chainlink / Stake Pool / RedStone / Chainlink Data Streams / jupLend 内嵌价格） | `jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc` |
| **Flashloan** | 闪电贷 | `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS` |

来源：`@jup-ag/lend-read` README、`https://github.com/jup-ag/jupiter-lend/tree/main/docs/`、`target/idl/*.json`。

### 2.2 Devnet Program IDs（仅参考，与 mainnet 不同）

- LENDING: `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3`
- LIQUIDITY: `5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL`
- VAULTS: `Ho32sUQ4NzuAQgkPkHuNDG3G18rgHmYtXFA8EBmqQrAu`

### 2.3 Anchor IDL 公开

公开 IDL 仓库：<https://github.com/jup-ag/jupiter-lend/tree/main/target/idl>

| 文件 | 大小 | 关键 accounts |
| --- | --- | --- |
| `lending.json` | 37 KB | `Lending`, `LendingAdmin`, `LendingRewardsRateModel`, `TokenReserve`, `UserSupplyPosition` |
| `vaults.json` | 83 KB | `Branch`, `Oracle`, `Position`, `Tick`, `TickHasDebtArray`, `TickIdLiquidation`, `TokenReserve`, `UserBorrowPosition`, `UserSupplyPosition`, `VaultAdmin`, `VaultConfig`, `VaultMetadata`, `VaultState` |
| `liquidity.json` | 59 KB | （未细看）—— `UserSupplyPosition`, `UserBorrowPosition` 等 |
| `oracle.json` | 25 KB | Oracle adapter 数据 |
| `flashloan.json` | 11 KB | Flash loan 相关 |
| `lending_reward_rate_model.json` | 14 KB | Reward 速率模型 |
| `merkle_distributor.json` | 28 KB | Reward 分发 |

仓库还有 `target/types/` 提供对应的 TypeScript 类型导出（Anchor 自动生成）。

### 2.4 关键概念

- **jlToken**：Earn 侧的 share token，是 SPL Token Mint。地址举例：`jlUSDC = 9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D`、`jlSOL = 2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU`。
- **UserSupplyPosition / UserBorrowPosition**：在 `Liquidity` program 中存储，PDA 派生方式 = `(asset, protocol_pda)`。Lending 和 Vaults 都向 Liquidity 借/存。
- **Position NFT**（仅 Borrow 侧）：每开一个 vault 仓就铸一个 NFT，`(vaultId, positionId)` 唯一标识；NFT 的所有者就是仓位的所有者。要查"某钱包的所有借贷头寸"必须先枚举该钱包持有的所有 NFT，再筛选属于 Vaults program 的。
- **Tick** + **Branch**：Fluid 风格的 batch-liquidation 数据结构，普通只读用户**不需要直接读** Tick——`@jup-ag/lend-read` 已封装。

## 3. 数据获取方案对比

acex 需要的字段映射：

| acex `LendingBalanceFacet` | 数据来源 |
| --- | --- |
| `supplied`（抵押 / 存款余额） | Earn: `jlToken.shares × convertToAssets`；Borrow: `Position.supplyAmount × vaultSupplyExchangePrice` |
| `borrowed` | Borrow: `Position.debtRaw × vaultBorrowExchangePrice` |
| `interest` | 计算差值：`underlyingAssets - principal`（principal 需自己跟踪 deposit/withdraw 历史，链上单点查询拿不到） |
| `supplyAPY` | Earn: `JlTokenDetails.supplyRate + rewardsRate`（基点 1e4=100%）；Borrow: `vault.supplyRate` |
| `borrowAPY` | Borrow: `vault.borrowRate`（基点 1e4=100%） |

| acex `LendingRiskFacet` | 数据来源 |
| --- | --- |
| `healthFactor` | 不直接暴露——Jupiter 用 `riskRatio` (借/抵押 ratio)；需自己换算 `1 / riskRatio`，或用 `liquidationThreshold / currentLTV` |
| `ltv` | `position.debt × oraclePrice / position.supply` |
| `liquidationThreshold` | `vault.liquidationThreshold / 1000`（vault 配置中是整数 850 = 85%） |
| `totalCollateralUSD` | `position.supply × supplyTokenPrice`（来自 vault `oraclePrice` 或独立行情） |
| `totalDebtUSD` | `position.debt × borrowTokenPrice` |

下面对比三种获取方式：

### 3.1 官方 SDK

存在两个相关 npm 包：

#### A. `@jup-ag/lend`（综合 SDK，写 + 读）

- 版本：`0.1.9` (latest, 2026-03-23)，beta `0.1.10-beta.4` (2026-05-04)
- 维护：**非常活跃**——每月下载 5,668，beta 通道每天有新版本
- License: MIT
- Homepage: 无（README 简陋）
- npm: <https://www.npmjs.com/package/@jup-ag/lend>
- 包大小：unpacked 698 KB，32 文件
- 依赖（runtime）：
  - `@solana/web3.js: ^1.98.2`（v1，**不是 v2**）
  - `@coral-xyz/anchor: ^0.31.1`
  - `@solana/spl-token: ^0.4.13`
  - `axios: ^1.11.0`
  - `bn.js: ^5.2.2`

模块结构（subpath imports）：

| 子路径 | 用途 |
| --- | --- |
| `@jup-ag/lend` | PDA helpers (`borrowPda`, `lendingPda` 等) |
| `@jup-ag/lend/earn` | Earn 写交易 + 读函数 |
| `@jup-ag/lend/borrow` | Borrow 写交易 + 读函数 |
| `@jup-ag/lend/api` | REST API 客户端（包装 lite-api.jup.ag） |
| `@jup-ag/lend/flashloan` | 闪电贷 |
| `@jup-ag/lend/refinance` | 换贷 |
| `@jup-ag/lend/merkle-distributor` | Reward claim |

**Earn 模块的只读 API**：

```typescript
import {
  getLendingTokens,         // (connection) → PublicKey[] 所有 jlToken
  getLendingTokenDetails,   // ({ lendingToken, connection }) → 池详情
  getUserLendingPositionByAsset, // ({ asset, user, connection }) → 用户头寸
} from '@jup-ag/lend/earn';

// 用户头寸返回
{
  lendingTokenShares: BN; // jlToken 持仓
  underlyingAssets:   BN; // 折算成 underlying 的金额
  underlyingBalance:  BN; // 钱包里 underlying 余额
}

// Token 详情返回
{
  id: number;
  address: PublicKey;       // jlToken mint
  asset: PublicKey;         // underlying mint
  decimals: number;
  totalAssets: BN;
  totalSupply: BN;
  convertToShares: BN;
  convertToAssets: BN;
  rewardsRate: BN;          // 1e4 decimals (1e4 = 100%)
  supplyRate: BN;
}
```

**Borrow 模块的只读 API**：

```typescript
import {
  getCurrentPosition,        // ({ vaultId, positionId, connection }) → 仓位原始数据
  getCurrentPositionState,   // ({ vaultId, position, program }) → 仓位 + 清算状态
  getFinalPosition,          // 模拟新增 col/debt 后的最终仓位
  readOraclePrice,           // ({ connection, signer, oracle }) → 价格
  simulateLiquidate,
  getLiquidations,
  getAllLiquidations,
  getRatioAtTick, getTickAtRatio,  // tick ↔ ratio 互转
  loadRelevantBranches,
  loadRelevantTicksHasDebtArrays,
  getAccountOwner,
  getVaultsProgram,
  MAX_REPAY_AMOUNT, MAX_WITHDRAW_AMOUNT, MIN_I128,
  MIN_TICK, MAX_TICK,
} from '@jup-ag/lend/borrow';
```

注意：Borrow 模块**没有暴露 `getUserBorrowPositionByWallet(wallet)` 这种钱包级查询**——只能 by `(vaultId, positionId)`。要从 wallet 反查必须先枚举 NFT。

**API 模块**（README 推荐）：

```typescript
import { Client } from '@jup-ag/lend/api';
const client = new Client();              // 公共
// const client = new Client({ apiKey: 'X' }); // 限速更高

// Earn
await client.earn.getTokens();            // → LendingToken[]
await client.earn.getPositions({ users }); // → LendingPosition[] ✅
await client.earn.getEarnings({ user, positions }); // → 历史盈亏

// Borrow
await client.borrow.getVaults();          // → Vault[]
// 注意：BorrowClient 没有 getPositions 方法
```

#### B. `@jup-ag/lend-read`（专门的只读 SDK）⭐ **强烈推荐**

- 版本：`0.0.12` (2026-05-04)
- 描述：`utils for jup lend`（README 明示「Read-only TypeScript SDK」）
- 维护：每月下载 1,200，最近 5 天连续发版
- 包大小：unpacked 913 KB，6 文件（一个大 bundle）
- 依赖：
  - `@solana/web3.js: ^1.98.0`
  - `@coral-xyz/anchor: ^0.31.0`
  - `@metaplex-foundation/mpl-token-metadata: ^3.4.0`
  - `@solana/kit: ^5.0.0` ← **注意**：这是 Solana Web3.js v2 的新模块化包，但只在 dev/litesvm 测试中用
  - `@solana/spl-token: ^0.4.13`
  - `@solana/spl-single-pool: ^1.0.0`
  - `anchor-litesvm: ^0.1.2`
  - `axios: ^1.9.0`、`bn.js`、`dotenv`、`js-sha3`

> README 明示：「All modules are **read-only** -- they fetch and decode on-chain accounts via RPC but never submit transactions.」

统一客户端：

```typescript
import { Client } from '@jup-ag/lend-read';
const client = new Client();                          // 默认 mainnet RPC
const client = new Client('https://your-rpc.com');    // 自定义 RPC URL
const client = new Client(connection);                // 用现有 Connection

// 三个模块：
client.liquidity  // 底层 Liquidity 层
client.lending    // jlToken (Earn) 层
client.vault      // Borrow vault 层
```

**Lending 模块（Earn）只读方法**：

```typescript
client.lending.getAllJlTokens()                       // → PublicKey[]
client.lending.getJlTokenDetails(mint)                // → JlTokenDetails
client.lending.getAllJlTokenDetails()                 // → JlTokenDetails[]
client.lending.getUserPosition(mint, user)            // → UserPosition
client.lending.getUserPositions(user)                 // → JlTokenDetailsUserPosition[]  ✅ 一次拉所有 jlToken 头寸
client.lending.getExchangePrice(mint)                 // → BN（实时换算价）
client.lending.getJlTokenRewards(mint)                // → [PublicKey, BN]
```

**Vault 模块（Borrow）只读方法**：

```typescript
client.vault.getTotalVaults()                                       // → number
client.vault.getVaultByVaultId(vaultId)                             // → VaultEntireData (config + state + 限额 + APY)
client.vault.getAllVaults()                                         // → VaultEntireData[]
client.vault.getUserPosition({ vaultId, positionId })               // → UserPosition | null
client.vault.batchGetUserPositions(positions)                       // → 批量
client.vault.getCurrentPositionState({ vaultId, position })         // → 含债务/清算状态
client.vault.getAllPositionsWithRiskRatio(vaultId)                  // → 所有持仓 + riskRatio (但是按 vault，不是按 wallet)
client.vault.getAllPositionIdsForVault(vaultId)                     // → number[]
client.vault.getNftOwner(mint)                                      // → PublicKey  关键：从 NFT mint 反查 owner
client.vault.getOraclePrice(oracle)                                 // → { operatePrice, liquidatePrice }
```

**`@jup-ag/lend-read` 关键限制**：和 `@jup-ag/lend/borrow` 一样，**没有 `getPositionsByOwner(wallet)` 这种钱包级反向查询**。要找一个钱包的所有 borrow 仓位，需要：

```typescript
// 流程：枚举钱包 NFT → 找出 Jupiter vault position NFT → 查仓位
// 1. 通过 Solana RPC 拿到 wallet 持有的所有 SPL tokens（amount=1 的视为 NFT）
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
  wallet,
  { programId: TOKEN_PROGRAM_ID }
);
const nftMints = tokenAccounts.value
  .filter(a => a.account.data.parsed.info.tokenAmount.uiAmount === 1)
  .map(a => new PublicKey(a.account.data.parsed.info.mint));

// 2. 对每个 mint，反推 (vaultId, positionId)：
//    Jupiter 的 position mint PDA 派生公式 = getPositionMint(vaultId, positionId)
//    暴力搜会很贵——更好的做法是从 mint metadata（mpl-token-metadata）的 collection 字段筛
//    或：用 getMint 查发行方，看 mintAuthority 是否是 Vault program

// 3. 对匹配到的 (vaultId, nftId)，调用：
const { userPosition, vaultData } = await client.vault.getPositionByVaultId(vaultId, nftId);
```

实务上：**Earn 头寸**用 SDK 的 `lending.getUserPositions(user)` 一次到位；**Borrow 头寸**比 EVM 的 `Pool.getUserAccountData(user)` 麻烦得多，因为 Solana 没有原生的"用户账户"概念。

### 3.2 官方 REST API

**Base URL**：`https://lite-api.jup.ag/lend/v1/`（无 API key，公共）或 `https://api.jup.ag/lend/v1/`（同样数据，apiKey 可选）

**限速**：HTTP 响应头 `x-ratelimit-limit: 300`（看起来是每分钟 300 次/IP）。

#### 已验证可用的端点

##### A. `GET /lend/v1/earn/tokens` —— 列出所有 jlToken 池

```bash
curl -s 'https://lite-api.jup.ag/lend/v1/earn/tokens'
```

返回数组（节选）：

```json
[
  {
    "id": 2,
    "address": "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
    "name": "jupiter lend USDC",
    "symbol": "jlUSDC",
    "decimals": 6,
    "assetAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "asset": {
      "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "name": "USD Coin", "symbol": "USDC", "decimals": 6,
      "price": "0.999779333214",
      "coingeckoId": "usd-coin",
      "updatedAt": "2026-05-05T03:24:07.000+00:00"
    },
    "totalAssets": "425816623505544",       // raw, 6 decimals
    "totalSupply": "408618534055043",
    "convertToShares": "959612",
    "convertToAssets": "1042088",
    "rewardsRate":  "110",                  // 1e4=100%, so 110 = 1.10%
    "supplyRate":   "313",                  // 3.13%
    "totalRate":    "423",                  // 4.23% APR
    "rebalanceDifference": "-7794595627257",
    "liquiditySupplyData": { /* 限额 */ },
    "rewards": []
  },
  ...
]
```

##### B. `GET /lend/v1/earn/positions?users=<wallet>` ⭐ —— 钱包的 Earn 头寸 ✅

**这就是我们要的「按钱包查 supply 头寸」的 API**——返回该钱包对每个 jlToken 的持仓（即使是 0）：

```bash
curl -s 'https://lite-api.jup.ag/lend/v1/earn/positions?users=DLMarHGJUnVPGbreUTLWwMhfbbgxFUzjj7kXEekQTaPK'
```

返回：

```json
[
  {
    "token": { /* 同 A 的 token 详情 */ },
    "ownerAddress": "DLMarHGJUnVPGbreUTLWwMhfbbgxFUzjj7kXEekQTaPK",
    "shares":            "0",        // jlToken 余额（raw）
    "underlyingAssets":  "0",        // 折算后的 underlying 数量（raw, asset.decimals）
    "underlyingBalance": "0",        // 钱包里 underlying 的余额
    "allowance":         "0"
  },
  ... // 每个 jlToken 一条
]
```

`?users=` 参数支持多个吗？文档没说，但 SDK 的 `client.earn.getPositions({ users: string[] })` 接收数组——暗示可逗号分隔。

##### C. `GET /lend/v1/borrow/vaults` —— 列出所有 78 个 borrow vault

```bash
curl -s 'https://lite-api.jup.ag/lend/v1/borrow/vaults'
```

每个 vault 返回包括：`supplyToken`、`borrowToken`、`collateralFactor`（1000=100%，如 800=80%）、`liquidationThreshold`、`liquidationMaxLimit`、`liquidationPenalty`、`supplyRate` / `borrowRate`（基点 1e4=100%）、`oracle`、`oraclePrice`、`oraclePriceOperate`、`oraclePriceLiquidate` 等。

数据示例（节选 vault id=1，WSOL→USDC）：

```json
{
  "id": 1, "address": "nMzVs8Gi...",
  "supplyToken": { "symbol": "WSOL", "decimals": 9, "price": "84.69" },
  "borrowToken": { "symbol": "USDC", "decimals": 6, "price": "0.9998" },
  "totalSupply": "1631108284449012", "totalBorrow": "60121922561383",
  "collateralFactor":     "800",   // 80%
  "liquidationThreshold": "850",   // 85% LT
  "liquidationMaxLimit":  "900",
  "liquidationPenalty":   "100",   // 10% penalty
  "supplyRate":           "534",   // 5.34% supply APR
  "borrowRate":           "429",   // 4.29% borrow APR
  "oracle": "6QBKbRU6bgjDxLeP8XwZmrikkRR5v913b7xwLPVoeNQ5",
  "oraclePriceOperate":   "85583617863577224",
  "totalPositions": 8241,
  ...
}
```

##### D. `GET /lend/v1/borrow/positions?users=<wallet>` —— ⚠️ 状态不明

实测返回 `[]`（不是 404），但是：

1. 我们用的钱包 `DLMar...` 可能本身没有 borrow 仓位，所以无法判断是「endpoint 不支持 wallet 查询」还是「确实没头寸」。
2. 在 `@jup-ag/lend/api` 的 `BorrowClient` 类型定义中，**没有 `getPositions(...)` 方法**（只有 `getVaults()` / `operate()` / `operateInstructions()`）——表明官方 SDK 没把这个 endpoint 视为公开稳定 API。
3. 因此 borrow 侧不能依赖 REST 直接按 wallet 查头寸；需要用 SDK + NFT 枚举。

#### 数据精度约定

- 所有金额用 **raw token amount**（string，避免 JS Number 精度问题）
- `decimals` 字段告诉你怎么 scale
- APY/rate 字段：basis points × 100，即 `1e4 = 100%`，所以 `313 = 3.13%`
- `convertToShares` / `convertToAssets`：6 decimals 缩放

### 3.3 链上直读

#### 完整自建路径（不用任何 SDK）

**前置条件**：

- Solana mainnet RPC（公共：`https://api.mainnet-beta.solana.com`，但限速严；推荐 Helius / Triton / QuickNode 等）
- 依赖：`@solana/web3.js` v1 + `@coral-xyz/anchor` + IDL 文件

**步骤**（以 Earn 为例）：

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import lendingIdl from './lending.json'; // 从 jup-ag/jupiter-lend 仓库下载

const LENDING_PROGRAM_ID = new PublicKey('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9');
const LIQUIDITY_PROGRAM_ID = new PublicKey('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC');

const connection = new Connection(rpcUrl);
// 只读时 wallet 可以是 stub
const provider = new AnchorProvider(connection, {} as Wallet, {});
const lendingProgram = new Program(lendingIdl as any, LENDING_PROGRAM_ID, provider);

// 1. 派生用户在 Liquidity 层的 supply position PDA
//    seeds = ['user_supply_position', asset_mint, lending_pda]   （需查 IDL constant 字段或反编译 SDK PDA helper）
const [userSupplyPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('user_supply_position'), assetMint.toBuffer(), lendingPda.toBuffer()],
  LIQUIDITY_PROGRAM_ID,
);

// 2. fetch 账户
const supplyPosition = await liquidityProgram.account.userSupplyPosition.fetch(userSupplyPda);

// 3. 还需要拿 exchangePrice 来 scale raw → underlying
//    @jup-ag/lend-read 把 calculateExchangePrice 完整算法都封装了，自建很麻烦
```

**Borrow 侧自建更复杂**：需要读 `Position` PDA、`VaultConfig`、`VaultState`、还要根据 `Tick` 查清算状态、用 `Branch` 算实际 col/debt——整套 Fluid 的 tick-based 算法不是几行代码搞定的。

#### IDL 来源

- 主仓库 `https://github.com/jup-ag/jupiter-lend/tree/main/target/idl`
- npm 包 `@jup-ag/lend` 内部也打包了 IDL（`dist/shared/lend.*.mjs` 中可看到 IDL embedded），但官方走 GitHub 公开版更稳。

#### 自建的明显问题

1. PDA seeds 没有公开文档——必须看 SDK 源码 / IDL constants 反推
2. `convertToAssets`、`exchangePrice` 计算复杂，不是简单乘除
3. tick-based 清算引擎需要从多个账户聚合
4. Anchor 0.31 + IDL 0.31 格式（带 `address` 顶层字段）需要新版 anchor 客户端

> **结论**：自建只读完全可行，但要复刻 `@jup-ag/lend-read` 已经做的事，工作量约 **1-2 周** 才能稳定，且后续 Jupiter 升级 program 时要跟着改。

## 4. 推荐路径

基于 acex 上下文（跨 CEX/DEX 的 SDK，依赖控制重要、Bun 运行时、TypeScript first、只读 MVP），按优先级：

### 推荐 P0：`@jup-ag/lend-read` + 官方 REST API 双轨

**Earn 侧用 REST API**：

```typescript
// 一次 HTTP 请求拿全（轻量）
const earnPositions = await fetch(
  `https://lite-api.jup.ag/lend/v1/earn/positions?users=${wallet}`
).then(r => r.json());
```

**Borrow 侧用 `@jup-ag/lend-read`**：

```typescript
import { Client } from '@jup-ag/lend-read';
const client = new Client(rpcUrl); // 用户传入 RPC
// 1. 通过 connection.getParsedTokenAccountsByOwner 列出 wallet NFT
// 2. 对每个 NFT 反查 (vaultId, positionId) —— 需要 mint metadata 或硬扫
// 3. client.vault.getCurrentPositionState({ vaultId, position }) 拿风控字段
// 4. 把每个 position 映射成 acex 的 LendingBalanceFacet + LendingRiskFacet
```

**理由**：

- ✅ Earn 侧 REST 极简：一行 fetch，不用 RPC，不引依赖
- ✅ Borrow 侧 read-only SDK 已经把 tick / branch / exchangePrice 等复杂计算封装好
- ✅ `@jup-ag/lend-read` 明确是 read-only，不会拖入交易构建逻辑
- ⚠️ 引入 `@coral-xyz/anchor`、`@solana/web3.js` v1（但凡 Solana 都跑不掉）
- ⚠️ 依赖 ~916 KB（lend-read），加上 anchor (~400 KB) + web3.js v1 (~600 KB) + spl-token (~200 KB)，**总体新增大概 2 MB 左右** 进 acex bundle。如果 bundle size 敏感，可以用 lazy import 把 Solana 相关代码分块。

### 备选 P1：纯 REST API（仅做 Earn，不做 Borrow）

如果 MVP 只关心存款头寸（不关心借贷）、想最小依赖：

- 只用 `fetch` 调 `lite-api.jup.ag`
- 0 个 npm 依赖（除了 acex 自己已有的 fetch / fetcher）
- Borrow 头寸**留作 V2**，先在 SDK 层抛 `not-supported`

**适用场景**：用户只把 Jupiter Lend 当存款收益工具用、不开杠杆。但任务 PRD 明示需要 borrowed/healthFactor 等字段，所以这个备选**不满足 acceptance criteria**。

### 备选 P2：`@jup-ag/lend`（综合 SDK）

理由：覆盖更广、未来若要做写操作（supply/borrow/repay）也现成。

**为什么不选**：

- 包含 `@jup-ag/lend/borrow` 的写交易构建（`getOperateIx`），增加我们不需要的代码
- 没有 `@jup-ag/lend-read` 那么明确的 read-only 边界
- BorrowClient 没有 `getPositions` 方法，最终还是要枚举 NFT
- bundle 大小相近，没明显优势

### 不推荐：自建（直读 program account）

理由：

- 复刻 `@jup-ag/lend-read` 已封装的 `calculateExchangePrice`、tick → ratio 等算法工作量太大（1-2 周）
- 协议升级时要自己跟版本
- IDL 已经公开，但 PDA seeds、各种 magic constant 都得逆向，维护成本高
- 唯一情境：依赖体积是绝对硬约束（< 50KB Solana 部分），但那时整个 Solana 集成都该重新评估

### 关于 web3.js v1 vs v2 兼容性

- **`@jup-ag/lend` 0.1.9**：`@solana/web3.js: ^1.98.2`——纯 v1，无 v2 依赖。
- **`@jup-ag/lend-read` 0.0.12**：runtime 依赖 `@solana/web3.js: ^1.98.0`，但还拉了 `@solana/kit: ^5.0.0`（v2 的模块化包）和 `anchor-litesvm: ^0.1.2`。`@solana/kit` 是 dev/litesvm 用的，不影响 runtime 运行；但**包安装时这些都会下载**。如果 acex 已经/计划用 `@solana/kit`（v2 SDK），版本要对齐避免双份依赖。
- 推荐：在 acex `package.json` 里把 `@solana/web3.js` 列为 explicit dep（lock 在 `^1.98.0`），用 Bun 的 dedupe 机制保证只有一个副本。

### Bun 兼容性

- `@jup-ag/lend` 是纯 ESM (`type: module`，`exports` 走 `.mjs`)——Bun ESM 原生支持，无需 polyfill
- `@coral-xyz/anchor` 0.31 是 Bun 友好的（已有大量 Solana Bun 项目验证）
- `axios` —— Bun 也兼容，但如果你想用 native fetch，REST API 路径直接 fetch 就够

## 5. 风险与未知

### 已知风险

1. **Borrow 头寸枚举成本高**：每次刷新一个钱包都要先 `getParsedTokenAccountsByOwner`（钱包 NFT 多时返回上百条），再过滤、再批量查 vault position。轮询间隔不能太密（30s 已经偏激进），可能需要至少 60s 默认 + 缓存层。
2. **mint metadata 路径不稳定**：要从 NFT 反推 `(vaultId, positionId)`，最干净的做法是看 NFT 的 `mintAuthority` 是不是 Vaults program 派生 PDA。`@jup-ag/lend-read.vault.getNftOwner(mint)` 实现了反向校验，可以借鉴。
3. **`@jup-ag/lend-read` 还在 0.0.x**：版本号暗示 API 不稳定。最近 5 天发了 5 个版本（0.0.12 是 5/4 发的）。需要 lock major+minor 并做适配层。
4. **数据精度**：所有金额是 raw u64/u128 BN，必须用 BN.js 算，不能转 Number。acex 的 `BigNumber` 类型要兼容 BN.js（看 acex 类型定义）。
5. **Jupiter API 限速 300/min**：如果 acex 同时跟踪 100 个钱包并 30s 一次刷新，瞬时 200/min，接近上限，需要做 batched 请求。
6. **健康因子需要自己算**：API/SDK 没有直接提供 `healthFactor` 字段。要从 `position.colRaw × oraclePrice × liquidationThreshold` 和 `position.debtRaw × borrowOraclePrice` 算。这个计算公式在 `@jup-ag/lend-read` 内部有，得仔细看源码或 IDL；写错方向会让风控判断反过来。

### 未知 / 待跟进

1. **`/borrow/positions?users=` endpoint 是否真的支持**：需要找一个有真实借贷头寸的钱包验证。建议用 Solscan 找一个 vault 的 active position 反查 owner 后试。
2. **API key 申请流程**：`new Client({ apiKey })` 暗示有付费层，但 dev.jup.ag 上没找到 lend API 的 key 申请链接。MVP 用公共 lite-api 就够。
3. **`supplyAPY` 中 rewards 部分的归属**：`totalRate = supplyRate + rewardsRate`，但 rewardsRate 通常是协议补贴（JUP token 等），不是原生利息。acex 的 `supplyAPY` 字段语义需要明确：是 `totalRate` 还是 `supplyRate`。
4. **是否有 Solana websocket 订阅可用**：MVP 不做，但 Solana RPC 有 `accountSubscribe` / `programSubscribe`——`Position` 账户变更可订阅。`@jup-ag/lend-read` 没现成封装，自己写不复杂。
5. **Fluid Protocol 关系**：Jupiter 团队没公开宣称基于 Fluid。如果将来 Fluid 进 Solana，可能产生竞争或合作；架构上 Jupiter Lend 几乎肯定是 Fluid 的 fork，但 license 关系不明（`@jup-ag/lend` 是 MIT，`@jup-ag/lend-read` 没列 license）。
6. **mainnet program 升级历史**：还没查 program upgrade authority 是否还在 mutable 状态。production-grade 协议通常会 freeze 或转 multisig；这个会影响"协议会不会突然换 IDL"的风险评估。

### Deprecation 信号

- 截至调研日（2026-05-05），**没看到任何 deprecation 信号**：
  - npm 包仍在每周发新 beta
  - DefiLlama TVL 持续在 $9 亿水位
  - GitHub `jupiter-lend` 仓库 2 周前还在更新
  - dev.jup.ag/docs/lend-api 仍是公开的有效页面
- 反而是从 alpha → 主流市场地位的快速增长期。

## 6. 关键链接

### 官方资源

- **Jupiter 文档主站**：<https://station.jup.ag/>（产品文档）
- **Jupiter Dev 文档**：<https://dev.jup.ag/docs/>（开发者文档）
  - Lend API 文档（页面存在，需 JS 渲染才能看全）：<https://dev.jup.ag/docs/lend-api>
- **GitHub 集成指南仓库**：<https://github.com/jup-ag/jupiter-lend>
  - SDK 指南（Earn）：<https://github.com/jup-ag/jupiter-lend/blob/main/docs/earn/sdk.md>
  - SDK 指南（Borrow）：<https://github.com/jup-ag/jupiter-lend/blob/main/docs/borrow/sdk.md>
  - CPI 指南（Earn）：<https://github.com/jup-ag/jupiter-lend/blob/main/docs/earn/cpi.md>
  - CPI 指南（Borrow）：<https://github.com/jup-ag/jupiter-lend/blob/main/docs/borrow/cpi.md>
- **IDL 文件**：<https://github.com/jup-ag/jupiter-lend/tree/main/target/idl>（lending.json / vaults.json / liquidity.json / oracle.json / flashloan.json / merkle_distributor.json）
- **TypeScript 类型**：<https://github.com/jup-ag/jupiter-lend/tree/main/target/types>

### npm 包

- **`@jup-ag/lend`**（综合 SDK）：<https://www.npmjs.com/package/@jup-ag/lend>
- **`@jup-ag/lend-read`** ⭐（推荐的只读 SDK）：<https://www.npmjs.com/package/@jup-ag/lend-read>
- **`@jup-ag/cli`**（CLI 工具，含 Lend 子命令）：<https://www.npmjs.com/package/@jup-ag/cli>
- **`@jup-ag/api`**（聚合器 API，不是 Lend）：<https://www.npmjs.com/package/@jup-ag/api>

### REST API 端点（实测有效）

- 列出 jlToken 池：`GET https://lite-api.jup.ag/lend/v1/earn/tokens`
- 用户 Earn 头寸（核心）：`GET https://lite-api.jup.ag/lend/v1/earn/positions?users=<wallet>`
- 列出 borrow vaults：`GET https://lite-api.jup.ag/lend/v1/borrow/vaults`
- 限速：`x-ratelimit-limit: 300`（每分钟）

### Mainnet Solana 浏览器

- **Lending Program**：<https://solscan.io/account/jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9>
- **Vaults Program**：<https://solscan.io/account/jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi>
- **Liquidity Program**：<https://solscan.io/account/jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC>
- **Oracle Program**：<https://solscan.io/account/jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc>

### 第三方数据源（验证用）

- **DefiLlama 协议页**：<https://defillama.com/protocol/jupiter-lend>（API: `https://api.llama.fi/protocol/jupiter-lend`）
- **DefiLlama Yields**：`https://yields.llama.fi/pools` filter `project=jupiter-lend`
- **CoinGecko jlToken 价格**：每个 jlToken 都有独立 coingeckoId（API 返回字段里）

### 相关参考（非 Jupiter 自家）

- **Instadapp Fluid Protocol（架构原型）**：<https://fluid.instadapp.io>（Jupiter Lend 几乎肯定基于此移植；理解 Fluid 文档对理解 Jupiter Lend 的 tick / smart-debt 模型有直接帮助）
- **Solana Anchor 文档**：<https://www.anchor-lang.com/>
- **`@coral-xyz/anchor`**：<https://www.npmjs.com/package/@coral-xyz/anchor>
