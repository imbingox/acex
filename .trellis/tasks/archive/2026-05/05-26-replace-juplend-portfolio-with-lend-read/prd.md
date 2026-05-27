# 用 Jupiter Lend Read SDK 替换 Juplend portfolio hack

## Goal

把当前 Juplend 账户视图从 `Jupiter Portfolio API + vault lite-api + USD/price 反推数量` 的实现，替换为基于 `@jup-ag/lend-read` 的原生 on-chain read 实现，提升数据准确性与字段完整度，并接入用户提供的 `SOL_HELIUS_RPC` 作为 RPC 端点来源。

## What I already know

* 当前实现位于 `src/adapters/juplend/private-adapter.ts`，通过 `GET /portfolio/v1/positions/{wallet}` 拉取聚合仓位，再用 `GET /lend/v1/borrow/vaults` 补静态元数据。
* 当前 Juplend 数量字段是由 `suppliedValue / borrowedValue` 除以 oracle price 反算得到，README 已明确记录这一限制。
* `@jup-ag/lend-read@0.0.12` 已发布，可通过 `Client().vault` 读取 vault config/state、用户 position、current position state、oracle 价格、all user positions 等原生数据。
* SDK 默认 RPC 是 `https://api.mainnet-beta.solana.com`；本地实测默认 RPC 很容易遇到 429，因此生产可用性需要依赖自定义 RPC。
* 用户已提供环境变量 `SOL_HELIUS_RPC`，希望作为 Juplend 原生 read SDK 的 RPC 来源。
* 用户希望“全套替换原来的 hack 方式”，说明目标不是在旧 portfolio 逻辑外面再包一层 fallback，而是把 Juplend 主读链路迁移到原生 SDK。

## Assumptions (temporary)

* Juplend 账户视图继续保持 read-only，不引入链上写操作。
* `AccountManager` 对外暴露的 `balances` / `risk` 结构保持兼容，调用方不需要切换消费方式。
* `positionId` 过滤语义继续保留，但数据源会从 portfolio link 匹配切到原生 vault position / NFT id 匹配。

## Open Questions

* 无

## Requirements (evolving)

* Juplend adapter 必须移除对 portfolio API 的核心依赖，主链路改为 `@jup-ag/lend-read`。
* Juplend balances 必须来自原生 position 数据，不再通过 USD 值反推 token 数量。
* Juplend risk 必须基于原生 vault config / position / oracle 数据计算，并保持 ACEX 现有 `riskRatio` / `riskEquity` 语义稳定。
* Juplend polling 仍需保持全量替换语义与串行调度语义，避免 stale snapshot 与请求重叠。
* Juplend public 注册契约不再要求 `credentials.apiKey`。
* RPC 配置必须作为可选项暴露；未显式配置时默认读取 `SOL_HELIUS_RPC`。
* live smoke / README / `docs/api.md` 必须切换到新的 RPC 驱动方式。
* 测试必须覆盖新映射逻辑、`positionId` 过滤、快照替换、以及至少一条 RPC 配置/缺失场景。

## Acceptance Criteria (evolving)

* [ ] `src/adapters/juplend/private-adapter.ts` 不再使用 portfolio API 作为 Juplend 主数据源。
* [ ] Juplend `balances` 的 `supplied` / `borrowed` / `netAsset` 基于原生仓位数量产生，而不是 `USD / price` 反推。
* [ ] Juplend `risk` 仍能生成 `netEquity`、`riskEquity`、`riskRatio` 与 lending facet，且数值口径与 ACEX 文档一致。
* [ ] `SOL_HELIUS_RPC` 可驱动 live smoke 和运行时 Juplend 读取，且可被显式 RPC 配置覆盖。
* [ ] 相关单测/集成测试、lint、type-check 通过。
* [ ] README / `docs/api.md` / live smoke 帮助文本更新到新接入方式。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 为 Juplend 增加下单、supply、borrow、repay、withdraw 等写操作
* 把 ACEX 的 public `positions` 模型升级成可表达 NFT/vault 仓位的全新结构
* 同步接入其他 Solana 借贷 venue

## Technical Notes

* 现有实现：`src/adapters/juplend/private-adapter.ts`
* 现有 public 契约：`src/types/shared.ts`、`README.md`、`docs/api.md`
* live smoke：`scripts/live-juplend-account-smoke.ts`
* 参考 SDK：`@jup-ag/lend-read@0.0.12`
* 关键原生能力：`Client.vault.getAllUserPositions(user)`、`getCurrentPositionState({ vaultId, position })`、`getVaultByVaultId(vaultId)`、`getOraclePrice(oracle)`
* 用户决策：采用 breaking change，Juplend 不再要求 `apiKey`；RPC 配置可选，默认走 `SOL_HELIUS_RPC`
