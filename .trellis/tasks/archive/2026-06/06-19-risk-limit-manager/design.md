# RiskLimitManager Design

## Architecture

新增 `RiskLimitManager`，作为与 `MarketManager`、`AccountManager`、`OrderManager`、`FeeManager` 同级的领域 manager：

```text
src/types/risk-limit.ts          public contract
src/managers/risk-limit-manager.ts
src/adapters/types.ts           RawRiskLimit* / adapter SPI
src/adapters/binance/private-adapter.ts
src/client/context.ts           runtime 调 adapter 的内部方法
src/client/runtime.ts           manager 挂载与 adapter 分派
```

职责边界：

- `RiskLimitManager` 持有账户级 risk limit 缓存、返回 public snapshot、包装 public error。
- `PrivateUserDataAdapter` 增加可选 signed REST 能力，封装 Binance endpoint、symbol mapping、响应解析。
- `AccountManager` 继续持有仓位和当前 position leverage，不迁移仓位职责。
- `FeeManager` 继续只处理手续费。
- `OrderManager` 首版不自动调用 risk preflight。

## Public API

建议新增 `client.riskLimit`：

```ts
interface RiskLimitManager {
  getSymbolRiskLimit(input: GetSymbolRiskLimitInput): SymbolRiskLimitSnapshot;
  getSymbolRiskLimits(accountId?: string): SymbolRiskLimitSnapshot[];
  fetchSymbolRiskLimit(input: GetSymbolRiskLimitInput): Promise<SymbolRiskLimitSnapshot>;
  fetchRiskLimits(input: FetchRiskLimitsInput): Promise<SymbolRiskLimitSnapshot[]>;
  setSymbolLeverage(input: SetSymbolLeverageInput): Promise<SymbolLeverageUpdate>;
}
```

输入：

```ts
interface GetSymbolRiskLimitInput {
  accountId: string;
  symbol: string;
}

interface FetchRiskLimitsInput {
  accountId: string;
}

interface SetSymbolLeverageInput {
  accountId: string;
  symbol: string;
  leverage: string;
}
```

输出：

```ts
interface RiskLimitTier {
  tier: number;
  initialLeverage: string;
  notionalFloor?: string;
  notionalCap?: string;
  maintenanceMarginRatio?: string;
  cumulativeMaintenanceAmount?: string;
}

interface SymbolLeverageUpdate {
  accountId: string;
  venue: Venue;
  symbol: string;
  leverage: string;
  maxNotionalValue?: string;
  receivedAt: number;
}

interface RiskLimitTiersFacet {
  source: "missing" | "venue";
  stale: boolean;
  receivedAt?: number;
  items: RiskLimitTier[];
  maxInitialLeverage?: string;
  notionalCoefficient?: string;
}

interface RiskLimitLeverageFacet {
  lastSet?: SymbolLeverageUpdate;
}

interface SymbolRiskLimitSnapshot {
  accountId: string;
  venue: Venue;
  symbol: string;
  tiers: RiskLimitTiersFacet;
  leverage: RiskLimitLeverageFacet;
  updatedAt: number;
}
```

说明：

- `getSymbolRiskLimit()` 是同步读缓存；未命中返回 `tiers.source: "missing"`、`tiers.stale: true`、`tiers.items: []` 的快照，不触发 lazy 单 symbol 请求。
- `fetchSymbolRiskLimit()` 等待单 symbol REST 刷新。
- `fetchRiskLimits()` 等待账户全量 REST 刷新。
- `setSymbolLeverage()` 等待交易所设置完成，并返回本次交易所响应里的 `maxNotionalValue`。
- public 数值字段均使用 canonical decimal string。
- `leverage.lastSet` 只表示 SDK 最近一次 `setSymbolLeverage()` 的成功结果，不代表账户真实当前杠杆；真实当前杠杆仍以 `AccountManager.position.leverage` 为准。
- `tiers.stale` 与 `leverage.lastSet` 独立：设置杠杆成功不得把旧 tier 标记为 fresh。

## Adapter Contract

在 `src/adapters/types.ts` 增加标准化 raw 类型：

```ts
interface RawRiskLimitTier {
  tier: number;
  initialLeverage: string;
  notionalFloor?: string;
  notionalCap?: string;
  maintenanceMarginRatio?: string;
  cumulativeMaintenanceAmount?: string;
}

interface RawSymbolRiskLimit {
  symbol: string;
  tiers: RawRiskLimitTier[];
  notionalCoefficient?: string;
  receivedAt: number;
}

interface RawSymbolLeverageUpdate {
  symbol: string;
  leverage: string;
  maxNotionalValue?: string;
  receivedAt: number;
}
```

Raw 层使用 `tiers` 表示 adapter 产出的 tier 数组；public snapshot 使用 `snapshot.tiers.items`，避免出现 `snapshot.tiers.tiers` 这种重复命名。

`PrivateUserDataAdapter` 增加可选方法：

```ts
fetchSymbolRiskLimit?(
  credentials: AccountCredentials,
  request: FetchSymbolRiskLimitRequest,
  accountOptions?: Record<string, unknown>,
): Promise<RawSymbolRiskLimit>;

fetchRiskLimits?(
  credentials: AccountCredentials,
  request: FetchRiskLimitsRequest,
  accountOptions?: Record<string, unknown>,
): Promise<RawSymbolRiskLimit[]>;

setSymbolLeverage?(
  credentials: AccountCredentials,
  request: SetSymbolLeverageRequest,
  accountOptions?: Record<string, unknown>,
): Promise<RawSymbolLeverageUpdate>;
```

Runtime 通过 `ClientContext` 增加内部方法，负责查账户、校验凭证、找到 private adapter、处理 unsupported，然后调用 adapter：

```ts
fetchSymbolRiskLimit(input: GetSymbolRiskLimitInput): Promise<RawSymbolRiskLimit>;
fetchRiskLimits(input: FetchRiskLimitsInput): Promise<RawSymbolRiskLimit[]>;
setSymbolLeverage(input: SetSymbolLeverageInput): Promise<RawSymbolLeverageUpdate>;
```

## Binance PAPI UM Mapping

首版仅支持当前 SDK 已接入的 Binance PAPI UM。

REST endpoints：

```text
GET  /papi/v1/um/leverageBracket
POST /papi/v1/um/leverage
```

官方文档核验日期：2026-06-19。

- `GET /papi/v1/um/leverageBracket`：Portfolio Margin UM Notional and Leverage Brackets，request weight 1。
- `POST /papi/v1/um/leverage`：Change UM Initial Leverage，request weight 1。

请求规则：

- 单 symbol fetch：先用 `marketCatalog.toVenueId(BINANCE_PRIVATE_SYMBOL_FAMILY, symbol)` 映射 unified symbol，再传 `symbol` 参数。
- 全量 fetch：不传 `symbol`，返回所有 symbol tier；对每个 venue symbol 做 `toUnified` 映射，miss 的记录不写主缓存，并按现有 symbol mapping miss 机制上报 runtime error 或在 adapter 内复用 catalog refresh inline remap。
- 设置杠杆：先映射 venue symbol，传 `symbol + leverage`。
- 全部 signed request 复用 `signedRequest()`、`SINGLE_ATTEMPT_IDEMPOTENT_POLICY`、签名 clock、`accountOptions` 和 rate limiter。

响应映射：

- Binance 响应里的 `brackets[]` -> SDK raw/public 的 `tiers[]` / `tiers.items[]`
- Binance `bracket` -> `tier`
- Binance `initialLeverage` -> `initialLeverage`
- Binance `notionalFloor` / `notionalCap` -> 同名 public normalized 字段
- Binance `maintMarginRatio` -> `maintenanceMarginRatio`
- Binance `cum` -> `cumulativeMaintenanceAmount`
- Binance `maxNotionalValue` -> `maxNotionalValue`
- Binance `notionalCoef` -> `notionalCoefficient`。该字段是账户 / symbol 维度的 tier 调整信号，首版必须保留，不能丢弃。

## Cache Semantics

缓存 key：

```text
JSON.stringify([accountId, symbol])
```

Record：

```ts
interface RiskLimitRecord {
  accountId: string;
  venue: Venue;
  symbol: string;
  tiers: RiskLimitTiersFacet;
  leverage: RiskLimitLeverageFacet;
  updatedAt: number;
  generation: number;
  nextRefreshAt?: number;
}
```

刷新策略首版按账户级 full refresh 维护缓存：

- 默认刷新周期是 5 分钟；可通过 `CreateClientOptions.riskLimit.refreshIntervalMs` 覆盖。该字段是 `RiskLimitManager` 的 manager 级缓存策略，和 `CreateClientOptions.fee.refreshIntervalMs` 同层；`account.venues.<venue>` 只承载私有连接、签名、stream、reconcile 等 venue runtime 细节。
- `onAccountRegistered()` / `onClientStarted()` 为账户创建 refresh state，并在 client started 后调度后台 worker。
- 后台 worker 每次对一个到期账户调用 `fetchRiskLimits({ accountId })`，成功后批量写入该账户下所有返回 symbol 的 tier cache。
- `getSymbolRiskLimit()` 只创建 / 返回 missing record 并刷新本地 stale 标记，不发起网络请求；下游读路径不得靠 lazy get 触发单 symbol 请求。
- 显式 `fetchSymbolRiskLimit()` 立即请求并写入缓存。
- 显式 `fetchRiskLimits()` 全量请求并批量写入缓存。
- `setSymbolLeverage()` 成功后更新同 symbol record 的 `leverage.lastSet` 和 `updatedAt`，保留已有 `tiers` facet，且不得把旧 `tiers` 变 fresh。
- `onCredentialsUpdated()` 对该账户 venue 数据降级为 stale/missing 或提高 generation，让旧 in-flight 结果不能写回。
- `onAccountRemoved()` 清理该账户所有 records。
- `onClientStopping()` 清理 timers，防止后台刷新继续跑。

并发：

- 账户级后台 refresh 以 account state 的 in-flight promise 去重，避免同一账户同时多次全量请求。
- 全量 fetch 与显式单 symbol fetch 若并发，按 generation 和完成时间写入；凭证更新后的旧结果必须丢弃。
- 后台失败不覆盖已有 venue cache；后台错误统一通过 `publishRuntimeError("runtime", ...)` 发布，不新增 `AcexInternalError.source`。

## Error Model

新增 public error code：

```ts
"RISK_LIMIT_FETCH_FAILED"
"RISK_LIMIT_INPUT_INVALID"
"LEVERAGE_SET_FAILED"
```

错误包装：

- unsupported venue/method：`VENUE_NOT_SUPPORTED`
- 未启动：沿用 `CLIENT_NOT_STARTED`
- 未注册账户：沿用 `ACCOUNT_NOT_FOUND`
- 缺凭证：沿用 `CREDENTIALS_MISSING`
- leverage 输入不是整数、低于 1 或高于 125：`RISK_LIMIT_INPUT_INVALID`
- fetch 失败：`RISK_LIMIT_FETCH_FAILED`
- set leverage 失败：`LEVERAGE_SET_FAILED`

所有 manager 包装使用：

```ts
buildAcexErrorDetails({ venue, accountId, symbol }, error)
formatAcexErrorMessage(..., details)
```

adapter 不构造 `AcexError`。

## Venue Capabilities

首版可以不新增 public venue capability 字段，原因：

- 当前 `VenueCapabilities` 只覆盖 market/account/order 三类运行能力。
- risk limit 是新增 manager 能力；贸然在 `VenueCapabilities` 增加 `riskLimit` 会扩大 public surface。

如果实现阶段认为需要 capability，推荐新增：

```ts
interface VenueRiskLimitCapabilities {
  riskLimits: VenueCapabilitySupport;
  setLeverage: VenueCapabilitySupport;
}
```

但这会要求同步 venue-capabilities spec、docs 和 capability tests。首版建议通过 manager 方法的 `VENUE_NOT_SUPPORTED` 表达能力边界。

## Data Flow

单 symbol 查询：

```text
caller -> client.riskLimit.fetchSymbolRiskLimit()
  -> RiskLimitManager
  -> ClientContext.fetchSymbolRiskLimit()
  -> Runtime private adapter dispatch
  -> BinancePrivateAdapter GET /papi/v1/um/leverageBracket?symbol=BTCUSDT
  -> RawSymbolRiskLimit
  -> RiskLimitManager cache
  -> SymbolRiskLimitSnapshot
```

全量查询：

```text
caller -> client.riskLimit.fetchRiskLimits({ accountId })
  -> BinancePrivateAdapter GET /papi/v1/um/leverageBracket
  -> RawSymbolRiskLimit[]
  -> RiskLimitManager batch upsert
```

设置杠杆：

```text
caller -> client.riskLimit.setSymbolLeverage({ leverage: "4" })
  -> BinancePrivateAdapter POST /papi/v1/um/leverage
  -> RawSymbolLeverageUpdate
  -> RiskLimitManager upsert leverage.lastSet
```

`AccountManager.position.leverage` 更新路径保持不变：

```text
Binance ACCOUNT_CONFIG_UPDATE -> PrivateSubscriptionCoordinator -> AccountManager
```

## Compatibility

- 新增 `client.riskLimit` 是 additive public API。
- 新增 optional adapter methods 不破坏现有 adapters；Juplend 不实现这些方法。
- 不改变 `createOrder()` 行为。
- 不改变 `FeeManager`、`AccountManager`、`OrderManager` 的现有 public contract。

## Validation Plan

Unit tests：

- `RiskLimitManager` get 返回 missing/stale 且不触发 lazy 单 symbol 请求。
- 账户注册 / client 启动后默认触发账户级后台全量刷新，get 只读取该缓存。
- 显式 symbol fetch 写入 canonical cache。
- 全量 fetch 批量写入多个 symbol。
- set leverage 成功后更新 `leverage.lastSet`，且不刷新 `tiers.stale`。
- credentials update 让旧 in-flight 结果不能写回或缓存变 stale。
- account remove 清理缓存。
- unsupported venue / missing credentials / adapter failure 包装为预期 `AcexError`。

Adapter tests：

- Binance leverage tier 单 symbol 请求使用 unified->venue symbol 映射、signed query、返回统一 raw tiers。
- Binance leverage tier 全量请求不带 symbol，并映射多个 symbols。
- Binance set leverage 调 `POST /papi/v1/um/leverage`，返回 `leverage` 和 `maxNotionalValue`。
- venue error body 保留到 manager `details.venueError`。

Integration-style tests：

- `createClient()` 暴露 `client.riskLimit`。
- fake Binance support 增加 leverage tier / set leverage endpoints。
- 相关 public types 从根入口可导入。

Validation commands：

```bash
bun run lint
bun run type-check
bun run test tests/unit/risk-limit-manager.test.ts tests/unit/binance-private-adapter.test.ts
bun run test
```
