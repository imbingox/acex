# 公共数值契约：对外 BigNumber 改 string（发布前 P0）

## Goal

将对外公共类型的数值字段由 `bignumber.js` 的 `BigNumber` 改为 **canonical 十进制 string**，与已是 string 的输入侧（`CreateOrderInput`/`NormalizedOrderInput`）对齐，形成对称契约。破坏性公共 API 改动，趁 beta（1.0 未锁契约）做最便宜。详见 `docs/multi-venue-roadmap.md` §6。

## What I already know

### 现状（已核实，基线含本次探查）

- `src/index.ts:1` 直接 `export { BigNumber } from "bignumber.js"` —— 第三方类进入公共类型面。
- **输入已是 string**：`CreateOrderInput.{amount,price}`(`order.ts:60,68`)、`NormalizedOrderInput` 全 string(`market.ts:69-81`)。输入类型 `DecimalInput = string | number | BigNumber`(`market.ts:56`)——纯输入侧，**不动**。
- **输出全 BigNumber**，完整面 = 9 个类型（探查补全，比 roadmap §6.1 多出 `MarketDefinition`）：
  1. `MarketDefinition`(`market.ts:18-24`)：contractSize?/priceStep/amountStep/minAmount?/minNotional? ← **roadmap §6 未列**
  2. `L1Book`(`market.ts:95-98`)：bidPrice/bidSize/askPrice/askSize
  3. `FundingRateSnapshot`(`market.ts:109-112`)：fundingRate/markPrice?/indexPrice?
  4. `OrderSnapshot`(`order.ts:105-112`)：price?/triggerPrice?/amount/filled/remaining?/avgFillPrice?
  5. `BalanceSnapshot`(`account.ts:55-57`)：free/used/total
  6. `LendingBalanceFacet`(`account.ts:66-71`)：supplied/borrowed/interest/netAsset/supplyAPY?/borrowAPY?
  7. `PositionSnapshot`(`account.ts:79-84`)：size/entryPrice?/markPrice?/unrealizedPnl?/leverage?/liquidationPrice?
  8. `RiskSnapshot`(`account.ts:94-99`)：netEquity?/riskEquity?/riskRatio?/riskLeverage?/initialMargin?/maintenanceMargin?
  9. `LendingRiskFacet`(`account.ts:108-113`)：marginLevel?/healthFactor?/ltv?/liquidationThreshold?/totalCollateralUSD?/totalDebtUSD?

### 转换机制（实现锚点）

- adapter 已吐 string（`Raw*` in `adapters/types.ts`）；manager builder 用 `new BigNumber(input.x)` 包一层。
- 已有 canonical helper：`normalizeDecimalInput`(`market-manager.ts:104`) = `value.isFinite() ? value.toFixed() : value.toString()`；`normalizeOrderInput` 出口已 `.toFixed()`(`market-manager.ts:275-278`)。
- 三处出口 builder：
  - market：`createL1Book`(`market-manager.ts:768-`)、`createFundingRate`(`:800-`)
  - account：`getBigNumber`(`account-manager.ts:52`) + `createBalance`(`:496`)/`createPosition`(`:544`)/`createRisk`(`:583`)
  - order：`createSnapshot` builder(`order-manager.ts:526`，非 `createOrder(:142)` 下单命令)
- **内部消费快照数值的点**（codex 评审补全，原写"position/risk 纯 carry-forward"不准确）：① `createBalance` 的 `total.minus(free)`、`previousFree.plus(previousUsed)`(`account-manager.ts:502-512`)；② **`PositionSnapshot.size` 判零**——`account-manager.ts:325` `nextPosition.size.isZero()`、`:464` bootstrap `.filter(p => !p.size.isZero())`；risk 才是纯 carry-forward。→ 快照存 string，这些点局部 `new BigNumber()` 运算/判零后再用。

## Assumptions (temporary)

- 内部运算（`floorToStep`、风控除法等）保持 BigNumber，仅在 manager 出口 stringify。（roadmap §6.3 已定）
- optional BigNumber 字段 → optional string：缺失保持 `undefined`，不写空串。
- canonical 格式统一用 `.toFixed()`（无参，全精度、无科学计数、无尾零填充），不修改全局 `BigNumber` 配置。
- 作为独立 PR，不与 venue 改造混提。（roadmap §6.4 已定）

## Open Questions

- （无）所有问题已收敛。

### Resolved

- **Q5（MVP 范围）→ ①②③ 全要（含两点细化）**：
  - ① 转换 9 输出类型 + 边界单测 + 同步 docs（最小可行，必做）。
  - ② **共享 `toCanonical` 模块**（新建 `src/internal/decimal.ts`）：落点经 `code-organization.md` 验证（`src/internal/*` = 领域无关原语，已有 async-event-bus/filters 等同类，且该文件尚不存在）。收益不止 DRY——**把 NaN/Infinity 兜底（`isFinite()?toFixed():toString()`）从 4+ 转换点（3 manager 出口 + binance catalog）收敛到一处，是正确性保证**。
    - **细化(签名)**：`toCanonical(value: DecimalInput): string`（吃 `string|number|BigNumber`），内部 `new BigNumber(value)` 再 isFinite/toFixed。binance catalog 的原始交易所串也走同一路 re-parse → 坐实 Q3「不透传 adapter 原始串」；3 个 manager 出口喂 BigNumber。一个 helper 通吃两类调用方。
  - ③ **公共面契约回归守卫**，重塑为两件互补的事（不做运行期反射式遍历——optional 字段/嵌套 facet/TS 类型成员运行期枚举不出，脆）：
    - (a) **静态守卫测试**：**不能裸 `grep BigNumber`**（codex2：别名 `import type Decimal from "bignumber.js"` 可绕过）——须解析 `from "bignumber.js"` 的 type import/引用，仅放行 `market.ts` 的 `DecimalInput`，`src/index.ts` re-export 单独断言。挡住「step 5 新所又引入 BigNumber 输出字段」。
    - (b) **格式边界断言并入 ①**（`1e-7`/`1e21`/负数/零/超长小数），不另立集中测试，避免与边界用例重叠。

- **Q4（发布 bump 级别）→ `minor`**：仓库现为 `0.3.0` beta pre 模式（`pre.json.initialVersions=0.3.0`），立项前提是"1.0 未锁契约趁早改"。Changesets 按字面应用 bump，打 `major` 会 `0.3.0 → 1.0.0-beta.x` 提前锁死 1.0，与立项理由冲突；故破坏性变更在 0.x 阶段走 **`minor`**（`0.3.0 → 0.4.0-beta.x`，符合 pre-1.0 semver 惯例）。
  - ⚠️ 这偏离 `release-publishing` spec bump 矩阵字面（"破坏性 → major"，隐含 post-1.0）→ **同 PR 内补 spec 0.x carve-out**（"pre-1.0 破坏性用 minor，major 留给 1.0 里程碑"），已入 Requirements/AC，Phase 3.3 落地。
- **Q（迁移说明 / CHANGELOG 机制）→ derivable**（依 `release-publishing` spec §3.7 + bump 矩阵）：
  1. `CHANGELOG.md` 由 release workflow 的 `changeset version` **自动生成**——不手写、不单独建迁移文档。
  2. 本 PR **必须**新增一个 `.changeset/*.md`（kebab-case，放 `.changeset/` 根）；bump=`minor`；summary 用中文写用户可见的破坏性变化 + 消费者迁移姿势（`new BigNumber(field)` 自取，勿 `parseFloat`）。
  3. README / `docs/api.md` 数值字段示例同步更新（已在 DoD）。
- **Q1（范围）→ A**：`MarketDefinition` 的 5 个 BigNumber 字段（contractSize?/priceStep/amountStep/minAmount?/minNotional?）**一并改 string**。公共**输出面** BigNumber 彻底清零、对称化（input string↔output string；`DecimalInput` 的 BigNumber 是有意保留的宽进，见 Technical Notes「宽进严出」），并让 Q2（是否保留 re-export）回归纯工具取舍。`floorToStep` 等对 step 的内部运算在读取处 `new BigNumber()` re-parse（`definitions` Map 已缓存，转换一次）。
- **Q2（契约）→ A**：**保留** `export { BigNumber }` re-export 作可选工具。输出 string 化后，原"全局配置改写返回对象"的运行期 footgun 已消除；保留它给消费者一条正确、版本一致、零额外依赖的解析路径（`new BigNumber(field)`），对冲 `parseFloat` 精度退步风险。文档写明推荐姿势。
- **Q3（格式）→ 采纳全套**：canonical string 定义为「无损、无科学计数、无尾零填充的十进制串」。
  1. 出口经 `new BigNumber(raw).toFixed()` 解析后再吐（统一格式，不透传 adapter 原始串）。
  2. `.toFixed()` 无参 → 无科学计数（`1e-7`→`"0.0000001"`，`1e21`→`"1000…0"`）。
  3. 不补尾零（`0.5`→`"0.5"`）——`fundingRate/riskRatio/unrealizedPnl/healthFactor` 等无 precision 锚点字段也只能如此。
  4. 不修改全局 `BigNumber` 配置；纯 per-call `.toFixed()`。
  5. 非有限值（计算得到的 Infinity/NaN，如除零；或 `Infinity`/`NaN`/`"NaN"` 入参）→ `toCanonical` **抛 `RangeError`**（不再 `toString()` 兜底——杜绝 sentinel 串漏进公共字段；PR #34 review 收紧）。注：bignumber 默认对不可解析串（如 `"abc"`）在**构造处**即抛。`normalizeOrderInput` 例外：对可构造的非有限入参（`"NaN"`/`Infinity`）仍优雅拒绝（`price_not_positive`/`amount_not_positive`），其 echo 字段用局部 finite-guard 回退原串、不抛。
  → 可复用/提升 `normalizeDecimalInput` 为共享 `toCanonical` helper。

## Requirements (evolving)

- 全部 9 个输出类型（含 `MarketDefinition`）的 BigNumber 字段改为 canonical 十进制 string。
- 输入侧 `DecimalInput` / `CreateOrderInput` / `NormalizedOrderInput` 不变。
- 内部运算不变；仅出口 stringify。`floorToStep` 等对 `MarketDefinition.priceStep/amountStep` 的内部用法在读取处 re-parse。
- canonical 格式杜绝 `1e-7` 科学计数。
- **新建共享 `src/internal/decimal.ts`，导出 `toCanonical(value: DecimalInput): string`**；3 个 manager 出口 + binance catalog 全部改用它产出 canonical string；提升/替换 `market-manager.ts` 现有的 `normalizeDecimalInput`。
- **新增静态守卫测试**：断言 `src/types/**` 中除 `DecimalInput`（+ `index.ts` re-export）外无 `BigNumber` 引用，防 step 5 回归。
- **实现面含非 src 的 type-check/test 文件**（`tsc` 扫全仓，codex 两轮补全）：**`tests/integration/**`（~131 处断言，最大改面）**、`scripts/live-*.ts`、`tests/soak/*`、`tests/support/exchanges/okx.ts`（fake 所，构造 `MarketDefinition`）随类型同步改为 string 断言/产出。
- **`account-manager` position 判零两处**（`:325`/`:464`）随 `size` 改 string 而 re-parse（见 Technical Notes 内部 re-parse 点）。
- **同 PR 更新 `release-publishing` spec**：给 bump 矩阵补 0.x carve-out（pre-1.0 破坏性用 minor，major 留 1.0），消除与现行 spec 字面冲突。

## Acceptance Criteria (evolving)

- [ ] 选定范围内所有输出类型字段为 string；`grep BigNumber src/types` 仅剩输入侧 `DecimalInput`（+ `index.ts` re-export）。
- [ ] 输出 string 均为 canonical 格式（无科学计数）；新增/更新单测覆盖极小/极大值（`1e-7`、`1e21`）、负数、零、超长小数。
- [ ] `src/internal/decimal.ts` 导出 `toCanonical(value: DecimalInput): string`；3 manager 出口 + binance catalog 均改用它；旧 `normalizeDecimalInput` 已被替换/复用，无重复 stringify 逻辑。
- [ ] 静态守卫测试存在并通过：解析 `src/types/**` 对 `bignumber.js` 的 type import/引用（**含别名**），仅放行 `market.ts` 的 `DecimalInput`，`src/index.ts` re-export 单独断言；能在出现非法（含别名）BigNumber 输出字段时失败。
- [ ] `tests/integration/**`（account/market/order/client-lifecycle，~131 处）、`scripts/live-*.ts`、`tests/soak/*`、`tests/support/exchanges/okx.ts` 全部改为 string 断言/产出，`type-check` + `test` 全绿。
- [ ] `account-manager` 的 position 判零（`:325`/`:464`）改为 `new BigNumber(size).isZero()` 或等价，无运行期 string 调用 `.isZero()`。
- [ ] 同 PR 更新 `release-publishing` spec 的 bump 矩阵（0.x carve-out）。
- [ ] 新增 `.changeset/*.md`（bump=`minor`），summary 描述破坏性变化 + 消费者迁移姿势。
- [ ] `lint` / `type-check` / `test` 全绿。
- [ ] `README` / `docs/api.md` 示例与类型同步更新（现含 54 处 BigNumber 引用）。

## Definition of Done (team quality bar)

- 单测断言全部由 BigNumber 改为 string 比较；新增 canonical 格式边界用例。
- Lint / type-check / test 绿。
- `docs/api.md`、`README` 数值字段示例更新；破坏性变更在发布说明/CHANGELOG 标注（依 `release-publishing` spec）。
- 迁移指引：文档给出消费者推荐姿势（`new BigNumber(field)` 自取，勿 `parseFloat`），并**显式标注破坏**：`snapshot.bidPrice.minus(...)` / `.multipliedBy(...)` 等链式调用在 string 上会运行期抛错（`docs/api.md:193` 现有 `askPrice.minus(bidPrice)` 示例必须改）。

## Out of Scope (explicit)

- 共享 REST/限流/时钟（roadmap step 3）、capability 化与硬编码清理（step 4）、接第一个新所（step 5）。
- 输入侧数值表示改动。
- 内部计算逻辑/精度算法改动。
- 「消费者可选拿 BigNumber」的泛型返回模式——YAGNI，`export { BigNumber }` re-export 已覆盖（消费者 `new BigNumber(field)` 自取）。

## Technical Notes

- 文件锚点见上「转换机制」。
- **完整转换点地图**（探查确认，含 Q1=A 带来的 adapter 侧扩展）：
  1. **类型定义**：`market.ts`(MarketDefinition 5 + L1Book 4 + FundingRateSnapshot 3)、`order.ts`(OrderSnapshot 6)、`account.ts`(Balance 3 + LendingBalanceFacet 6 + Position 6 + Risk 6 + LendingRiskFacet 6)。
  2. **adapter catalog 产出 MarketDefinition**（Q1=A 新增面）：`MarketAdapter.loadMarkets()` 直接返回 `MarketDefinition[]`，非 Raw；**仅 binance 一个 adapter 实现**（`adapter.ts:56` → `market-catalog.ts` 的 `normalizeSpotSymbol`/`normalizeDerivativesSymbol`，去掉 `new BigNumber()`、改 `toCanonical(string)`）。`BinanceMarketDefinition extends MarketDefinition` 自动跟随。juplend 无 catalog。
  3. **3 个 manager snapshot builder**：market(`createL1Book`/`createFundingRate`)、account(`createBalance`/`createPosition`/`createRisk` + `getBigNumber`)、order(`createSnapshot`，`order-manager.ts:526`，覆盖 create/cancel/cancelAll；注意 `createOrder(:142)` 是下单命令、非 builder)。
  4. **内部 re-parse 点**：
     - `market-manager.normalizeOrderInput`(`:263-308`)：`floorToStep`/`isLessThan` 需把 `market.{priceStep,amountStep,minAmount,minNotional}` re-parse 回 BigNumber；出口 275-278 行原 `.toFixed()` 改为直接透传 string（简化）。
     - `account-manager.createBalance`(`:502-512`)：`total.minus(free)`、`previousFree.plus(previousUsed)` 局部用 BigNumber 运算后 stringify。
     - 🔴 `account-manager` **position 判零**（codex 抓出的遗漏，原 PRD 漏列）：`:325` `nextPosition.size.isZero()`（归零删仓）、`:464` `.filter(p => !p.size.isZero())`（bootstrap 过滤空仓）。**判零发生在 caller、不在 `createPosition` 内**（codex2 收紧）→ 修法：caller `new BigNumber(snapshot.size).isZero()`，或让 builder 额外回传 parsed size / zero flag（仅局部留 `sizeBigNumber` 不够，caller 拿不到）。risk 为纯 carry-forward（string 直传）。
  5. **type-check + test 面 = 全仓**（codex 两轮抓出）：`tsconfig.json` 无 `include`/`exclude`，`tsc --noEmit` 扫 `scripts/`+`tests/`。改完类型这些必须同步，否则 type-check/test 红：
     - 🔴 **`tests/integration/**`：最大改面**——`account.test.ts` 92 处、`market.test.ts` 21、`order.test.ts` 14、`client-lifecycle.test.ts` 4（共 ~131）BigNumber 断言/期望，全部改 string 比较。
     - `scripts/live-{market,account,order,juplend-account}-smoke.ts`：在 snapshot 字段上调 `.toFixed()`/`.minus()` 等。
     - `tests/soak/*`（如 `market-l1-continuity.test.ts`）：同上。
     - **测试假所** `tests/support/exchanges/okx.ts:146-188`：用 `new BigNumber()` 构造 `MarketDefinition` 并实现 `loadMarkets` ——是 binance catalog 之外的**第二处 MarketDefinition 构造点**，`new BigNumber()` 改 `toCanonical(string)`。
- 实现策略（derivable）：snapshot/MarketDefinition 类型直接改 string；各出口以共享 `toCanonical(value: DecimalInput): string` 产出（新建 `src/internal/decimal.ts`，提升/替换 `normalizeDecimalInput`）。`toCanonical` 内部 `new BigNumber(value)` 后 `isFinite()?toFixed():toString()`，**兜底逻辑只此一份**。binance catalog 原始串与 manager BigNumber 值都走这一路。**caveat（codex）**：`toCanonical` 虽吃 `number`，但 `number` 入参本身有 JS 浮点精度损失——docs 不宣传为"无损来源"，无损路径是 string/BigNumber。adapter 内部签名/计算用的 BigNumber（binance/juplend private-adapter）**不动**——它们本就吐 Raw string。
- **契约形状 = 宽进严出（Postel）**：input 经 `DecimalInput` 仍收 `string|number|BigNumber`（`normalizeOrderInput` 用，`market.ts:65-66`），output 一律 canonical string。**故意保留 `BigNumber` 于 `DecimalInput`**——静态守卫(③a)白名单据此放行；`export { BigNumber }`(Q2) 双向有用：喂入 `normalizeOrderInput` + 解析 string 输出。Goal 里"对称契约"指 `CreateOrderInput`/`NormalizedOrderInput` 的 string↔string 链，不含收紧 `DecimalInput`。
- 回归守卫（③a，derivable）：静态测试解析 `src/types/**` 对 `bignumber.js` 的 type import/类型引用（**匹配 `from "bignumber.js"`、含别名**，非裸 `grep BigNumber`——codex2），仅放行 `market.ts` 的 `DecimalInput`；`src/index.ts` re-export 单独精确断言，不混进 `src/types/**` 扫描。**不做运行期字段反射**（optional/嵌套 facet/TS 类型成员运行期枚举不出，脆）。格式断言（③b）并入各出口边界单测。
- 风险低、机械化，但 diff 大且横切（类型定义 + binance catalog + 三 manager 出口 + position 判零 + scripts/soak/test-fake + `tests/integration` ~131 断言 + docs）。**文档残留分布**（codex 两轮抽查）：`docs/api.md` 54 处（须改，含 `:193` 教用户 `askPrice.minus(bidPrice)` 的反例）、README **6 处 `.toFixed()` 示例（`:33/47/54/116/119/120`）+ `:144` 一句"输出字段统一是 BigNumber"的契约描述须重写**、architecture 2 处 + roadmap 11 处（roadmap 是路线图叙述、architecture 视情况——二者是否改在实现时定）。
- 关联路线图：`docs/multi-venue-roadmap.md` §6；硬截止 = step 5「接第一个新所」之前。

## Research References

- 待 brainstorm 收敛后视需要补充（本任务多为已知契约决策，研究需求低）。
