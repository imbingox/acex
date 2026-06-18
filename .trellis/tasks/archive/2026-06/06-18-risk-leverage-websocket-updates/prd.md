# riskLeverage websocket updates

## Goal

让 `RiskSnapshot.riskLeverage` 和其它风险字段一样，在 Binance 私有 WS 风险/账户事件到达时及时更新，而不是只依赖 REST bootstrap / risk refresh / private reconcile。修复当前全平后 `riskLeverage` 保留旧值的问题。

## What I already know

* 用户期望 `ACCOUNT_UPDATE` 和 `riskLevelChange` 都能更新 `riskLeverage`；该字段属于风险参数，应和 REST 风险字段一起变化。
* 当前 Binance REST 路径会计算 `riskLeverage`：
  * `bootstrapAccount()` / `reconcileAccount()` 请求 `/papi/v1/account`、`/papi/v1/um/positionRisk`。
  * `refreshAccount()` 定时请求 `/papi/v1/account`、`/papi/v1/um/positionRisk`，默认 `riskPollIntervalMs = 5s`。
* 当前计算公式在 `src/adapters/binance/private-adapter.ts`：
  * `riskLeverage = sum(abs(position.notional)) / riskEquity`
  * `riskEquity` 来自 `account.accountEquity`，fallback 到 `totalEquity`。
* 当前 `calculateRiskLeverage()` 在 `grossExposure === 0` 时返回 `undefined`。
* `AccountManager.createRisk()` 对 `input.riskLeverage === undefined` 的语义是“保留 previous.riskLeverage”，所以全平后 REST 计算出 `undefined` 会留下旧值。
* 当前 `ACCOUNT_UPDATE` adapter 映射只更新 balances / positions，不生成 risk update。
* 当前 `riskLevelChange` 会发布 `account.risk_level_change`，并回填 `riskLevel/riskRatio/netEquity/riskEquity/maintenanceMargin`，但不回填 `riskLeverage`。

## Code Reading Notes

### Binance private adapter

* `src/adapters/binance/private-adapter.ts`
  * `BinancePapiUmPosition` 有 `notional`，REST `positionRisk` 可用于精确计算 gross exposure。
  * `BinanceAccountUpdatePosition` 只有 `s/pa/ep/cr/up/mt/iw/ps/ma` 等字段，没有 REST `positionRisk.notional`，也没有 mark price。
  * `mapAccountUpdate()` 当前只返回 `balances/positions/exchangeTs/receivedAt`。
  * `mapRiskLevelChange()` 当前只返回 `riskLevel/riskRatio/netEquity/riskEquity/maintenanceMargin/exchangeTs/receivedAt`。
  * `ACCOUNT_CONFIG_UPDATE` 只更新 `PositionSnapshot.leverage`，不应参与 `RiskSnapshot.riskLeverage`。

### Account manager

* `src/managers/account-manager.ts`
  * `onPrivateAccountUpdate()` 先应用 balance/position，再应用 `update.risk`。
  * 如果 `update.risk` 不存在，即使仓位 size 变化，也不会发布 `risk.updated`。
  * `onPrivateRiskLevelChange()` 能拿到当前 account snapshot，所以可以基于现有 positions + 事件里的 `riskEquity` 派生 `riskLeverage`。
  * `PositionSnapshot` 当前没有 `notional` 字段，只有 `size/markPrice/entryPrice/unrealizedPnl/leverage/liquidationPrice`。

### Tests/docs currently covering this area

* `tests/integration/account.test.ts`
  * bootstrap 断言 `riskLeverage = 1010.002 / 1400.75`。
  * risk polling 断言 `riskLeverage = 1200 / 1600`。
  * `riskLevelChange` 断言风险字段回填，但未断言 `riskLeverage`。
  * 没有覆盖 `ACCOUNT_UPDATE` 仓位变化后同步重算 `riskLeverage`。
  * 没有覆盖全平后 `riskLeverage` 归零。
* `docs/api.md`
  * 当前文档说 `ACCOUNT_UPDATE` 更新余额和仓位，`riskLevelChange` 回填部分风险字段，REST refresh 校准风险字段和 mark-to-market 仓位字段。需要随行为调整。

## Related Field Audit

这次需要一起确认的相邻字段如下：

### 应该一起更新

* `RiskLevelChangedEvent.riskLeverage`
  * `account.risk_level_change` public event 目前透出 `riskRatio/netEquity/riskEquity/maintenanceMargin`，如果 manager 已经基于 `riskLevelChange.ae` + 当前 positions 派生出 `riskLeverage`，该事件也应带 optional `riskLeverage?: string`。
  * `risk.updated.snapshot.riskLeverage` 同步更新是必需项。

### 已由现有事件源更新，不需要本任务重做

* `riskLevel`
  * REST `accountStatus` 和 WS `riskLevelChange.s` 已覆盖。
  * `ACCOUNT_UPDATE` 不带 risk level，不应派生。
* `riskRatio`
  * REST `uniMMR` 和 WS `riskLevelChange.u` 已覆盖。
  * `ACCOUNT_UPDATE` 不带 `uniMMR` 或等价字段，不应派生。
* `netEquity`
  * REST `actualEquity` 和 WS `riskLevelChange.eq` 已覆盖。
  * `ACCOUNT_UPDATE` 的 balance/position 增量不足以可靠还原 portfolio margin 口径净权益，不应派生。
* `riskEquity`
  * REST `accountEquity/totalEquity` 和 WS `riskLevelChange.ae` 已覆盖。
  * `ACCOUNT_UPDATE` 不带 account-equity 口径字段，不应派生。
* `maintenanceMargin`
  * REST `accountMaintMargin/totalMaintMargin` 和 WS `riskLevelChange.m` 已覆盖。
  * `ACCOUNT_UPDATE` 不带 maintenance margin，不应派生。
* `PositionSnapshot.unrealizedPnl`
  * REST `positionRisk.unRealizedProfit/unrealizedProfit` 和 WS `ACCOUNT_UPDATE.P[].up` 已覆盖。
  * 本任务不需要额外处理。

### 不应该在本任务里更新

* `initialMargin`
  * REST `accountInitialMargin/totalInitialMargin` 覆盖。
  * `riskLevelChange` 和 `ACCOUNT_UPDATE` 都没有 initial margin 字段，不应派生。
* `PositionSnapshot.markPrice`
  * REST `positionRisk.markPrice` 覆盖。
  * `ACCOUNT_UPDATE` 没有 mark price；本任务只读取已有 `markPrice` 来派生 `riskLeverage`，不更新 `markPrice` 本身。
* `PositionSnapshot.liquidationPrice`
  * REST `positionRisk.liquidationPrice` 覆盖。
  * `ACCOUNT_UPDATE` 没有 liquidation price；平仓时 position 删除会自然清理该字段。
* `PositionSnapshot.leverage`
  * REST `positionRisk.leverage` 和 WS `ACCOUNT_CONFIG_UPDATE.ac.l` 已覆盖。
  * 这是仓位配置杠杆，不是账户风控 `riskLeverage`；本任务不改变它。

## Assumptions

* `riskLeverage` 对外语义仍是风控口径 gross exposure / riskEquity。
* REST `positionRisk.notional` 仍是最权威的 gross exposure 来源。
* WS `ACCOUNT_UPDATE` 没有 notional，因此 WS 即时更新只能基于本地已有 position snapshot 派生；如果缺少 `markPrice`，不更新 `riskLeverage`，等待 REST 校准。
* 不把 Binance 特定字段泄漏到 manager/runtime；adapter 继续只输出标准 `Raw*` 类型。

## Proposed Design

推荐采用“REST 精确计算 + Manager 派生 WS 增量”的方案。

### 1. 修复 REST 全平归零

在 Binance REST `calculateRiskLeverage()` 中：

* `riskEquity` 缺失、非有限数或为 0：继续返回 `undefined`，表示无法计算。
* `grossExposure === 0`：返回 `"0"`，表示可计算且已无风险敞口。
* 非零敞口：保持 `grossExposure / riskEquity`。

这样 REST refresh / reconcile 在全平后会明确覆盖旧 `riskLeverage`。

### 2. 在 AccountManager 内派生 WS riskLeverage

新增 manager 内部 helper，避免 adapter 依赖 manager 状态：

```text
calculateSnapshotRiskLeverage(riskEquity, positions)
```

建议逻辑：

* `riskEquity` 缺失、非有限数或为 0：返回 `undefined`。
* 对每个 position：
  * size 为 0 的 position 不计入敞口。
  * 优先使用 `markPrice` 计算 `abs(size * markPrice)`。
  * 如果任一非零 position 缺少 `markPrice`，本次不派生 `riskLeverage`，等待 REST risk refresh 校准。
* 全部 position 敞口为 0：返回 `"0"`。
* 有非零 position 但缺少 `markPrice`：返回 `undefined`，保留旧值，等待 REST risk refresh 校准。

### 3. ACCOUNT_UPDATE 后同步更新 riskLeverage

在 `onPrivateAccountUpdate()` 中：

* 先沿用现有流程应用 balances / positions。
* 如果本次有 position update 被实际应用，且当前/本次 risk 中有可用 `riskEquity`：
  * 基于应用后的 `positions` Map 计算 `riskLeverage`。
  * 如果本次 `update.risk` 已存在，把派生出的 `riskLeverage` 合并进本次 risk update。
  * 如果本次 `update.risk` 不存在，但可算出 `riskLeverage`，创建一个最小 `RawRiskUpdate`，只带 `riskLeverage/exchangeTs/receivedAt`。
  * 发布 `risk.updated`，让消费者能实时收到风险参数变化。
* 遵守现有 watermark 规则，不让旧 WS 事件覆盖新 REST 快照。

预期效果：

* 开仓/加仓/减仓的 `ACCOUNT_UPDATE` 到达后，`riskLeverage` 尽快按当前 snapshot 变化。
* 全平 `ACCOUNT_UPDATE` 到达后，本地 positions 被删除，`riskLeverage` 变成 `"0"`。
* 后续 REST risk refresh 仍会用 `positionRisk.notional` 校准精确值。

### 4. riskLevelChange 同步更新 riskLeverage

在 `onPrivateRiskLevelChange()` 中：

* 构造 `riskUpdate` 时，如果事件里有 `riskEquity`，用当前 positions 派生 `riskLeverage`。
* 如果事件没有 `riskEquity`，但 previous risk 有 `riskEquity`，可以用 previous riskEquity 派生；推荐只在事件缺失 `riskEquity` 时 fallback，避免覆盖交易所最新权益。
* `RiskLevelChangedEvent` public event 是否新增 `riskLeverage` 字段需要决策：
  * 推荐新增 optional `riskLeverage?: string`，因为用户明确把它视为风险字段，且 `account.risk_level_change` 已经透出其它风险数值。
  * 同时 `risk.updated.snapshot.riskLeverage` 必须更新。

### 5. 文档同步

更新 `docs/api.md`：

* 说明 `ACCOUNT_UPDATE` 会在仓位变更后基于本地 position snapshot 派生 `riskLeverage`，REST refresh 仍负责权威校准。
* 说明 `riskLevelChange` 会用事件风险权益和当前 positions 回填 `riskLeverage`。
* 说明全平时 `riskLeverage` 为 `"0"`，不再保留旧值。

## Alternatives Considered

### A. 只修 REST 全平归零

优点：改动最小，精确性完全依赖 REST。

缺点：不能满足用户希望 `ACCOUNT_UPDATE` / `riskLevelChange` 实时更新风险字段的目标。

### B. 在 adapter 给 ACCOUNT_UPDATE 增加 notional

不可行：Binance `ACCOUNT_UPDATE` payload 当前没有 `notional` / `markPrice` 字段。adapter 无法凭单条 WS 消息计算 REST 同口径 notional。

### C. 给 public PositionSnapshot 增加 notional

优点：以后可保留 REST notional，WS size 变化时能更明确知道上一次 notional 来源。

缺点：扩大 public contract，仍无法解决 ACCOUNT_UPDATE 新 size 对应的最新 notional 缺失问题；本任务不建议引入。

## Requirements

* REST risk leverage 计算必须在 gross exposure 为 0 时返回 `"0"`。
* `ACCOUNT_UPDATE` 实际改变 position 后，应尽量同步更新 `RiskSnapshot.riskLeverage`。
* `riskLevelChange` 应在回填其它风险字段时同步回填 `RiskSnapshot.riskLeverage`。
* `risk.updated` 事件应在 `riskLeverage` 因 WS 事件变化时发布。
* 缺少 `riskEquity` 或价格信息导致无法可靠计算时，不应输出非数字或错误值；可保留旧值，等待 REST refresh。
* REST refresh / reconcile 继续作为权威校准路径。
* 保持 public decimal 输出为 canonical string。
* 不在 manager/runtime 中引入 Binance 特定类型。

## Acceptance Criteria

* [ ] Binance REST refresh/reconcile 在所有 position notional 为 0 时，`getRiskSnapshot(accountId)?.riskLeverage === "0"`。
* [ ] Binance `ACCOUNT_UPDATE` 将已有非零 position 变为 0 后，positions 被清理，`risk.updated.snapshot.riskLeverage === "0"`。
* [ ] Binance `ACCOUNT_UPDATE` 将 position size 从 `0.01` 改到 `0.02`，且 snapshot 有 `markPrice` 与 `riskEquity` 时，`riskLeverage` 按新 size 与当前 mark price 派生并发布 `risk.updated`。
* [ ] Binance `ACCOUNT_UPDATE` 改变非零 position，但当前 snapshot 缺少 `markPrice` 时，不发布仅用于派生 `riskLeverage` 的 `risk.updated`，并保留旧 `riskLeverage` 等待 REST 校准。
* [ ] Binance `riskLevelChange` 带 `ae` 时，`RiskSnapshot.riskEquity` 和 `riskLeverage` 同步更新。
* [ ] stale `riskLevelChange` 仍不覆盖更新的 risk snapshot。
* [ ] `ACCOUNT_CONFIG_UPDATE` 仍只更新 `PositionSnapshot.leverage`，不误改 `RiskSnapshot.riskLeverage`。
* [ ] `bun run type-check` 通过。
* [ ] 相关 account integration tests 通过；若范围允许，跑 `bun run test`。

## Test Plan

重点更新 `tests/integration/account.test.ts`：

* 在现有账户 bootstrap 测试中，`ACCOUNT_UPDATE` 后增加 `risk.updated` 断言：
  * 初始 riskEquity = `1400.75`。
  * 初始 markPrice = `101000.20`。
  * `pa: "0.020"` 后，派生 gross exposure = `0.020 * 101000.20 = 2020.004`。
  * 期望 `riskLeverage = 2020.004 / 1400.75`。
* 增加全平 `ACCOUNT_UPDATE` 断言：
  * `pa: "0"` 后 position 删除。
  * 期望 `risk.updated.snapshot.riskLeverage === "0"`。
* 更新 `riskLevelChange` 测试：
  * 事件 `ae: "28.1000"` 时，基于当前 positions 派生 `riskLeverage`。
  * 如果新增 `RiskLevelChangedEvent.riskLeverage`，同时断言 public event 字段。
* 更新 polling/reconcile 测试，覆盖 REST 全平 `riskLeverage` 归零。

可选单测：

* 为 manager helper 添加低层单测，覆盖缺 price、riskEquity 为 0、全平、非零仓位。

## Out of Scope

* 不新增 public `PositionSnapshot.notional`。
* 不改变 Binance REST endpoint 或 polling interval 默认值。
* 不实现 USDⓈ-M 独立合约流 `MARGIN_CALL`，仍只处理 PAPI `riskLevelChange`。
* 不让 `ACCOUNT_CONFIG_UPDATE` 改 `RiskSnapshot.riskLeverage`。
* 不保证 WS 派生值与 REST `positionRisk.notional` 完全一致；REST refresh 仍是校准源。

## Decisions

* `ACCOUNT_UPDATE` 派生 `riskLeverage` 时只使用当前 `PositionSnapshot.markPrice`。如果非零 position 缺少 `markPrice`，本次不更新 `riskLeverage`，等待 REST risk refresh / reconcile 校准；不 fallback 到 `entryPrice`。
* 除 `riskLeverage` 及对应 public `RiskLevelChangedEvent.riskLeverage` 外，不新增其它派生风险字段。

## Definition of Done

* 需求与方案经用户确认。
* 代码实现符合 `.trellis/spec/backend/` 约束。
* 测试覆盖新增 WS 更新路径与 REST 全平归零。
* `bun run type-check` 与相关测试通过。
* `docs/api.md` 同步更新行为说明。
