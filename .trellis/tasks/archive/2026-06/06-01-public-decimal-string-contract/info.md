# 实现执行计划（codex 执行，Claude 审核）

> 本文是 `prd.md` 的**执行排序**，不重复 PRD 的决策依据。codex 实现时 prd.md 为准、本文为序。
> 分工：**codex 写代码**，**Claude 审核规划 + 阶段间 review**。
> 分三阶段交付，**阶段间 Claude review 后再放行下一阶段**。

## 必读 spec（实现前）
- `.trellis/spec/backend/code-organization.md`（toCanonical 落 `src/internal/decimal.ts`；层边界）
- `.trellis/spec/backend/type-safety.md`（显式返回类型、避免宽化）
- `.trellis/spec/backend/adapter-contract.md`（loadMarkets 契约、交易所类型不外泄）
- `.trellis/spec/backend/release-publishing.md`（changeset / bump / 0.x carve-out）
- `.trellis/spec/backend/venue-lending.md`（lending facet 可选字段语义）

---

## Phase A — 核心 src 改动（产出后 `src/` 应 type-check 干净；tests/scripts 预期红）

A0. **新建 `src/internal/decimal.ts`**：`export function toCanonical(value: DecimalInput): string`，实现 = `const bn = new BigNumber(value); return bn.isFinite() ? bn.toFixed() : bn.toString();`。**兜底逻辑全仓唯一一份**。`DecimalInput` 从 `src/types` 导入。

A1. **类型定义改 string**（BigNumber→string，optional 仍 optional）：
- `src/types/market.ts`：`MarketDefinition`(contractSize?/priceStep/amountStep/minAmount?/minNotional?)、`L1Book`(bidPrice/bidSize/askPrice/askSize)、`FundingRateSnapshot`(fundingRate/markPrice?/indexPrice?)。**保留 `DecimalInput`（含 BigNumber）与文件顶 `import type BigNumber`（DecimalInput 仍用）。**
- `src/types/order.ts`：`OrderSnapshot`(price?/triggerPrice?/amount/filled/remaining?/avgFillPrice?)。移除不再需要的 `import type BigNumber`。
- `src/types/account.ts`：Balance(3)/LendingBalanceFacet(6)/Position(6)/Risk(6)/LendingRiskFacet(6)。移除不再需要的 `import type BigNumber`。
- **不动** `src/index.ts` 的 `export { BigNumber }`。

A2. **producer 出口改用 toCanonical**：
- binance catalog `src/adapters/binance/market-catalog.ts`：`normalizeSpotSymbol`/`normalizeDerivativesSymbol` 的 `new BigNumber(x)` → `toCanonical(x)`（x 为交易所原始 string）。`BinanceMarketDefinition extends MarketDefinition` 自动跟随。
- `src/managers/market-manager.ts`：`createL1Book`/`createFundingRate`。
- `src/managers/account-manager.ts`：`createBalance`（`total.minus(free)`、`previousFree.plus(previousUsed)` 局部 BigNumber 运算后 `toCanonical`）、`createPosition`、`createRisk`、`getBigNumber`。
- `src/managers/order-manager.ts`：`createSnapshot`(`:526`)。

A3. **内部 re-parse 点**（消费将变 string 的字段做算术/判零）：
- `market-manager.normalizeOrderInput`(`:263-308`)：`floorToStep`/`isLessThan` 处把 `market.{priceStep,amountStep,minAmount,minNotional}` `new BigNumber()` re-parse；出口 `:275-278` 原 `.toFixed()` 改为直接透传 string。
- `account-manager` position 判零：`:325` `nextPosition.size.isZero()`、`:464` `.filter(p => !p.size.isZero())` → 改 `new BigNumber(x.size).isZero()`（判零在 caller，不在 createPosition 内）。
- 提升/替换 `market-manager.ts:103` 的 `normalizeDecimalInput` → 用 `toCanonical`（语义等价：现为 `(value: BigNumber)`，新签名吃 DecimalInput，调用点 `:269-272` 不变）。

A4. **静态守卫测试**（alias-safe，非裸 grep）：Bun test 解析 `src/types/**` 对 `bignumber.js` 的 type import/引用（含 `import type X from "bignumber.js"` 别名），仅放行 `market.ts` 的 `DecimalInput`；`src/index.ts` re-export 单独精确断言。出现非法（含别名）BigNumber 输出字段时失败。

**Phase A 门禁**：`bun run lint` 绿；`bun run type-check` 仅在 `tests/**`、`scripts/**` 报红（src/ 干净）；新静态守卫测试通过。
**→ Claude review A：toCanonical 语义、9 类型改型、re-parse 三点、catalog、守卫健壮性。通过才放行 B。**

---

## Phase B — 测试 + 脚本（把 type-check **和** test 全部转绿）

> ⚠️ **关键教训（Phase A review 实测）**：`type-check` 报错 ≠ Phase B worklist。多数 integration 断言是 `toMatchObject`/`toEqual({... new BigNumber(...) ...})` 形态——**类型合法、运行期炸**，type-check 看不见。实测 `order.test.ts` type-check 0 错却有 4 个运行期失败。**worklist = `bun test` 失败 ∪ `type-check` 报错**，两者互不包含。

### B-runtime：`bun test` 运行期失败（21 个，全在 integration）
- `tests/integration/account.test.ts`（9）
- `tests/integration/market.test.ts`（10）
- `tests/integration/order.test.ts`（4）
- `tests/integration/client-lifecycle.test.ts`（2）
- 改法：期望值里凡 `new BigNumber(X)` 一律**追加 `.toFixed()`** 得 canonical string（如 `toEqual(new BigNumber("0.010"))` → `toBe(new BigNumber("0.010").toFixed())`，结果 `"0.01"`）。**保留原计算式**（尤其 `new BigNumber(1).dividedBy("31.0")` 这类除法），只在末尾 `.toFixed()`——切勿手抄字面量，避免精度/尾零错。

### B-typecheck：`type-check` 报错（~59，多在 scripts/support）
- `scripts/live-account-smoke.ts`(13)、`live-juplend-account-smoke.ts`(15)、`live-market-smoke.ts`(16)、`live-order-smoke.ts`(6)：snapshot 字段上的 `.toFixed()`/`.minus()` 改为对 string 操作（如展示用 `field` 直接打印，或 `new BigNumber(field).minus(...)`）。
- `tests/support/exchanges/okx.ts`(9，行 160-188)：fake 所构造 `MarketDefinition` 的 `new BigNumber()` → `toCanonical()`。
- `tests/soak/market-l1-continuity.test.ts`(2，行 125/132)：同 integration 改法。

### B4：canonical 边界单测（并入既有单测，非另立集中测试）
`toCanonical` + 代表性 builder 输出覆盖 `1e-7`/`1e21`/负数/零/超长小数 → 断言无科学计数、无尾零。

**Phase B 门禁**：`bun run lint` **+** `bun run type-check` **+** `bun run test` **三者全绿**（不能只看 type-check）。
**→ Claude review B：`bun test` 真全绿、断言确实改 string 且为 canonical、边界用例到位、未误改 src 行为。**

---

## Phase C — 文档 + 发布

C1. `docs/api.md`（54 处）：数值字段示例 BigNumber→string；`:193` `askPrice.minus(bidPrice)` 反例改为 `new BigNumber(askPrice).minus(new BigNumber(bidPrice))` 或等价。
C2. `README.md`：6 处 `.toFixed()` 示例（`:33/47/54/116/119/120`）+ `:144` "输出字段统一是 BigNumber" 契约描述重写为 canonical string + 宽进严出说明。
C3. **`.changeset/*.md`**（kebab-case，bump=`minor`）：summary 中文写破坏性变化 + 迁移姿势（`new BigNumber(field)` 自取、勿 `parseFloat`、`.minus()/.multipliedBy()` 链式调用在 string 上会炸）。
C4. **`.trellis/spec/backend/release-publishing.md`**：bump 矩阵补 0.x carve-out（"pre-1.0 破坏性用 minor，major 留 1.0 里程碑"）。
C5. architecture/roadmap 文档残留视情况（roadmap 是叙述、architecture 由 Claude review 时定，可不改）。

**Phase C 门禁**：`bun run lint` / `type-check` / `test` 全绿（最终）。
**→ Claude 终审（Phase 3.1 trellis-check 等价）：spec 合规、AC 全勾、跨层一致。**

---

## 全局约束（给 codex）
- 不 `git commit`/`git push`（提交由 Claude 在 Phase 3.4 驱动）。
- 不动输入侧 `DecimalInput`/`CreateOrderInput`/`NormalizedOrderInput`。
- 不改内部精度算法；只在出口 stringify、消费处 re-parse。
- `toCanonical` 吃 number 但 number 本身有 JS 精度损失——docs 不宣传 number 为无损来源。
- 用 type-check 的报错清单当 B 阶段的 worklist（types-first 让编译器把待改点全列出来）。
