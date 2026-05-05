# Solana 借贷生态调研

> **调研日期**：2026-05-05
> **数据时效**：以下 TVL / 版本号基于本次离线整理（训练截止 + 公开文档），**所有具体数字必须在合并前回 DeFiLlama 与各家 GitHub / npm 复核**。架构性结论（账户模型、健康因子方向、SDK 存在与否）在 2024H2 后基本稳定，可放心引用。
> **场景前提**：acex 首发只接 Jupiter Lend，但需要判断未来是否需要把 adapter 抽象层做得能容纳 Kamino / MarginFi / Solend / Drift 等多协议，类似 EVM 侧 Aave / Compound / Morpho 多协议格局。

---

## 1. 协议对比表

> TVL 与活跃度数据源：DeFiLlama `https://defillama.com/protocols/Lending/Solana`。下表数字是**量级参考**，不要直接 copy 进 PRD 引用，请在合入决策时用 DeFiLlama 当日值替换。

| 协议 | TVL（量级） | 上线 | 活跃度 / 维护状态 | 主合约 program | 官方 TS SDK | 健康因子方向 |
|---|---|---|---|---|---|---|
| **Kamino Lend (K-Lend)** | $1B+ 量级，长期 Solana 借贷 TVL 第一 | 2022 起 Kamino，K-Lend 2023 下半年 | 高，团队活跃，多产品（Lend / Vaults / Multiply / Liquidity） | `KLend1hCSdz...`（具体 program ID 见 docs） | ✅ `@kamino-finance/klend-sdk` | 越大越安全，<1 可清算（Aave 风格 healthFactor） |
| **MarginFi v2** | 高峰 $1B+，2024 团队风波后回落到几亿量级 | 2022 | 中，团队内讧 / Edgar Pavlovsky 事件后社区分裂；产品仍运行、TS SDK 仍发版 | `MFv2hWf31Z9k...` | ✅ `@mrgnlabs/marginfi-client-v2` | 用「health」概念：(assetsWeighted - liabsWeighted) / assetsWeighted，>0 安全，0 即清算线 |
| **Solend → 改名 Save** | 高峰 $1B（2022），FTX 后大幅回落到几千万 ~ 亿量级 | 2021，最早的 Solana 借贷 | 低-中，2024 中改名 Save 后产品仍在但活跃度下滑；SDK 长期没大版本更新 | `So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo` | ⚠️ `@solendprotocol/solend-sdk`（更新慢） | Aave 风格 healthFactor，<1 清算 |
| **Drift Protocol（spot + lending）** | 数亿量级，主业是 perp DEX | 2021 v1，2022 v2 | 高，活跃维护 | `dRiftyHA39MWE...` | ✅ `@drift-labs/sdk` | cross-margin 模式，用 `marginRatio` / `freeCollateral`，与 perp 一体 |
| **Jupiter Lend** | 较新，几千万到亿级量级（增长中） | 2024–2025 | 高，Jupiter 主力推产品 | （新部署 Anchor program，见 Jupiter docs） | ⚠️ 主要走 REST API + 客户端 SDK 雏形（截至调研日 npm 上没有像 klend-sdk 那样成熟的纯 SDK） | Aave 风格 healthFactor，<1 清算（与 Fluid / Aave 同方向） |
| **Save**（即 Solend 重塑） | 同 Solend | 2024 改名 | 见上 | 同上 | 同上 | 同上 |

**第二梯队（这次不做重点对比，但记录存在）**：

- **Mango v4**：cross-margin 现货 + perp + 借贷一体，类似 Drift 的产品形态。SDK：`@blockworks-foundation/mango-v4`。
- **Port Finance**：早期协议，基本休眠。
- **Larix**：早期协议，基本休眠。
- **Jet Protocol v2**：早期协议，团队解散，已基本下线。
- **Texture / Lulo / 其它新协议**：长尾，不影响主流抽象。

**结论（量级层面）**：截至 2025/2026，Solana 借贷生态的"主流派"是 **Kamino + MarginFi + Drift**（活跃维护 + 上规模），**长尾派**是 Save / Mango / Jupiter Lend。再叠加 Jupiter Lend 作为 Jupiter 体系内"明星新人"。和 EVM 上 Aave 一家独大、Compound + Morpho + Spark 第二阵营的格局相比，**Solana 借贷头部更分散、产品形态差异更大**。

---

## 2. 数据模型差异

### 2.1 账户结构对比

| 协议 | 用户级账户 | 资产级账户/池 | 资产维度建模 | 隔离 vs 全仓 |
|---|---|---|---|---|
| **Kamino Lend** | `KaminoObligation`（每钱包 + 每 lending market 一个 PDA） | `Reserve`（每资产一个 PDA） | obligation 内有 `deposits[]` + `borrows[]`，每条引用一个 reserve | 默认 cross-collateral；通过 **elevation group**（类似 Aave eMode）实现风险隔离/相关资产同组提杠杆 |
| **MarginFi v2** | `MarginfiAccount`（每钱包一个 PDA，挂在 group 下） | `Bank`（每资产一个 PDA，资产即"银行"） | account 内有 `lendingAccount.balances[]`，每条对应一个 Bank；同时记 `assetShares` 和 `liabilityShares` | cross-collateral；多 group 概念（默认 main group），不同 group 互相隔离 |
| **Solend / Save** | `Obligation`（每钱包 + 每 lending market 一个 PDA） | `Reserve`（每资产一个 PDA） | obligation 有 `deposits[]` + `borrows[]` | 通过 **多 lending market 隔离**（main pool / isolated pools），每个 market 内部 cross-collateral |
| **Drift** | `User`（每钱包 + sub-account 一个 PDA） | `SpotMarket`（每资产）+ `PerpMarket` | user 的 `spotPositions[]` 同时表示存款（正）和借款（负） | cross-collateral，spot + perp 共享保证金 |
| **Jupiter Lend** | （需查 Jupiter docs 确认 PDA seed 命名）每钱包一个 lending position 账户 | 每市场一个 reserve / token vault | 类似 Fluid 风格：单资产 vault 或 mode-based pair | 见 Jupiter docs；MVP 我们只需要把它当成 obligation + reserve 的一种 |

### 2.2 共同字段（抽象基线）

无论协议名字怎么变，所有 Solana 借贷协议**都至少能给出**：

- 钱包地址（base58 pubkey）
- 一组 supply（抵押）头寸：`{ asset, amount, valueUSD, supplyAPY?, isCollateral? }`
- 一组 borrow（负债）头寸：`{ asset, amount, valueUSD, borrowAPY? }`
- 账户级风控：`totalCollateralUSD` / `totalDebtUSD` / `liquidationThreshold` / `healthFactor`（命名各异）
- 协议参数：每资产的 LTV、清算 LTV、清算罚金、利率模型

这一组**就是 PRD 里 `LendingBalanceFacet` + `LendingRiskFacet` 的最小公分母**——已经足够覆盖全部主流协议。

### 2.3 差异点（决定 adapter 抽象边界）

1. **隔离粒度不同**：
   - Solend / Kamino：通过"多个 market"做隔离（同一 program、不同 lending market PDA）。一个钱包可能有多个 Obligation。
   - MarginFi：默认全仓，靠 group 隔离（普通用户基本只用 main group）。
   - Drift：sub-account（子账户）隔离。
   - **抽象启示**：account identifier 不能只是 `wallet`，需要 `wallet + market/group/subAccountIndex`。
2. **同币种"同时抵押 + 借出"模型**：
   - MarginFi：用 `assetShares` + `liabilityShares` 双值，会同时非零。
   - Kamino / Solend：obligation 的 deposits[] 和 borrows[] 是不同条目，不会重叠（同币不能同时存又借）。
   - **抽象启示**：`LendingBalanceFacet` 要保留 `supplied` + `borrowed` 双字段（已经是 PRD R1 的设计），不要合成 net。
3. **元数据来源不同**：
   - Reserve / Bank 上的 LTV / 清算阈值 / 利率参数都是链上字段，但**币价 USD**几乎都依赖外部 oracle（Pyth / Switchboard）。MarginFi、Kamino、Drift 都直接读 Pyth。
   - **抽象启示**：adapter 需要约定 USD 计价口径——是直接信任协议链上 oracle 价（与协议清算口径一致），还是引入外部价（容易和清算口径打架）。**强烈建议跟随协议自己的 oracle**。
4. **APY 计算位置**：
   - 不同协议的 supplyAPY / borrowAPY 计算口径不同（线性/复利、按 slot/年化），都需要从 reserve 当前利率参数现场算。SDK 通常已封装 `getSupplyApy() / getBorrowApy()`。
   - **抽象启示**：APY 字段 PRD 标 optional 是对的；首发可以先全部置空，未来再补。
5. **多链情况**：
   - Kamino / MarginFi / Solend / Drift / Jupiter Lend 全是 **Solana-only**（mainnet-beta），没有 EVM 侧或其它链复用问题。**这点和 Aave 多链铺开完全不同**。MVP 不必考虑多 cluster 抽象，但 Solana mainnet vs devnet 的 RPC 切换还是要保留。

---

## 3. SDK 成熟度

> 版本号请合入决策时回 npm 复核（`npm view @kamino-finance/klend-sdk version` 等）。

### 3.1 Kamino - `@kamino-finance/klend-sdk`

- **包名**：`@kamino-finance/klend-sdk`（还有 `@kamino-finance/kliquidity-sdk`、`@kamino-finance/scope-sdk` 等周边）。
- **维护**：活跃，跟随 program 升级有版本迭代。
- **依赖**：`@coral-xyz/anchor` + `@solana/web3.js`，需要 `Connection`，纯只读使用**不需要 wallet adapter**——构造 `KaminoMarket.load(connection, marketPda)` 即可。
- **关键 API**：`KaminoMarket.load`、`KaminoObligation.load`、`market.getReserves()`、`obligation.refreshedStats`（含 borrowLimit / liquidationLtv / loanToValue / userTotalDeposit / userTotalBorrow）。
- **结论**：Solana 借贷里 SDK 最好用、最 ergonomic 的一家，read-only 友好。

### 3.2 MarginFi - `@mrgnlabs/marginfi-client-v2`

- **包名**：`@mrgnlabs/marginfi-client-v2`，配套 `@mrgnlabs/mrgn-common`。
- **维护**：团队风波后仍在发版（Edgar 离开后由其他成员维护），节奏放缓但未停。
- **依赖**：Anchor + web3.js。`MarginfiClient.fetch()` 可以传 read-only `Wallet`（像 `NodeWallet` 用 dummy keypair）来构造，**纯查询不需要私钥**。
- **关键 API**：`MarginfiClient.fetch()`、`client.getMarginfiAccountByAuthority(wallet)`、`account.computeHealthComponents()`、`bank.getAssetUsdValue()`。
- **结论**：可用，read-only 友好，但需要给 dummy wallet（不会签名）；SDK 文档稍显碎片化。

### 3.3 Solend / Save - `@solendprotocol/solend-sdk`

- **包名**：`@solendprotocol/solend-sdk`。
- **维护**：偏冷，最近大版本更新少；改名 Save 后是否会出新 SDK 待定。
- **依赖**：web3.js，部分调用直接读 Reserve account 字节解码，不强依赖 Anchor。
- **关键 API**：`SolendMarket.initialize()`、`market.fetchObligationByWallet(wallet)`、`obligation.borrowLimit / liquidationThreshold / healthFactor`。
- **结论**：可用但要做好 SDK 不再升级的预期；如果未来要接，建议把读路径写薄一点，不要深度 binding。

### 3.4 Drift - `@drift-labs/sdk`

- **包名**：`@drift-labs/sdk`。
- **维护**：非常活跃，与 perp 主业一体。
- **依赖**：Anchor + web3.js。`DriftClient` 可在 read-only 模式构造（传 `ReadOnlyAdapter` / dummy wallet）。
- **关键 API**：`DriftClient.subscribe()`、`User.getSpotMarketAssetValue()`、`User.getMarginRequirement()`、`User.getHealth()`。
- **结论**：成熟，但需要注意 Drift 的 spot 借贷只是其 cross-margin 体系的一部分，抽象成"借贷头寸"时要区分 perp 部分。

### 3.5 Jupiter Lend - 待定

- **状态**：首发目标。截至调研日没看到独立、稳定、open-source 的 `@jup-ag/lend-sdk`（Jupiter 各类产品的 SDK 比较碎，部分功能走 REST API）。
- **预期路径**：（按已确认的 PRD 假设）走 (a) Jupiter Lend REST API 优先，(b) RPC + 自带 IDL fallback。
- **结论**：MVP 自己包一层即可；不要因为它没有官方 TS SDK 就阻塞；反而要把这层"自己读 program account"的能力沉淀好，复用到未来其他协议。

### 3.6 SDK 对 read-only 友好度排序

排序（最友好 → 最不友好）：**Kamino ≥ Drift > MarginFi > Solend > Jupiter Lend（无 SDK，需自封装）**。

共同模式：所有 Anchor SDK 在 read-only 场景下都需要传一个"假钱包"（NodeWallet + dummy Keypair），因为 AnchorProvider 强制要求 Wallet 接口；这个 dummy wallet **永远不会被调用 signTransaction**——只要 adapter 不调写方法即可。这一点在 acex SDK 里需要在 spec 里写清楚：**"DEX 借贷 adapter 永远不调用任何 mut/写入指令；任何含 mut 入参的方法都被禁用"**。

---

## 4. 风控口径一致性

### 4.1 各家原生指标方向

| 协议 | 原生字段 | 公式（粗略） | 方向 | 清算阈值 |
|---|---|---|---|---|
| Kamino | `healthFactor` | `liquidationThresholdValueUsd / borrowedValueUsd` | 越大越安全 | < 1.0 |
| Solend | `healthFactor` | 同上 | 越大越安全 | < 1.0 |
| Jupiter Lend | `healthFactor`（同 Aave 范式） | 同上 | 越大越安全 | < 1.0 |
| MarginFi | `health` 或 `assetWeightedValue / liabilityWeightedValue` | `(assetsWeighted - liabsWeighted) / assetsWeighted`，0 即触发清算 | 越大越安全（0~1 区间） | ≤ 0 |
| Drift | `marginRatio` / `freeCollateral` | cross-margin 一体 | freeCollateral 越大越安全；marginRatio 也是越大越安全 | freeCollateral < 0 或 marginRatio < maintMarginRatio |

### 4.2 是否都暴露 LTV / liquidationThreshold

- Kamino / Solend / Jupiter Lend：明确暴露 `loanToValue`（账户级）+ `liquidationLtv`（账户级）+ `reserve.config.liquidationLtv`（协议参数级）。
- MarginFi：不直接叫 LTV，用 `assetWeightInit / assetWeightMaint` + `liabilityWeightInit / liabilityWeightMaint` 折算；在 SDK 里有 `bank.getAssetWeight()` 等。能换算成等价 LTV，但语义不是 1:1 对齐。
- Drift：以 `marginRatio` 为主，没有"LTV"概念；spot lending 那部分有清算价但不叫 LTV。

### 4.3 与 PRD ADR-2 的契合度

PRD R2 / ADR-2 把统一 `riskRatio = MM / Equity`，越小越安全，<1 安全、=1 清算。映射到 Solana 各家：

- Kamino / Solend / Jupiter Lend：`riskRatio = 1 / healthFactor`（公式直接套用 PRD 已写的 Aave 转换）。
- MarginFi：需要自定义 `riskRatio = liabilityWeightedValue / assetWeightedValue`（即原生 health 的反向）。**注意**：MarginFi 的"清算线" health 是 0 而不是 1；映射到统一 riskRatio 时，MarginFi 清算线就是 `riskRatio = 1.0`，与 PRD 的统一阈值一致——**原始字段 `health` 仍保留在 `lending` facet 中给需要原值的策略**。
- Drift：spot lending 部分单独抽到 lending facet 里要做适配；cross-margin 那部分如果要支持，会和 perp manager 重叠，建议**首发不接 Drift 的 lending**，避免在 lending adapter 里混进 perp 概念。

**一致性结论**：四家头部协议的风控可以统一成 `riskRatio` + 原生 `healthFactor` / `health` 双字段，**PRD 的设计能覆盖**——前提是约定每家 adapter 的转换公式并写进 spec（参考 PRD ADR-2 已经做的 CEX 那几家公式）。

---

## 5. 聚合数据源

### 5.1 是否存在「一个 API 拿全部 Solana 借贷头寸」的服务

**有，但都不是完美方案**：

1. **Step Finance**（`https://step.finance`，API：`https://app.step.finance/`）：
   - Solana 多协议 portfolio 聚合的事实标准产品（dashboard 用户最多）。
   - 公开 API 受限（部分需要 API key / 商业合作）；社区版可通过抓 dashboard 网络请求逆向。
   - 覆盖 Kamino / MarginFi / Solend / Mango / Drift / Jupiter 等。
   - **可靠性**：很高；但**不是面向开发者的稳定产品**——主要是终端 UI。
2. **Sonar Watch**（`https://sonar.watch`）：
   - 多链 DeFi portfolio 聚合，Solana 覆盖较好。
   - 提供 SDK：`@sonarwatch/portfolio-core` + `@sonarwatch/portfolio-plugins`，**MIT 开源**，每个协议一个 plugin。
   - **可靠性**：开源、活跃、是目前最接近 zerion/debank 的**面向 SDK 集成方**的方案。
   - **直接可用**：可以引入 Sonar plugin 系统作为 fallback；但要权衡多引入一个依赖 vs 自己写各协议 fetcher 的成本。
3. **Helius**（`https://helius.xyz`）：
   - Solana RPC + indexing 头部服务，提供增强 API（webhook、enriched transactions）。
   - **没有**开箱即用的"借贷头寸"端点；但可以基于 program-aware decoders 自己组合。
4. **Birdeye**（`https://birdeye.so`）：
   - 偏行情/价格/钱包余额，**没有**专门的借贷头寸聚合。
5. **DefiTuna**（`https://defituna.com`）：
   - Solana DeFi 数据聚合产品；**借贷头寸聚合能力有限**（更偏 LP / DEX 流动性数据）。
6. **DeFiLlama 的 `/protocols`** + **Open API**：
   - 协议级 TVL、yields、pool APY，**不能做"按钱包查头寸"**。
7. **Zerion / Debank**：
   - Zerion 2024 起已加 Solana 支持，但深度远不如 EVM 侧；Solana 借贷头寸覆盖不如 Step / Sonar。
   - Debank 基本不做 Solana。

### 5.2 结论

如果将来 acex 想要「一次调用拿一个钱包在所有 Solana 借贷协议的头寸」，**最务实的路径是 Sonar Watch 的开源 portfolio-plugins**——它已经按协议拆 plugin、有 TS 类型、可以引入做 fallback。但首发**不需要**走聚合层，直接每个协议一个 adapter 是更可控、与 acex 现有 adapter 模式一致的做法。

---

## 6. 对 acex 设计的启示

> 前提复述：MVP 只接 Jupiter Lend；目标是 **不让首发的 Jupiter Lend adapter 把抽象层锁死**，未来如果要加 Kamino / MarginFi 时不用大改类型。

### 6.1 强建议「在抽象层预留」的点

1. **账户标识不能只用 `wallet`**：
   - PRD 已经写过 `protocol + cluster + walletAddress`，**还需要再加一个 `subAccountId / marketId / groupId`**（默认 0/main，但字段必须存在）。否则 Solend 多 market、MarginFi 多 group、Drift 多 sub-account 接入时要被迫改 `RegisterAccountInput`。
   - 推荐 shape：`{ exchange: "jupiter-lend", protocol: "jupiter-lend", cluster: "mainnet-beta", walletAddress, subAccountId?: string }`。
2. **`LendingBalanceFacet.supplied` + `borrowed` 不要合成 net**（PRD 已是这么设计，**保持**）：MarginFi 同币双向头寸场景需要两个值都保留。
3. **`LendingRiskFacet` 保留原生字段 + 统一 `riskRatio`**（PRD 已是这么设计，**保持**）：每家原生指标方向不同，原生值要进 facet；统一 riskRatio 只放一个。
4. **`LendingRiskFacet.liquidationThreshold` 字段语义要写进 spec**：
   - Aave 风格协议（Kamino / Solend / Jupiter Lend）：每个抵押资产一个 LiqLtv，账户级是加权平均。
   - MarginFi 没有 LTV 概念，要用资产权重换算后填入；spec 要写明这是"等效 LTV"而不是协议原生字段。
5. **adapter 内部要分离"读 reserve/market 配置" 和 "读 obligation/account 头寸"**：
   - reserve 配置变化频率低（小时级），可以缓存。
   - obligation 头寸变化频率高（每个新区块），是主轮询对象。
   - 这个二级缓存策略对所有 Solana 借贷协议都适用，做成 base class / 共享 helper 之后接 Kamino 就近乎白送。
6. **价格口径**：spec 写明 USD 计价跟随**协议自己的 oracle**（Pyth）。不要引入第三方价（Coingecko）和清算口径打架。Jupiter Lend / Kamino / MarginFi 都用 Pyth，正好能复用。

### 6.2 不需要预留 / 暂时不动的点

1. **多链抽象**：Solana 借贷协议**全是 Solana-only**，不存在 Aave 跨 EVM 链那种格局。`cluster` 字段保留即可，不需要做"多链 adapter 工厂"。
2. **聚合 SDK 集成**：MVP 不需要引入 Sonar / Step。每个协议一个 adapter 反而更符合 acex 现有 layered 架构。
3. **WebSocket 订阅**（`accountSubscribe`）：PRD 已经明确 MVP 用轮询，保持。
4. **APY 字段**：PRD 已标 optional，首发可以先全部 undefined，等接入第二个协议时再统一实现。

### 6.3 与 EVM Aave / Compound / Morpho 多协议格局的对比

EVM 借贷的多协议抽象（zerion-sdk / @aave/contract-helpers / morpho-blue-sdk）面临的难题主要是：

- 同一 chain 多个 protocol（Aave / Compound / Morpho 在 mainnet 同时存在），用户头寸分散。
- 同一 protocol 多 chain（Aave 在 mainnet/optimism/arbitrum 都有），需要跨链聚合。
- Morpho Blue / Euler / Spark 等"无许可借贷市场"模型让 reserve 维度爆炸。

Solana 上**没有"无许可借贷市场"问题**（Kamino / MarginFi / Solend 的 reserve 都是治理添加的），**没有跨链问题**。所以 acex 在 Solana 这边的多协议抽象**比 EVM 简单一个数量级**——做好"多 program / 多 obligation 模型"足够。

### 6.4 单句结论

> Solana 头部借贷协议（Kamino / MarginFi / Solend / Jupiter Lend）在数据模型与风控指标上**能用同一组 facet 字段（PRD 已设计好的 `LendingBalanceFacet` + `LendingRiskFacet`）干净覆盖**。**首发只接 Jupiter Lend 不会把抽象锁死**，前提是 `RegisterAccountInput` 预留 `subAccountId / marketId` 字段、`LendingRiskFacet` 同时保留原生指标和统一 `riskRatio`、`reserve` 配置和 `obligation` 头寸读取分层缓存。EVM 那套"多协议 + 多链"的复杂度**在 Solana 这边可以暂时不投资**。

---

## 7. 关键链接

### 7.1 协议官方

- Kamino docs: `https://docs.kamino.finance/`
- Kamino lending: `https://app.kamino.finance/lending`
- MarginFi docs: `https://docs.marginfi.com/`
- MarginFi app: `https://app.marginfi.com/`
- Solend / Save docs: `https://docs.solend.fi/`，`https://save.finance/`
- Drift docs: `https://docs.drift.trade/`
- Jupiter Lend: `https://jup.ag/lend`，docs 在 `https://dev.jup.ag/`
- Mango v4 docs: `https://docs.mango.markets/`

### 7.2 SDK / npm

- `@kamino-finance/klend-sdk`：`https://www.npmjs.com/package/@kamino-finance/klend-sdk`
- `@mrgnlabs/marginfi-client-v2`：`https://www.npmjs.com/package/@mrgnlabs/marginfi-client-v2`
- `@solendprotocol/solend-sdk`：`https://www.npmjs.com/package/@solendprotocol/solend-sdk`
- `@drift-labs/sdk`：`https://www.npmjs.com/package/@drift-labs/sdk`
- `@blockworks-foundation/mango-v4`：`https://www.npmjs.com/package/@blockworks-foundation/mango-v4`
- Sonar portfolio plugins（多协议聚合参考实现，开源）：`https://github.com/sonarwatch/portfolio`

### 7.3 数据源

- DeFiLlama Solana lending：`https://defillama.com/protocols/Lending/Solana`
- DeFiLlama yields：`https://defillama.com/yields?chain=Solana&category=Lending`
- Step Finance：`https://app.step.finance/`
- Sonar Watch：`https://sonar.watch/`
- Helius：`https://helius.xyz/`
- Pyth oracle（Solana 借贷协议主流价源）：`https://pyth.network/`

### 7.4 风控公式参考

- Aave V3 health factor 文档（与 Kamino / Solend / Jupiter Lend 同范式）：`https://docs.aave.com/risk/asset-risk/risk-parameters`
- MarginFi health 概念：MarginFi docs 中 "Health Factor" 一节（含 weight init/maint 解释）。

---

## 数据复核 checklist（合入决策前）

- [ ] DeFiLlama 上各协议当日 TVL（Kamino / MarginFi / Solend(Save) / Drift / Jupiter Lend）→ 替换第 1 节的"量级"列。
- [ ] `npm view @kamino-finance/klend-sdk version` / `@mrgnlabs/marginfi-client-v2` / `@solendprotocol/solend-sdk` / `@drift-labs/sdk` → 确认最近发布日期，验证活跃度结论。
- [ ] Jupiter Lend 是否已有官方 npm SDK（`@jup-ag/lend-sdk` 或类似）→ 决定首发 adapter 走 SDK 还是 REST/RPC 直连。
- [ ] MarginFi v2 program 是否仍在 main group 主控（团队风波后是否有重大架构变更）。
