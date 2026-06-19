# RiskLimitManager

## Goal

新增账户级 `RiskLimitManager`，用于维护交易所硬风控限制缓存，并向下游提供按 `accountId + symbol` 查询风险限制与设置杠杆的统一入口。

首要解决 Binance 合约在极端费率或交易所风控限制下，默认杠杆/期望杠杆过高导致下单返回 `Exceeded the maximum allowable position at current leverage` 的问题。下游策略应能在下单前读取该 symbol 的最大杠杆、杠杆档位和当前杠杆对应限制，并能通过 SDK 主动设置 symbol 杠杆。

本任务只做 `RiskLimitManager` 本身，不把手续费、仓位、订单聚合到同一个高层 `TradingContextManager`。后者可作为后续任务。

## Confirmed Facts

- 当前公开 client 已有 `market`、`account`、`order`、`fee` 四个 manager，同级挂载在 `AcexClient`。
- `AccountManager` 已维护仓位快照，`PositionSnapshot` 包含 `leverage` 字段，并通过 Binance `ACCOUNT_CONFIG_UPDATE` 更新当前杠杆。
- `OrderManager` 已维护 open orders，可供后续下单预检计算同方向挂单占用。
- `FeeManager` 是账户级手续费 manager，不适合承载杠杆档位、risk tier、max notional 等交易所硬限制。
- 当前 Binance 私有账户/订单适配器走 PAPI UM 路径，已有签名 REST、限流、错误包装、market catalog 和 symbol 映射基础设施。
- Binance 杠杆档位没有可靠的公开 WS 推送频道，需要通过 signed REST 拉取并缓存；`ACCOUNT_CONFIG_UPDATE` 只表示账户当前杠杆变更，不等价于 leverage tier 变更。

## Requirements

### Functional Requirements

- 新增 public `RiskLimitManager` 类型，并挂载到 client 上，作为与 `client.fee` 同级的账户级 manager。
- 支持按 `accountId + symbol` 查询 risk limit 快照。
- 首版支持 Binance PAPI UM：
  - 查询并缓存 symbol 的 leverage tier / notional tier 信息。
  - 支持全量刷新账户下所有 symbol 的 tier。
  - 支持按单个 symbol 显式刷新。
  - 支持按 `accountId + symbol` 设置杠杆。
- 查询结果必须包含足够下游判断杠杆限制的信息：
  - `accountId`
  - `venue`
  - `symbol`
  - `tiers` facet：tier 数据来源、更新时间、stale/missing 状态、档位列表、symbol 当前缓存可推导的最大初始杠杆，以及 Binance 这类 venue 返回的账户级 notional coefficient
  - `leverage` facet：最近一次由 SDK 设置杠杆后的交易所返回信息，例如 Binance 返回的 `maxNotionalValue`
- 设置杠杆成功后，manager 必须更新自身缓存中与当前 symbol 杠杆设置相关的可用信息；账户仓位里的 `position.leverage` 仍由 `AccountManager` 通过私有账户流或账户刷新维护。
- 查询结果不得把 leverage tier 的 freshness 与最近一次 set leverage 结果混为同一个状态；下游必须能通过 `snapshot.tiers` 和 `snapshot.leverage` 区分“tier 是否 fresh”和“最近一次设置杠杆是否成功”。
- 查询结果不得把最近一次 SDK 设置的杠杆命名为真实账户当前杠杆；真实当前杠杆仍以 `AccountManager.position.leverage` 为准。
- manager 的缓存必须是账户隔离的，缓存 key 至少包含 `accountId + symbol`，不能只按 symbol 全局复用。
- 当账户凭证更新或账户移除时，相关缓存必须失效或清理，避免使用旧账户权限下的数据。
- 对不支持 risk limit 查询或设置杠杆的 venue，应返回一致的 SDK 错误，而不是静默 fallback。

### Non-Functional Requirements

- 不重复维护仓位和 open orders；这些数据继续归 `AccountManager` / `OrderManager`。
- 不把 risk limit 数据塞进 `FeeManager`。
- 适配器层不泄漏 Binance 原始字段名到 public API，public 类型使用统一字段名。
- 数值字段遵循现有 canonical decimal string 风格。
- REST 请求必须走现有限流、签名、时间戳和错误处理基础设施。
- 缓存行为要可测试：账户注册 / client 启动后默认按账户全量后台刷新缓存；`getSymbolRiskLimit()` 只读缓存且不阻塞、不发起单 symbol 请求；显式 fetch 会更新缓存。
- 后续扩展 OKX、Bybit、Bitget 等 venue 时，不应破坏 public API。

### Suggested Public API Shape

最终命名可在设计阶段调整，但 PRD 期望能力类似：

```ts
client.riskLimit.getSymbolRiskLimit({
  accountId,
  symbol,
});

await client.riskLimit.fetchSymbolRiskLimit({
  accountId,
  symbol,
});

await client.riskLimit.fetchRiskLimits({
  accountId,
});

await client.riskLimit.setSymbolLeverage({
  accountId,
  symbol,
  leverage: "4",
});
```

## Acceptance Criteria

- [ ] `AcexClient` 暴露 `client.riskLimit`，且 public 类型从 `src/types/index.ts` 正常导出。
- [ ] `RiskLimitManager` 能按 `accountId + symbol` 返回缓存快照；未命中时返回明确的 stale/missing 状态或默认空快照，不抛出难以处理的内部错误。
- [ ] `RiskLimitManager` 的快照使用 `tiers` / `leverage` 两个 facet 分别表达 tier 数据状态和最近一次设置杠杆结果；设置杠杆成功不得把旧 tier 标记为 fresh。
- [ ] Binance `notionalCoef` 被保留为统一字段，或明确验证 notional cap/floor 已按 coefficient 调整；首版选择保留为 `notionalCoefficient`。
- [ ] Binance PAPI UM adapter 支持获取 leverage tier，并能把交易所返回映射为统一 raw 类型。
- [ ] Binance PAPI UM adapter 支持设置 symbol leverage，并返回统一 raw 类型，包含交易所返回的 `maxNotionalValue` 等限制信息。
- [ ] 显式 fetch 单 symbol 会更新对应缓存。
- [ ] 显式 fetch 全账户 risk limits 会批量更新缓存。
- [ ] 设置杠杆成功后，对应 symbol 的 risk limit / leverage setting 缓存会反映新的设置结果。
- [ ] `setSymbolLeverage()` 对非整数或超出 Binance 支持范围的 leverage 做本地输入校验，避免发送明显无效请求。
- [ ] 账户移除后，该账户的 risk limit 缓存被清理。
- [ ] 凭证更新后，该账户已缓存的 venue 数据不会继续被当作 fresh venue 数据使用。
- [ ] 不支持的 venue 或缺失凭证场景有单元测试覆盖，并返回一致的 `AcexError`。
- [ ] Binance 正常路径、缓存更新、错误路径至少有 unit test 覆盖；必要时增加 integration-style 测试沿用现有 fake exchange support。
- [ ] 新增 public API 配套 changeset。
- [ ] `bun run lint`、`bun run type-check`、相关测试通过。

## Out of Scope

- 本任务不实现完整下单前预检，不计算 `usedNotional / remainingNotional / maxQtyAtPrice`。
- 本任务不创建 `TradingContextManager` / `PreTradeManager`。
- 本任务不把 `OrderManager.createOrder` 改成自动调用 risk preflight。
- 本任务不迁移 `AccountManager` 的仓位职责。
- 本任务不实现 OKX / Bybit / Bitget 的 risk tier 适配；只保留可扩展接口。
- 本任务不依赖 WS 频道维护 leverage tier 实时更新。

## Decisions

- Public API 名称定为 `client.riskLimit`，避免和 `AccountManager` 里的 account risk / liquidation risk 混淆。
- `getSymbolRiskLimit()` 未命中时同步返回当前缓存/缺省状态，不触发 lazy 单 symbol 请求；默认 freshness 由账户级全量后台刷新维护，显式 `fetch*` 用于需要等待最新数据的路径。
- 设置杠杆成功后首版不强制刷新账户仓位，依赖 Binance `ACCOUNT_CONFIG_UPDATE`，但 `setSymbolLeverage()` 返回值包含本次设置结果供调用方立即使用。

## Notes

- `prd.md` 只记录需求、约束和验收标准。
- 复杂任务需要在实现前补齐 `design.md` 和 `implement.md`。
