# Risk Limit Manager

## Scenario: 账户级 RiskLimitManager 维护交易所硬风控限制

### 1. Scope / Trigger

- Trigger: 新增或修改 `client.riskLimit` public API、risk limit 缓存语义、Binance PAPI UM leverage bracket / leverage REST 映射，或扩展其它 venue 的 risk tier / leverage 能力。
- 目标: 下游能按 `accountId + symbol` 读取 leverage tier / notional tier 缓存，并通过统一 API 设置 symbol leverage，同时不把仓位、挂单和手续费职责混入同一个 manager。

### 2. Signatures

Public manager 落点固定在 `src/types/risk-limit.ts`，并通过 `AcexClient.riskLimit` 暴露：

```ts
interface RiskLimitManager {
  getSymbolRiskLimit(input: GetSymbolRiskLimitInput): SymbolRiskLimitSnapshot;
  getSymbolRiskLimits(accountId?: string): SymbolRiskLimitSnapshot[];
  fetchSymbolRiskLimit(input: GetSymbolRiskLimitInput): Promise<SymbolRiskLimitSnapshot>;
  fetchRiskLimits(input: FetchRiskLimitsInput): Promise<SymbolRiskLimitSnapshot[]>;
  setSymbolLeverage(input: SetSymbolLeverageInput): Promise<SymbolLeverageUpdate>;
}
```

Snapshot 必须使用两个独立 facet：

```ts
interface SymbolRiskLimitSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  tiers: {
    source: "missing" | "venue";
    stale: boolean;
    receivedAt?: number;
    items: RiskLimitTier[];
    maxInitialLeverage?: string;
    notionalCoefficient?: string;
  };
  leverage: {
    lastSet?: SymbolLeverageUpdate;
  };
  updatedAt: number;
}
```

Adapter SPI 在 `PrivateUserDataAdapter` 上保持可选：

```ts
fetchSymbolRiskLimit?(credentials, request, accountOptions): Promise<RawSymbolRiskLimit>;
fetchRiskLimits?(credentials, request, accountOptions): Promise<RawSymbolRiskLimit[]>;
setSymbolLeverage?(credentials, request, accountOptions): Promise<RawSymbolLeverageUpdate>;
```

### 3. Contracts

- `RiskLimitManagerImpl` 持有 `Map<JSON.stringify([accountId, symbol]), RiskLimitRecord>`；缓存不得只按 symbol 共享。
- `getSymbolRiskLimit()` 是同步读缓存：未命中返回 `tiers.source: "missing"`、`tiers.stale: true`、`tiers.items: []`，不得发起 lazy 单 symbol REST 请求。
- 账户注册或 client 启动后，`RiskLimitManagerImpl` 必须调度账户级后台 worker；worker 对到期账户调用 `fetchRiskLimits({ accountId })` 全量刷新并批量写入该账户 symbol cache。
- 账户级后台刷新周期由 `CreateClientOptions.riskLimit.refreshIntervalMs` 控制，默认 5 分钟；这是 RiskLimitManager 的 manager 级策略，和 `CreateClientOptions.fee.refreshIntervalMs` 保持同一配置模型。
- `fetchSymbolRiskLimit()` / `fetchRiskLimits()` 是显式 REST 刷新，成功后写入 `tiers` facet。
- `setSymbolLeverage()` 成功后只写入 `leverage.lastSet` 和 `updatedAt`，不得把旧的 `tiers.stale` 改成 `false`。
- `leverage.lastSet` 只表示 SDK 最近一次 set leverage 成功响应，不代表账户真实当前杠杆；真实当前杠杆继续由 `AccountManager.position.leverage` 维护。
- 凭证更新必须 bump account generation，并把该账户已有 `tiers` 降级为 missing/stale，旧 in-flight risk limit 结果不得写回。
- 账户级 full refresh 的 in-flight 去重必须同时匹配 account generation 和 client runGeneration；凭证更新或 client restart 后，新的显式 `fetchRiskLimits()` 必须发起新请求，不能复用旧 generation 的 in-flight promise。
- 账户移除必须删除该账户全部 risk limit records。
- public decimal 输出必须是 canonical decimal string；adapter raw 层可提前 canonical，manager 出口仍必须 canonical。
- Binance PAPI UM endpoints:
  - `GET /papi/v1/um/leverageBracket`，request weight 1。
  - `POST /papi/v1/um/leverage`，request weight 1，`leverage` 为 1 到 125 的整数。
  - Binance `notionalCoef` 必须映射为 `snapshot.tiers.notionalCoefficient`，不能丢弃。
- Binance adapter 出站 symbol 必须复用 `toUsdmVenueIdForCommand()`；入站全量 risk limit 结果里仍无法映射的 venue symbol 不得写入主缓存，应复用 catalog miss report 机制。

### 4. Validation & Error Matrix

| 场景 | 行为 |
|---|---|
| client 未 started 时显式 fetch / set | `CLIENT_NOT_STARTED` |
| 未注册 accountId | `ACCOUNT_NOT_FOUND` |
| 缺 private credentials | `CREDENTIALS_MISSING` |
| adapter 未实现 risk limit 查询 / set leverage | `VENUE_NOT_SUPPORTED` |
| leverage 非整数、小于 1、或大于 125 | `RISK_LIMIT_INPUT_INVALID`，不得发远端请求 |
| risk limit REST / parse / venue error | manager 包装为 `RISK_LIMIT_FETCH_FAILED`，保留 `cause`、`details.transport`、`details.venueError` |
| set leverage REST / parse / venue error | manager 包装为 `LEVERAGE_SET_FAILED`，保留 `cause`、`details.transport`、`details.venueError` |
| 设置杠杆成功但 tier 已 stale | `leverage.lastSet` 更新，`tiers.stale` 保持原值 |
| 凭证更新期间旧请求完成 | generation check 丢弃旧结果；凭证更新后的显式 fetch 不等待旧请求，必须用新 generation 发起请求 |

### 5. Good / Base / Bad Cases

Good:

```ts
const risk = await client.riskLimit.fetchSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

if (risk.tiers.source === "venue" && !risk.tiers.stale) {
  // 用 risk.tiers.items / maxInitialLeverage 判断交易所硬限制
}

const leverage = await client.riskLimit.setSymbolLeverage({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  leverage: "4",
});
```

Base:

```ts
const cached = client.riskLimit.getSymbolRiskLimit({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

if (cached.tiers.source === "missing" || cached.tiers.stale) {
  // 调用方决定是否等待 explicit fetch；get 不阻塞也不发请求
}
```

Bad:

```ts
// 错误：把最近一次 SDK set leverage 结果当成账户真实当前杠杆
const currentLeverage = snapshot.leverage.lastSet?.leverage;
```

原因：账户真实当前杠杆仍以 `AccountManager.position.leverage` 为准，`lastSet` 只是本 SDK 调用成功回包。

### 6. Tests Required

修改 risk limit 相关 contract 时至少执行：

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- public `client.riskLimit` 从根入口可用，类型从 `src/types/index.ts` 导出。
- get 未命中返回 missing/stale 空 facet，且不触发单 symbol REST 请求。
- 账户注册 / client 启动后默认触发账户级 full refresh；后台 refresh 通过 `fetchRiskLimits()` 批量写入缓存。
- explicit fetch 写入 tier cache，且 `notionalCoefficient` 保留。
- set leverage 成功只更新 `leverage.lastSet`，不刷新 `tiers.stale`。
- leverage 非整数、低于 1、高于 125 都本地失败且不发 REST。
- `accountId + symbol` 缓存隔离、账户移除清理、凭证更新防旧结果写回，且凭证更新后的显式 full fetch 不复用旧 in-flight。
- Binance adapter 映射 leverage bracket / set leverage，并断言 PAPI request-weight plan 为 1。
- unsupported venue 和缺凭证场景返回稳定 `AcexError`。

### 7. Wrong vs Correct

#### Wrong

```ts
record.tiers.stale = false;
record.leverage.lastSet = update;
```

问题：设置杠杆成功不代表 leverage bracket / notional tier 数据被刷新。

#### Correct

```ts
record.leverage = { lastSet: update };
record.updatedAt = now;
// 保留 record.tiers 原状态
```

效果：下游可以独立判断 tier freshness 和最近一次 leverage 设置结果。
