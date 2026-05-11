# Journal - codex-agent (Part 1)

> AI development session journal
> Started: 2026-04-20

---



## Session 1: Binance PAPI account read-only

**Date**: 2026-04-20
**Task**: Binance PAPI account read-only
**Branch**: `feat/order_account`

### Summary

(Add summary)

### Main Changes

## Summary

Implemented Binance Portfolio Margin PAPI account read-only support for the SDK.

## Completed Work

| Area | Details |
|------|---------|
| Private adapter | Added `PrivateAccountAdapter` contract and Binance PAPI implementation for signed REST, listenKey lifecycle, private WS, and `ACCOUNT_UPDATE` parsing. |
| Account manager | Replaced placeholder account snapshots with real REST bootstrap plus user data stream updates for UM-only balances, positions, and risk. |
| Runtime/options | Wired Binance private adapter into runtime and added account stream runtime options. |
| WebSocket infra | Extended managed websocket to support open-ready private streams and reconnect without requiring an initial message, while preserving market message-ready behavior. |
| Tests | Split large client test into lifecycle, market, account, and support files; removed 60s soak from regular `bun test`. |
| Live smoke | Added opt-in `test:live:account` smoke/soak scripts for real Binance PAPI account read-only validation. |
| Specs | Updated backend code organization and type safety specs with executable private account adapter contract and validation matrix. |

## Validation

- `bun run lint` passed
- `bun run type-check` passed
- `bun test` passed: 15 tests, 0 failures
- `bun run scripts/live-account-smoke.ts --help` passed
- Manual PAPI account live smoke passed with healthy status, USDT balance, and account equity observed

## Notes

- First slice intentionally covers Binance PAPI account read-only and UM positions only.
- Order tracking, trading mutations, CM positions, and Portfolio Margin Pro remain out of scope for this commit.
- Long-running L1/account stability checks now live under opt-in live smoke/soak commands instead of regular `bun test`.


### Git Commits

| Hash | Message |
|------|---------|
| `6429738` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Ship Binance private trading MVP and release automation

**Date**: 2026-04-21
**Task**: Ship Binance private trading MVP and release automation
**Branch**: `feat/order_account`

### Summary

Implemented Binance private account and order management with shared private subscription coordination, live smoke coverage for limit place/cancel, public docs/spec updates, and a Changesets plus npm Trusted Publishing release workflow.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `baeab15` | (see git log) |
| `f85a9b0` | (see git log) |
| `82ef26a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Stabilize npm release workflow after release PR rollout

**Date**: 2026-04-21
**Task**: Stabilize npm release workflow after release PR rollout
**Branch**: `fix/release-version-packages-formatting`

### Summary

Debugged the post-merge Release workflow, fixed the Changesets prerelease file formatting regression, switched package.json repository metadata to the canonical GitHub URL, and hardened version-packages so future release PRs auto-format generated metadata after changeset version. Human-side npm provenance/trusted publishing settings were then adjusted and publishing succeeded.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `678d760` | (see git log) |
| `fdcb892` | (see git log) |
| `0a4c717` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: 添加资金费率 market 数据

**Date**: 2026-04-25
**Task**: 添加资金费率 market 数据
**Branch**: `feat/funding`

### Summary

接入 Binance funding rate mark price websocket，新增 per-stream status、live smoke、文档和回归测试，并归档 Trellis 任务。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `62bea64` | (see git log) |
| `dbf5462` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: 补充 release changeset 规范并创建 PR

**Date**: 2026-04-25
**Task**: 补充 release changeset 规范并创建 PR
**Branch**: `feat/funding`

### Summary

为资金费率功能补充 minor changeset，更新 release spec 中按用户可见变更选择 changeset bump 的规则，并创建 GitHub PR #10。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5dcc3c1` | (see git log) |
| `d9e15d6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Funding 聚合接口与 Binance mark price 修复

**Date**: 2026-04-29
**Task**: Funding 聚合接口与 Binance mark price 修复
**Branch**: `feat/funding`

### Summary

新增 getMarkets/getL1Books/getFundingRates 严格 symbol 聚合接口，移除 findMarkets，修复 Binance USDⓈ-M funding mark price WS endpoint 并同步 README/docs/api 与测试。质量验证已通过 lint、type-check、market tests、全量 bun run test。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4ed0e0b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: 补充 funding 聚合 changeset

**Date**: 2026-04-30
**Task**: 补充 funding 聚合 changeset
**Branch**: `main`

### Summary

为已合并的 symbol-level market data aggregators 与 Binance funding mark price websocket 更新补充 minor changeset，并创建/合并 PR #13，确保后续 Changesets beta release 流程可生成新版本。质量验证通过 lint、type-check、全量 bun run test。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `680e315` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: Restructure test suites and CI

**Date**: 2026-04-30
**Task**: Restructure test suites and CI
**Branch**: `feat/test`

### Summary

拆分 unit/integration/soak 测试套件，新增 PR CI，补齐 public API 缺口测试，抽离通用测试工具与 Binance fixture，并更新 README、架构文档和 backend spec 测试规范。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0357dcc` | (see git log) |
| `97146d1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: 文档补充 market 订阅行为

**Date**: 2026-05-01
**Task**: 文档补充 market 订阅行为
**Branch**: `feat/market`

### Summary

补充了 Binance market 的订阅/退订行为说明，记录了当前 raw websocket 方案与 future combined 优化取舍，并完成质量检查。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2516e8a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: Post-only orders and input normalization

**Date**: 2026-05-03
**Task**: Post-only orders and input normalization
**Branch**: `feat/market`

### Summary

为下单链路新增 postOnly limit 支持，Binance PAPI UM 映射为 GTX；新增 market.normalizeOrderInput() 以按交易所 priceStep/amountStep 归一化下单价格和数量，并返回最小下单条件拒绝原因；补充 changeset、API 文档、集成测试并创建 PR #16。验证通过 lint、type-check、全量 bun run test。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9dad2f0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: Juplend lending account view

**Date**: 2026-05-05
**Task**: Juplend lending account view
**Branch**: `feat/new_account`

### Summary

Implemented venue-based account registration and Juplend read-only lending account support with lending facets, unified riskRatio, positionId filtering, serialized polling, live smoke coverage, docs/spec updates, and passing lint/type-check/tests.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c411b69` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: Venue capability queries and npm docs packaging

**Date**: 2026-05-06
**Task**: Venue capability queries and npm docs packaging
**Branch**: `feat/new_account`

### Summary

Added top-level venue capability queries, moved capability truth closer to adapters, documented constraints, and included docs/api.md in the published npm package.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ea9a4a7` | (see git log) |
| `46d1291` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 13: Refresh Binance Account Risk

**Date**: 2026-05-11
**Task**: Refresh Binance Account Risk
**Branch**: `docs/account-realtime-refresh-spec`

### Summary

为 Binance account risk 增加 REST polling 校准和 actualLeverage 补充指标，修复 PR review 中指出的状态覆盖与 stale 风险，并补充 adapter contract：实时账户字段不能假设 WS 会因行情变化持续推送，必要时必须用 polling/refresh/stale 语义保证时效性。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `50e4e09` | (see git log) |
| `9ee60cf` | (see git log) |
| `628cefe` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
