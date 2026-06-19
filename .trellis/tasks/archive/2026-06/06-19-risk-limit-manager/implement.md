# RiskLimitManager Implementation Plan

## Preconditions

- 进入实现前重新运行 `trellis-before-dev`，读取：
  - `.trellis/spec/backend/code-organization.md`
  - `.trellis/spec/backend/adapter-contract.md`
  - `.trellis/spec/backend/error-handling.md`
  - `.trellis/spec/backend/type-safety.md`
- 用户已确认 `prd.md`、`design.md`、`implement.md`。
- 任务状态通过 `task.py start 06-19-risk-limit-manager` 切到 `in_progress`。

## Implementation Checklist

1. Public types
   - 新增 `src/types/risk-limit.ts`。
   - 导出 `RiskLimitManager`、输入类型、snapshot 类型、tier 类型、leverage update 类型。
   - `src/types/index.ts` 导出 risk-limit 类型。
   - `src/types/client.ts` 给 `AcexClient` 增加 `readonly riskLimit: RiskLimitManager`。
   - `src/types/shared.ts` 如需运行配置，RiskLimitManager 的通用缓存策略放在 `CreateClientOptions.riskLimit`；venue/account runtime options 只放 venue 私有连接、签名、stream、reconcile 等细节。
   - `SymbolRiskLimitSnapshot` 必须使用嵌套 facet 分别表达 tier 状态和最近一次 leverage 设置结果：`snapshot.tiers` 与 `snapshot.leverage` 不能混用。

2. Adapter SPI
   - 在 `src/adapters/types.ts` 增加 `RawRiskLimitTier`、`RawSymbolRiskLimit`、`RawSymbolLeverageUpdate`、request 类型。
   - 给 `PrivateUserDataAdapter` 增加 optional `fetchSymbolRiskLimit`、`fetchRiskLimits`、`setSymbolLeverage`。

3. Runtime context
   - 在 `src/client/context.ts` 的 `ClientContext` 增加 risk limit 内部方法。
   - 在 `src/client/runtime.ts` 实现这些方法：校验 started、账户、凭证、adapter method 支持，调用 private adapter。
   - 实例化 `RiskLimitManagerImpl`，挂到 `this.riskLimit`。
   - 生命周期：start/stop、removeAccount、credentials update 时调用 risk limit manager。
   - `updateAccountCredentials()` 中 risk limit 缓存失效必须和 `FeeManager` 一样放在 stopped early return 之前，保证 client 未运行时更新凭证也会让旧缓存失效。

4. Error codes
   - 在 `src/errors.ts` 增加 `RISK_LIMIT_FETCH_FAILED`、`RISK_LIMIT_INPUT_INVALID`、`LEVERAGE_SET_FAILED`。
   - manager 内部按现有 `FeeManager` 风格包装错误，保留 `cause` 和 `details`。
   - leverage 输入校验失败走 `RISK_LIMIT_INPUT_INVALID`，不发远端请求。

5. RiskLimitManager implementation
   - 新增 `src/managers/risk-limit-manager.ts`。
   - 实现缓存 record、账户级默认全量后台 refresh、只读 get、显式 fetch、全量 fetch、set leverage。
   - `getSymbolRiskLimit()` 只创建 / 返回缓存快照，未命中返回 missing/stale，不触发 lazy 单 symbol 请求。
   - `onAccountRegistered()` / `onClientStarted()` 调度账户级 worker；worker 调用 `fetchRiskLimits()` 批量维护缓存。
   - 数值字段用 `toCanonical()` 归一。
   - `notionalCoefficient` 必须从 raw 保留到 `snapshot.tiers.notionalCoefficient`。
   - `setSymbolLeverage()` 只更新 `snapshot.leverage.lastSet`，不能刷新 `snapshot.tiers.stale`。
   - 支持 in-flight 去重和 generation 防旧结果写回。
   - `onAccountRemoved()` 清理账户缓存。
   - `onCredentialsUpdated()` 标记账户缓存 stale 或 bump generation。
   - `onClientStopping()` 清理 timers。

6. Binance private adapter
   - 增加 Binance response interfaces：leverage tier response、tier item、set leverage response。
   - 增加 mapping helpers，所有 decimal 字段 canonical 化可在 manager 或 adapter raw 阶段处理；最终 public 必须 canonical。
   - Binance `notionalCoef` 映射为 `notionalCoefficient`，不得丢弃。
   - 实现 `fetchSymbolRiskLimit()`：`GET /papi/v1/um/leverageBracket?symbol=...`。
   - 实现 `fetchRiskLimits()`：`GET /papi/v1/um/leverageBracket`。
   - 实现 `setSymbolLeverage()`：`POST /papi/v1/um/leverage`。
   - 全部复用 `toUsdmVenueIdForCommand()` / catalog refresh 相关机制，避免 raw symbol 写入上层。

7. Rate limit topology
   - 在 `src/adapters/binance/rate-limit-topology.ts` 增加 PAPI leverage tier 和 leverage 设置 plan。
   - 按官方文档设置 request-weight cost：`GET /papi/v1/um/leverageBracket` 为 1，`POST /papi/v1/um/leverage` 为 1。
   - 更新 `getBinancePapiRateLimitPlanId()`。
   - 补 rate limiter unit test 覆盖 endpoint plan。

8. Test fixtures
   - 在 `tests/support/exchanges/binance.ts` 增加 leverage tier fixtures 和 set leverage response fixture。
   - fake fetch 支持：
     - `GET /papi/v1/um/leverageBracket`
     - `POST /papi/v1/um/leverage`
   - 支持 symbol 过滤、失败响应和请求记录断言。

9. Unit and integration tests
   - 新增 `tests/unit/risk-limit-manager.test.ts`，沿用 `fee-manager.test.ts` 的 stub context 模式。
   - 扩展 `tests/unit/binance-private-adapter.test.ts` 覆盖 adapter 新方法。
   - 增加 integration-style test，确认 `createClient` 暴露 `client.riskLimit`，fake Binance 正常路径能 fetch / set。
   - 补测试确认设置杠杆成功后不会把旧 tier 标为 fresh。
   - 补测试确认 `notionalCoefficient` 从 Binance response 保留到 `snapshot.tiers.notionalCoefficient`。
   - 补测试确认非整数、低于 1、高于 125 的 leverage 走本地输入错误且不发远端请求。
   - 如新增 public config 或 capability 字段，补对应 tests。

10. Documentation / changeset
    - 新增 public API 必须配 changeset。
    - 如新增 capability 字段，更新 docs/api 和 venue-capability spec；首版推荐不加 capability 字段。

## Review Gates

- 实现前 review：子代理只读 review `prd.md`、`design.md`、`implement.md`，确认范围、边界和遗漏。
- 实现中 review：每完成 adapter SPI + manager 框架后跑 `bun run type-check`。
- 完成后 review：运行 `trellis-check` 或等价质量检查，确认 lint/type/test。

## Validation Commands

首轮定向：

```bash
bun run type-check
bun run test tests/unit/risk-limit-manager.test.ts
bun run test tests/unit/binance-private-adapter.test.ts
bun run test tests/integration/client-lifecycle.test.ts
```

最终全量：

```bash
bun run lint
bun run type-check
bun run test
```

## Risk Points

- Binance 官方 endpoint 权重和 PAPI path 必须实现前再次核验，不能凭记忆写入 rate-limit topology。
- `leverageBracket` 返回形状在 single symbol 和 all symbols 模式可能不同，adapter mapper 要兼容对象/数组形状。
- 全量 fetch 里出现本地 catalog 不认识的新 symbol 时，不能污染 cache key；需要 inline catalog refresh 或跳过并报告。
- 设置杠杆成功不代表 `AccountManager.position.leverage` 立即同步；调用方应使用 `setSymbolLeverage()` 返回值做当次逻辑判断。
- 后台刷新失败不能清空旧的 venue cache。
- `RiskLimitManager` 不应计算下单剩余名义价值，避免把首版变成 pre-trade manager。

## Rollback Plan

- 新增 API 是 additive；若实现风险过高，可保留 types/manager scaffolding，暂时只支持 explicit fetch/set，不启用账户级后台 refresh。
- 若 Binance 全量 tier 映射复杂，可先交付单 symbol fetch + set leverage；全量 fetch 保留接口但返回 unsupported，需回到 PRD 修改 scope 并让用户确认。
- 后台错误 source 已定为 `runtime`；不要新增 `AcexInternalError.source = "risk_limit"`。
