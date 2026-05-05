# 接入 DEX 借贷账户只读视图，统一风控抽象

## Goal

把 **Solana 上的 Jupiter Lend** 借贷协议账户接入现有 acex SDK，让策略侧通过统一接口拿到「余额 + 借贷头寸 + 风控值」，并能与 CEX 账户的 `riskRatio` 同台对照。**只读、不下单**——不实现 supply / borrow / repay / withdraw 等链上写操作。

核心洞察：CEX 与 DEX 借贷账户在抽象层面共享两个核心概念——**资产余额** 与 **风控水位**——只是底层数据来源（CEX listenKey/WebSocket vs Jupiter HTTP API）和具体语义不同。MVP 围绕这两个概念建立统一表层。

## What I already know

来自仓库已确认的现状：

- `RegisterAccountInput` (`src/types/shared.ts:50-55`) 当前只有 `accountId + venue + credentials + options`，**没有"账户类型"维度**——所有账户被假设为 CEX 推送式账户。
- `Venue = "binance" | "okx" | "bybit" | "gate"` (`src/types/shared.ts:1`)，DEX 不在枚举内。
- `BinancePrivateAdapter` (`src/adapters/binance/private-adapter.ts`, 838 行) hard-code 走 PAPI UM endpoint，listenKey + WebSocket 推送式架构；`PrivateUserDataAdapter` 接口 (`src/adapters/types.ts:189-220`) 也是为推送模型设计（含 `createPrivateStream` 必返回 `StreamHandle`）。
- `BalanceSnapshot` (`src/types/account.ts:51-62`) 字段：`free / used / total`，没有 `borrowed / collateral / netAsset / interest` 概念。
- `RiskSnapshot` (`src/types/account.ts:81-92`) 字段：`equity / marginRatio / initialMargin / maintenanceMargin`，可用于承载 DEX 的「LTV / healthFactor / liquidationThreshold」类指标，但语义需要对齐。
- `PositionSnapshot`：DEX 借贷账户没有 perp/swap 意义上的 `position`，positions 数组对借贷账户应为空。
- 当前架构是「Layer 1 适配层 + Layer 2 领域 manager + Layer 3 编排 runtime」5 层（见 `.trellis/spec/backend/index.md`），新增账户类型的标准做法是新建 adapter 而不是改现有 adapter。
- `AccountManager.events.updates` / `status` 是 push 模型的 `AsyncIterable`，DEX 拉取式数据要么走轮询发事件、要么仅暴露 getter。

来自用户的输入：

- 接入对象是 **DEX 借贷账户**（不是 CEX margin、不是 PAPI、不是 DEX perp）。
- **只读**：MVP 不考虑下单/借/还/抵押操作。
- 用途：**策略消费**——某些交易策略需要把 DEX 借贷头寸/风控值纳入决策。
- 用户主动提到「都有风控值」——说明期望统一的核心是 risk dimension。

## Assumptions (temporary, to validate)

1. ~~接入目标协议是 Aave V3~~ → **更正：接入 Jupiter Lend (Solana)**。是否需要同时支持其他 Solana 借贷协议（Kamino / MarginFi / Solend）作为 backup 数据源待 research 后确认。
2. 数据获取方式已定：MVP 使用 Jupiter Portfolio HTTP API + Jupiter Lend lite-api vault 元数据；不用链上 RPC / Anchor / viem。
3. 「账户」标识 = 用户自定义 `accountId`；Solana 钱包地址通过 `options.walletAddress` 提供，允许同一钱包注册成多个逻辑账户。可选 `options.positionId` 用于只观察某个 Juplend NFT position。
4. 数据刷新走**主动轮询**（默认 30s 一次）。Solana 有 `programSubscribe` / `accountSubscribe` 事件订阅但 MVP 先不做。
5. 需要查询的最小数据集（待 research 确认 Jupiter Lend 实际暴露字段）：
   - 各资产的 `supplied`（抵押）+ `supplyAPY`
   - 各资产的 `borrowed` + `borrowAPY`
   - 账户级 `riskRatio` + `totalCollateralUSD` + `totalDebtUSD` + `liquidationThreshold`
6. 不引入私钥/签名相关代码（因为只读）。
7. **新假设**：Solana 公链 cluster MVP 只支持 mainnet-beta；devnet 留给测试。

## Open Questions

无。Blocking / Preference 问题已收敛至 ADR，见 `## Decision (ADR-lite)`。

## Acceptance Criteria (evolving)

(详见下方正式的 `## Acceptance Criteria` 段——所有 ADR 收敛后重写)

## Requirements (evolving)

### R1. BalanceSnapshot 建模：基础字段 + `lending` facet（已确认）

```ts
interface BalanceSnapshot {
  accountId: string;
  venue: Venue;     // 后续可能改为 venue/protocol
  asset: string;
  free: BigNumber;        // 现有字段不动
  used: BigNumber;
  total: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  // 新增：仅在借贷型账户/资产上出现
  lending?: LendingBalanceFacet;
}

interface LendingBalanceFacet {
  supplied: BigNumber;            // 抵押品余额
  borrowed: BigNumber;            // 已借（含本金）
  interest: BigNumber;            // 累计未结利息
  netAsset: BigNumber;            // = supplied - borrowed
  supplyAPY?: BigNumber;          // 当前年化（可缺失）
  borrowAPY?: BigNumber;
}
```

设计原则：
- 现有 CEX 调用方完全不破坏（`free/used/total` 字段语义不变，永远在）
- 借贷专属字段全部归到 `lending` 子结构，TS narrow 后强类型；`b.lending?.borrowed` 即可识别
- 同一资产同时是抵押品 + 负债时，两套数字不互相覆盖（CEX margin / Aave 同地址同币都会出现）
- Juplend MVP 按 `asset` 聚合余额：同一钱包多个 NFT position 的同资产 `supplied / borrowed / netAsset` 汇总到同一条 `BalanceSnapshot`
- 该模式可推广到未来其他 facet（`derivatives?` / `staking?` 等），是 SDK 长期演进的扩展点

### R2. RiskSnapshot 字段重命名 + 语义统一为「教科书 riskRatio」（已确认）

```ts
interface RiskSnapshot {
  accountId: string;
  venue: Venue;
  equity?: BigNumber;             // 净权益（USD 计价）

  // ⬇⬇⬇ 重命名 + 语义反转
  riskRatio?: BigNumber;          // = MM需求 / 净权益；越小越安全；清算阈值 = 1.0
                                  // (旧字段名 marginRatio，旧语义存的是 uniMMR — 全部修正)

  initialMargin?: BigNumber;
  maintenanceMargin?: BigNumber;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;

  // 借贷型账户的扩展指标
  lending?: LendingRiskFacet;
}

interface LendingRiskFacet {
  // CEX margin 类
  marginLevel?: BigNumber;        // Binance margin level 原值（越大越安全）
  // DEX 类
  healthFactor?: BigNumber;       // Aave hf 原值（越大越安全），= 1 / riskRatio
  ltv?: BigNumber;                // 借贷价值 / 抵押价值
  liquidationThreshold?: BigNumber; // 协议设定的清算 LTV
  totalCollateralUSD?: BigNumber;
  totalDebtUSD?: BigNumber;
}
```

**统一规则：**
- `riskRatio` 是跨 CEX/DEX 的统一字段，**唯一真源**：所有 adapter 都要从原生指标转换（不允许各家保留自己方向）。
- 转换公式登记在 spec：
  - Binance PAPI: `riskRatio = 1 / uniMMR`
  - Binance Margin: `riskRatio = totalLiability / totalAsset`（即 `1 / marginLevel`）
  - Binance USDT-M Futures: 直接用原生 maintMargin/equity（已是同方向）
  - OKX: `riskRatio = 1 / mgnRatio`
  - Aave V3: `riskRatio = 1 / healthFactor`
  - **Jupiter Lend (Solana)**: `riskRatio = borrowedValue / (suppliedValue × liquidationThreshold)`（Portfolio API 给 USD 值，vaults API 给 liquidationThreshold）
- **空账户处理**：分母为 0 时返回 `undefined`，不返回 NaN/0/Infinity。
- **不做 upper cap**：当 `riskRatio > 1` 表示「已可被清算」，让策略自己识别。
- **单位**：BigNumber 小数（`0.5` 表示 50%），与其他字段一致。
- 原始指标（`marginLevel` / `healthFactor` / `ltv`）保留在 `lending` facet 内，供需要原生数值的策略直读。
- Juplend MVP 的 `RiskSnapshot` 按账户聚合：用钱包总 `borrowedValue / (suppliedValue × liquidationThreshold)` 输出单个账户级 `riskRatio`，不产出 per-position risk。

## Decision (ADR-lite)

### ADR-1：BalanceSnapshot 用「基础字段 + `lending` facet」嵌套模式

**Context**：DEX 借贷账户引入 `borrowed/interest/supplied` 等概念，与 CEX trading 的 `free/used/total` 同时存在；未来 CEX margin/loan 也会有同样需求。

**Decision**：保留 `free/used/total` 平铺；借贷专属字段全部归到可选嵌套子结构 `lending: LendingBalanceFacet`。

**Consequences**：
- ✅ 类型守卫 `if (b.lending)` narrow 后强类型访问 lending 字段
- ✅ 可推广到未来其他 facet（`derivatives?` / `staking?` 等）
- ✅ 同一资产同时是抵押品 + 负债时不互相覆盖
- ❌ 比平铺多一层嵌套（可接受）

**Rejected**：平铺可选字段（类型不严）；判别联合（破坏面大）；完全分离 manager（违背统一抽象初衷）。

### ADR-2：风控字段统一为教科书 `riskRatio`，越小越安全，清算阈值 = 1.0

**Context**：CEX 各家原生指标方向不一致（Binance margin level、PAPI uniMMR、OKX mgnRatio 越大越安全；USDT-M futures marginRatio 越小越安全）；DEX healthFactor 越大越安全。当前仓库 `RiskSnapshot.marginRatio` 字段名误导（实际存 uniMMR）。

**Decision**：
1. 重命名 `marginRatio` → `riskRatio`（无用户，breaking rename 无成本）
2. 全部 adapter 强制按教科书 `MM/Equity` 方向输出，DEX 走 `1/healthFactor`，Jupiter Lend 走 `borrowedValue / (suppliedValue × liquidationThreshold)`
3. 原始字段（`healthFactor` / `marginLevel` / `ltv`）保留在 `lending` facet 内供直读

**Consequences**：
- ✅ 统一阈值 = 1.0，跨 CEX/DEX 排序、设阈值、报警语义一致
- ✅ 字段名「riskRatio」中性，DEX 借贷场景不再违和
- ❌ 4 家 CEX 中 3 家 adapter 需要做倒数转换；spec 必须显式登记每家转换公式

### ADR-3：借助 Jupiter Portfolio API 查询借贷仓位，不直读链上数据

**Context**：调研（`research/jupiter-lend-overview.md`）最初推荐 `@jup-ag/lend-read` SDK + NFT 枚举反查 (vaultId, positionId)，引入 ~2MB Solana 依赖栈，工作量 5-7 天。但 Jupiter 官方 Portfolio API 已聚合钱包级别借贷仓位，直接返回 `suppliedValue / borrowedValue / netValue`，不需要 NFT 枚举、不需要 Anchor、不需要 Solana SDK。

**Decision**：
- 仓位查询走 `GET https://api.jup.ag/portfolio/v1/positions/{walletAddress}?platforms=jupiter-exchange`
- 响应中 `elements[].data.link` 形如 `https://jup.ag/lend/borrow/{vaultId}/nfts/{nftId}` → 正则抽取 `(vaultId, nftId)`，不硬编码 vault 表
- `liquidationThreshold` 从免 key 端点 `GET lite-api.jup.ag/lend/v1/borrow/vaults` 取，vault 配置静态可长期缓存（TTL ≥ 1h）
- `riskRatio = borrowedValue / (suppliedValue × liquidationThreshold)`，与 ADR-2 对齐
- API key 通过 `RegisterAccountInput.credentials.apiKey` 传入

**Consequences**：
- ✅ 零 Solana SDK 依赖（省 2 MB 包体积）
- ✅ 工作量从 5-7 天降到 2-3 天
- ✅ 只靠 HTTP fetch，Bun 原生支持
- ✅ 一次 API 调用拿到钱包所有借贷仓位
- ❌ 依赖 Jupiter 保持 Portfolio API 稳定（jup.ag UI 自己也在用，下线风险低）
- ❌ Portfolio API 只给 USD 聚合值，不给 asset-level token 数量（见 ADR-4）
- ❌ Portfolio API 需要 key；lite-api 免 key 但不含 Portfolio 端点

### ADR-4：MVP 数据粒度 = Portfolio API（USD 聚合）+ `/borrow/vaults`（静态资产映射），余额按 asset 聚合

**Context**：Portfolio API 只给 position 级 USD 聚合（`suppliedValue / borrowedValue / value`），不给 asset-level token 数量。策略有 asset 维度聚合需求（"我总共借了多少 USDC"），但不需要链上精确 token 数（< 0.1% 反算误差可接受）。

**Decision**：
- **动态数据**来源：`api.jup.ag/portfolio/v1/positions/{address}`（每次刷新调）
- **静态元数据**来源：`lite-api.jup.ag/lend/v1/borrow/vaults`（缓存 TTL ≥ 1h），提供：
  - vault 的 `supplyToken` / `borrowToken`（asset 身份）
  - vault 的 `liquidationThreshold`（算 riskRatio 必需）
  - vault 的 `oraclePrice`（反算 token 数量用）
- 两者通过 `data.link` 的 `(vaultId, nftId)` 关联
- 每个 NFT position 先转换为抵押资产与借款资产两类中间行，再按 `asset` 聚合为账户级 `BalanceSnapshot[]`：
  - 抵押资产累加：`lending.supplied += suppliedValue / oraclePrice`
  - 借款资产累加：`lending.borrowed += borrowedValue / borrowOraclePrice`
  - `lending.netAsset = supplied - borrowed`，`total` 对齐 `netAsset`；`free / used` 在 Juplend MVP 中填 `0`
- `RiskSnapshot` 按账户聚合产出单个对象：`riskRatio = totalBorrowedValue / Σ(suppliedValue × liquidationThreshold)`；空账户或分母为 0 时为 `undefined`
- 不引入任何 Solana SDK 依赖

**Consequences**：
- ✅ 0 Solana 依赖，工作量 2-3 天
- ✅ 策略能按 asset 聚合跨账户净头寸
- ✅ 兼容当前 `AccountSnapshot.balances: Record<asset, BalanceSnapshot>` 与单个 `risk?: RiskSnapshot` 存储模型
- ✅ vault 配置缓存降低 API 调用频次
- ❌ token 数量是 USD 反算值（精度受 oracle 价影响，误差 < 0.1%）；`BalanceSnapshot` 可能加 `amountSource: "exact" | "derived"` 字段显式标注（spec 阶段决定）
- ❌ per-position 明细不在 MVP `AccountSnapshot` 里暴露；未来如策略需要，可新增 `LendingPositionFacet[]` 而不是改第一版 manager 存储结构

### ADR-5：重命名 `Exchange → Venue`，语义扩宽覆盖 CEX + DEX

**Context**：当前 `Venue = "binance" | "okx" | "bybit" | "gate"` 在类型名与字面量上都是 CEX 语义。DEX 借贷（Jupiter Lend）塞进来会造成抽象泄漏。SDK 无用户，重命名成本为零。

**Decision**：
- 类型重命名：`Venue` → `Venue`
- 扩展枚举：`Venue = "binance" | "okx" | "bybit" | "gate" | "juplend"`
- 所有字段 `venue: Venue` → `venue: Venue`（全局 rename，~15 文件）
- `SUPPORTED_EXCHANGES` → `SUPPORTED_VENUES`
- 错误码 / 日志字段同步改 `venue` key → `venue` key
- `RegisterAccountInput` 改成按 `venue` 区分的 discriminated union：CEX options 保留 `timestamp / recvWindow`，Juplend 强制 `credentials.apiKey` 与 `options.walletAddress`，可选 `options.positionId`
- 内部常量命名保持 `BINANCE_*` / `JUPLEND_*` 等（不涉及类型）

**Consequences**：
- ✅ 类型名准确描述跨 CEX/DEX 本质
- ✅ 未来接 DEX perp、链上 MM、其他借贷协议均不需要再改抽象
- ✅ 一次性改完，不留"venue/venue 并存"的语义债
- ❌ 与 CCXT 社区惯例（统一叫 venue）有分歧——接受
- ❌ 改动面广：`src/types/**` / `client/**` / `managers/**` / `adapters/**` / `tests/**` 全量跟进

### ADR-6：Jupiter Lend venue 字面量定为 `"juplend"`

**Context**：新 venue 需要简短字面量。候选：`"jupiter-lend"` / `"jup-lend"` / `"juplend"` / `"jup"`。

**Decision**：`"juplend"` — 与其他 venue（`"binance"` 等）一致的 no-dash 小写单词风格；比 `"jupiter-lend"` 短；与用户 demo 代码中 `JuplendLoan` 类名呼应。

### ADR-7：Juplend `accountId` 使用用户自定义账户名，钱包地址放 `options.walletAddress`

**Context**：CEX 的 `accountId` 是用户自起 string。Juplend 虽然底层查询身份是 Solana 钱包地址，但策略侧需要把同一个钱包地址下的不同 position / 用途拆成多个逻辑账户。

**Decision**：`registerAccount({ accountId: <customName>, venue: "juplend", credentials: { apiKey }, options: { walletAddress, positionId? } })`；`accountId` 只作为 SDK 内部账户 key 与事件过滤 key，Juplend adapter 查询 Portfolio API 时使用 `options.walletAddress`。若提供 `positionId`，只纳入 `data.link` 中 `/nfts/{positionId}` 匹配的仓位。

**Consequences**：
- ✅ 同一 Solana 钱包地址可注册成多个逻辑账户，满足策略按 position / 用途分账
- ✅ 可用 `positionId` 把同一钱包下的单个 Juplend position 映射为独立账户视图
- ✅ 与 CEX 的自定义 `accountId` 语义保持一致
- ❌ 注册 Juplend 账户时必须额外提供 `options.walletAddress`，缺失时报 bootstrap 错误

### ADR-8：默认轮询间隔 30s，可通过 `AccountRuntimeOptions` 覆盖

**Context**：Portfolio API 限速 300/min，MVP 没有 WebSocket 订阅，风控值要及时反馈给策略。

**Decision**：
- 默认每账户轮询 30 秒（每账户 2 次/分钟；300/min 配额可支持 150 个账户并发）
- 新增 `AccountRuntimeOptions.juplend.pollIntervalMs` 供 Juplend 账户调优
- vault 静态元数据缓存独立：TTL 1h，失败时沿用上一份
- 轮询失败 → `PrivateRuntimeStatus = "degraded"`，`reason = "http_failed"`（新枚举值）

**Consequences**：
- ✅ 风控用途响应够快，API 配额充裕
- ✅ 与 CEX push 模型在事件接口上统一（内部翻译成 `BalanceUpdatedEvent` / `RiskUpdatedEvent`）
- ❌ 相比 push 有天然 15s 平均延迟；已在 `status` 字段 `lastReceivedAt` 透明
- ❌ 需要扩 `PrivateRuntimeReason` 新增 `http_failed` / `rate_limited`

## Acceptance Criteria

- [ ] `Venue` 全局重命名为 `Venue`，`SUPPORTED_VENUES` 增加 `"juplend"`；所有字段 `venue` → `venue` 迁移完毕
- [ ] `RegisterAccountInput` 按 `venue` 显式区分初始化参数；Juplend 在 TS 层强制 `credentials.apiKey` 与 `options.walletAddress`
- [ ] `RiskSnapshot.marginRatio` 重命名为 `riskRatio`；Binance PAPI adapter 的 `uniMMR → 1/uniMMR` 转换正确
- [ ] `BalanceSnapshot.lending` facet 类型守卫正确：trading 账户 balance 无 `lending`，juplend 账户 balance 可 narrow 到 `LendingBalanceFacet`
- [ ] `RiskSnapshot.lending` facet 同上，暴露 `healthFactor / ltv / liquidationThreshold / totalCollateralUSD / totalDebtUSD`
- [ ] juplend adapter happy path：给定有借贷仓位的 wallet，返回按 asset 聚合后的 `BalanceSnapshot[]` + 单个账户级 `RiskSnapshot`
- [ ] juplend adapter 无仓位场景：返回空 balances + `riskRatio = undefined`，不报错
- [ ] juplend adapter API key 缺失：bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，错误信息提示 `credentials.apiKey required`
- [ ] juplend adapter `options.walletAddress` 缺失：bootstrap 抛 `ACCOUNT_BOOTSTRAP_FAILED`，错误信息提示 `options.walletAddress required`
- [ ] juplend adapter `options.positionId` 存在时只聚合对应 NFT position；不存在时聚合钱包全部 Juplend positions
- [ ] juplend adapter HTTP 失败：进入 `PrivateRuntimeStatus = "degraded"`，`reason = "http_failed"`；沿用上一份 vault 配置缓存
- [ ] vault 元数据缓存：TTL 1h；并发注册多个 juplend 账户时 `/borrow/vaults` 只调一次
- [ ] 轮询间隔：默认 30s；通过 `AccountRuntimeOptions.juplend.pollIntervalMs` 可覆盖
- [ ] `riskRatio` 公式：`borrowedValue / (suppliedValue × liquidationThreshold)`；`liquidationThreshold` 用整数 850 → 0.85
- [ ] 单元测试：Portfolio API 响应解析、`data.link` 正则抽取 `(vaultId, nftId)`、vault 缓存失效、空账户、错误码映射
- [ ] 集成测试：fake fetch 驱动完整 bootstrap → update → unsubscribe，断言事件序列与 status 迁移
- [ ] 现有 CEX 测试零红：`bun run test` 全绿（`Exchange → Venue` 全局替换后）
- [ ] 新增 spec 文档：`.trellis/spec/backend/venue-lending.md`，登记 riskRatio 转换公式、facet 字段契约、polling adapter 语义

## Definition of Done

- 单元 + 集成测试覆盖 DEX adapter 的 happy path 与 HTTP/API 失败 / 数据缺失 fallback
- `bun run lint` / `bun run type-check` / `bun run test` 全绿
- 新增 spec 文档：DEX adapter contract（区别于 CEX adapter，定义 polling / read-only / 链上数据语义）
- README / 类型导出更新；策略侧示例代码（如何同时拿 CEX + DEX 风控值）

## Out of Scope (explicit)

- ❌ DEX 写操作（supply / withdraw / borrow / repay / 抵押切换）
- ❌ DEX perp（GMX / Hyperliquid / dYdX）—— 那是另一种产品形态
- ❌ DEX 现货（Uniswap）—— 不是借贷
- ❌ 私钥管理 / 签名 / gas 估算
- ❌ 多签 / Account Abstraction (4337) 钱包
- ❌ 链上事件订阅（WebSocket subscribe）—— MVP 用轮询
- ❌ 跨协议聚合策略（用户自己组合）

## Technical Notes

代码现状参考：

- `src/types/shared.ts` — `Venue` 枚举 / `RegisterAccountInput`
- `src/types/account.ts` — `BalanceSnapshot` / `PositionSnapshot` / `RiskSnapshot` / `AccountManager`
- `src/adapters/types.ts:189-220` — `PrivateUserDataAdapter` 接口（push 模型）
- `src/managers/account-manager.ts` — Manager 状态机（针对 push 模型设计）
- `.trellis/spec/backend/adapter-contract.md` — 现有 adapter 契约（StreamHandle / WS / listenKey 等都是 CEX 假设）

外部参考（已由 research 收敛）：

- Jupiter Portfolio API positions endpoint
- Jupiter Lend lite-api `/borrow/vaults` 元数据 endpoint
- Solana 借贷协议数据模型对比（Jupiter Lend / Kamino / MarginFi / Solend）

## Research References

- [`research/jupiter-lend-overview.md`](research/jupiter-lend-overview.md) — Jupiter Lend 是自营协议（疑似 Fluid Solana 移植）；TVL ~$908M；Portfolio API 是最轻量只读路径
- [`research/solana-lending-ecosystem.md`](research/solana-lending-ecosystem.md) — Jupiter Lend / Kamino / MarginFi / Solend 数据模型能被 `LendingBalanceFacet + LendingRiskFacet` 干净覆盖，首发不锁死抽象

## Implementation Plan (suggested small PRs)

- **PR1**: `Exchange → Venue` 全局重命名 + `marginRatio → riskRatio` + Binance adapter 公式更正（纯 refactor，不加功能）
- **PR2**: 引入 `LendingBalanceFacet` + `LendingRiskFacet` types；OrderManager / AccountManager 签名不变（facet 只是新字段）
- **PR3**: 新增 `src/adapters/juplend/` adapter（Portfolio API client + vaults 缓存 + 轮询引擎）+ 对应 adapter 契约 spec
- **PR4**: runtime 编排层支持 juplend 注册路径、`AccountRuntimeOptions.juplend` 选项、`PrivateRuntimeReason` 新增 `http_failed`
- **PR5**: 集成测试 + live smoke 脚本 + 示例代码 + README 更新
