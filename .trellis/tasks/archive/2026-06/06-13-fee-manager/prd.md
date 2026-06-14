# FeeManager 手续费费率维护

## Goal

新增独立 `FeeManager`，由 SDK 内部按账号维护 symbol 手续费费率。下游通过 `client.fee.subscribe()` 声明关注范围，也可以直接 `client.fee.getSymbolFeeRate()` 同步读取本地值；未维护或未读取到真实值的 symbol 自动纳入维护集合并返回默认费率。Binance 这类缺少全量手续费接口的 venue 由 SDK 内部低频、串行地按 symbol 补齐真实费率。

## What I Already Know

* 用户目标：
  * 提供 `client.fee` manager。
  * 下游先用 `client.fee.subscribe()` 订阅关注 symbols，和其他 manager 的订阅/读取模式一致。
  * 如果 `get` 的 symbol 不在维护集合里，不抛“未维护”错误，自动增量加入维护集合。
  * 多次 `subscribe()` 是增量维护，不能重置已有集合。
  * Binance 因缺少全量手续费接口，SDK 内部降频慢慢读取。
  * 未读取到真实手续费时使用默认值。
  * 默认费率按不同 `MarketType` 区分，可参考 CCXT。
  * 上游初始化时可覆盖刷新时间，默认 24h。
  * 现有 `client.order.getSymbolFeeRate()` 设计不合理，本任务直接删除旧 public API，不保留兼容层。
* 现有代码事实：
  * 上一任务已提交 `client.order.getSymbolFeeRate()`，底层链路为 `ClientContext.fetchSymbolFeeRate()` -> `PrivateUserDataAdapter.fetchSymbolFeeRate()`。
  * 当前 Binance adapter 只实现 PAPI UM 单 symbol 接口 `GET /papi/v1/um/commissionRate`，对应本任务中的 Binance `swap` 真实远端刷新。
  * `MarketType` 当前为 `spot | swap | future`。
  * public 数值输出必须是 canonical decimal string。
  * manager 状态应落在 `src/managers/*`，public types 落在 `src/types/*`，runtime 只做编排，manager 通过 `ClientContext` 访问 runtime 服务。

## Research References

* [`research/binance-fee-defaults.md`](research/binance-fee-defaults.md) - Binance 默认费率按 CCXT metadata 收敛为 spot `0.001/0.001`、swap `0.0002/0.0005`、future `0.0001/0.0005`。

## Product Decisions

### Public API

本任务新增 `src/types/fee.ts`，并从 `src/types/index.ts` 导出。`AcexClient` 增加 `readonly fee: FeeManager`。

```ts
interface FeeManager {
  subscribe(input: SubscribeFeeRatesInput): Promise<void>;
  unsubscribe(input: UnsubscribeFeeRatesInput): Promise<void>;
  getSymbolFeeRate(input: GetSymbolFeeRateInput): SymbolFeeRate;
  getSymbolFeeRates(accountId?: string): SymbolFeeRate[];
  fetchSymbolFeeRate(input: GetSymbolFeeRateInput): Promise<SymbolFeeRate>;
}

interface SubscribeFeeRatesInput {
  accountId: string;
  symbols: string[];
}

interface UnsubscribeFeeRatesInput {
  accountId: string;
  symbols?: string[];
}

interface GetSymbolFeeRateInput {
  accountId: string;
  symbol: string;
}

interface SymbolFeeRate {
  accountId: string;
  venue: Venue;
  symbol: string;
  marketType: MarketType;
  maker: string;
  taker: string;
  source: "default" | "venue";
  receivedAt: number;
}
```

语义：

* `getSymbolFeeRate()` 是同步本地读取，不直接发起网络请求。
* `getSymbolFeeRate()` 对未维护的 `accountId + symbol` 自动创建维护记录并入队后台刷新；本次立即返回默认费率。
* `subscribe()` 多次调用是增量维护：新 symbols 加入维护集合，已存在 symbols 保留缓存、刷新状态和下一次刷新计划。
* `unsubscribe({ accountId, symbols })` 只移除指定 symbols；`symbols` 省略表示移除该账号全部 fee 维护记录；空数组为 no-op。
* `getSymbolFeeRates(accountId)` 返回指定账号当前维护集合的本地快照；`accountId` 省略时返回全部账号维护集合。返回数组按 `accountId`、`venue`、`symbol` 稳定排序。
* `getSymbolFeeRates(accountId)` 在传入的账号不存在时抛 `ACCOUNT_NOT_FOUND`；不传 `accountId` 时不校验账号列表，只返回当前维护集合。
* `fetchSymbolFeeRate()` 是即时远端查询选项：它会走同一套 FeeManager 串行/限速 gate，成功后写回同一份 cache，设置 `source: "venue"`，重置 `nextRefreshAt`，并把 key 纳入维护集合。
* public `fetchSymbolFeeRate()` 优先级高于后台周期队列，但不会绕过同一 venue 的 fee 请求互斥，因此不会与后台刷新并发打同一个 venue 的 fee REST。
* 返回的 `maker` / `taker` 是 canonical decimal string。

### Client Options

`CreateClientOptions` 增加 `fee`：

```ts
interface FeeRuntimeOptions {
  refreshIntervalMs?: number;
  defaultRates?: Partial<Record<Venue, Partial<Record<MarketType, FeeRatePair>>>>;
}

interface FeeRatePair {
  maker: string;
  taker: string;
}
```

语义：

* `refreshIntervalMs` 控制每个已维护 `accountId + symbol` 的目标刷新周期。
* 默认 `refreshIntervalMs = 24 * 60 * 60 * 1000`。
* `defaultRates` 可按 `Venue + MarketType` 覆盖默认 maker / taker。
* 本任务不暴露 `maxRefreshConcurrency` 或 `refreshRequestSpacingMs`，避免下游误配导致 Binance fee 查询突发。

### 默认费率

默认费率按 `Venue + MarketType` 解析，解析顺序：

1. `CreateClientOptions.fee.defaultRates[venue][marketType]`
2. SDK 内置 venue-specific 默认值
3. SDK 内置 generic market-type 默认值

Binance 内置默认值：

| MarketType | maker | taker |
|---|---:|---:|
| `spot` | `0.001` | `0.001` |
| `swap` | `0.0002` | `0.0005` |
| `future` | `0.0001` | `0.0005` |

Generic fallback：

| MarketType | maker | taker |
|---|---:|---:|
| `spot` | `0.001` | `0.001` |
| `swap` | `0.0002` | `0.0005` |
| `future` | `0.0002` | `0.0005` |

默认值只是兜底值，不代表账号真实 VIP 等级、BNB 折扣、返佣或活动优惠。真实费率以 venue 私有接口成功返回值为准。

### Market Type Resolution

FeeManager 需要为默认值选择 `marketType`：

* 如果 market catalog 已加载且能通过 `venue + symbol` 找到 `MarketDefinition`，使用 `MarketDefinition.type`。
* 如果 catalog 未加载或找不到 symbol，先按用户确认的兜底策略使用 `marketType: "swap"`。
* `getSymbolFeeRate()` 必须保持同步，因此不能为了识别 market type 去触发异步 catalog load。
* 如果后续 `subscribe()`、`fetchSymbolFeeRate()` 或其他内部路径拿到了更准确的 market type，维护记录可以更新 `marketType`；当仍无真实 venue 值时，后续 `get` 应返回新 market type 对应默认费率。
* 未知 symbol 不因为 catalog miss 被拒绝。显式远端 `fetchSymbolFeeRate()` 可能因为 adapter 无法映射 symbol 而抛 `FEE_RATE_FETCH_FAILED`。

### Binance 真实刷新范围

本任务 MVP 的 Binance 真实远端刷新范围已确认只覆盖 `swap`：

* 支持：`venue: "binance"` 且 `marketType: "swap"`，使用现有 PAPI UM `GET /papi/v1/um/commissionRate`。
* 暂不支持：Binance `spot` 和 `future` 真实远端刷新。
* 对暂不支持真实远端刷新的 market type：
  * `getSymbolFeeRate()` 和后台维护返回/保留默认值，不抛错。
  * `subscribe()` 可以维护这些 symbols，但不会把它们加入远端刷新队列。
  * `fetchSymbolFeeRate()` 抛 `VENUE_NOT_SUPPORTED`。

后续如果实现 Binance spot `GET /api/v3/account/commission` 或 coin-margined futures fee 查询，只需要扩展 adapter 和 FeeManager 的 market type support matrix，不改变 public API。

### Binance 内部低频扫描

Binance fee 维护必须同时满足“串行”和“低频”：

* FeeManager 内部维护一个后台队列，按 `nextRefreshAt` 升序处理。
* 同一个 `accountId + symbol` 在队列中去重。
* 对 Binance，所有 fee REST 请求通过同一个 request gate；同一时刻最多一个 Binance fee REST 请求在飞。
* 后台队列和 public `fetchSymbolFeeRate()` 共用同一个 Binance fee request gate，避免手动 fetch 与后台 worker 并发。
* 内部固定最小请求间隔：`DEFAULT_FEE_REFRESH_REQUEST_SPACING_MS = 3000`。
* 失败后不立即紧密重试；使用 `min(refreshIntervalMs, DEFAULT_FEE_REFRESH_RETRY_DELAY_MS)` 重新安排，`DEFAULT_FEE_REFRESH_RETRY_DELAY_MS = 60_000`。
* adapter 层现有 rate limiter 仍然生效；FeeManager gate 是额外保护，用来避免 fee manager 自身制造突发。
* 启动、订阅或 get 新 symbol 时不批量突发请求所有 symbols，而是按队列慢慢补齐。

### Cache 与生命周期

* cache key 为 `accountId + symbol`，真实费率是账号级，不是全局 symbol 级。
* `source: "default"` 表示当前值来自默认费率；`source: "venue"` 表示来自交易所私有接口。
* `receivedAt` 对默认值表示记录创建、market type 更新或凭证变更降级的本地时间；对真实值表示 venue 响应接收时间。
* 周期刷新成功后更新 `maker`、`taker`、`source`、`receivedAt` 和 `nextRefreshAt`。
* 周期刷新失败时：
  * 若已有 `source: "venue"`，保留旧真实值。
  * 若无真实值，继续返回默认值。
  * 后台错误不抛给任意业务调用方，通过 `client.events.errors()` 发布 `source: "fee"` 的 runtime error。
* `stop()` 停止 fee timer / worker，不再安排新刷新；已在飞请求返回后如果 client 已停止则忽略 cache 写入。
* `removeAccount()` 清理该账号全部 fee cache、队列项和 in-flight apply 权限。
* `onCredentialsUpdated()` 必须让该账号已有 `source: "venue"` 的 cache 失效并降级为默认值，然后把支持远端刷新的维护项重新入队。原因是 fee 是账号/凭证级，旧 API key 的真实费率不能沿用到新凭证。
* in-flight 响应只能在 account generation 未变化、record 仍存在且 symbol 仍被维护时写入 cache；否则忽略写入。public `fetchSymbolFeeRate()` 仍把本次远端结果返回给调用方。

### Error Semantics

本任务删除 order 领域的 fee public API，因此错误码也迁到 fee 领域：

* 新增 `FEE_RATE_FETCH_FAILED`。
* 删除 `ORDER_FEE_RATE_FETCH_FAILED`。
* adapter/internal 层仍只抛底层错误；public 错误由 FeeManager/runtime 包装为 `AcexError`，保留 `cause` 和 `details`。

错误矩阵：

| 场景 | `subscribe()` | `getSymbolFeeRate()` | `fetchSymbolFeeRate()` | 后台 worker |
|---|---|---|---|---|
| client 未 started | 抛 `CLIENT_NOT_STARTED` | 可本地返回/创建维护记录；实际刷新等 start 后执行 | 抛 `CLIENT_NOT_STARTED` | 不运行 |
| account 不存在 | 抛 `ACCOUNT_NOT_FOUND` | 抛 `ACCOUNT_NOT_FOUND` | 抛 `ACCOUNT_NOT_FOUND` | 相关记录应已被清理 |
| credentials 缺失 | 可维护并返回默认值 | 返回默认值 | 抛 `CREDENTIALS_MISSING` | 保留默认/旧值并发布 `CREDENTIALS_MISSING` runtime error，按 retry delay 重排 |
| venue 不支持 fee 远端查询 | 可维护默认值 | 返回默认值 | 抛 `VENUE_NOT_SUPPORTED` | 不入远端队列 |
| marketType 不支持远端查询 | 可维护默认值 | 返回默认值 | 抛 `VENUE_NOT_SUPPORTED` | 不入远端队列 |
| catalog miss / unknown symbol | 接受并用 `swap` 默认值 | 接受并用 `swap` 默认值 | adapter 映射失败时抛 `FEE_RATE_FETCH_FAILED` | 失败后发布 `FEE_RATE_FETCH_FAILED` runtime error |
| REST/parse/network 失败 | 不适用 | 不适用 | 抛 `FEE_RATE_FETCH_FAILED` | 保留旧值/默认值，发布 `FEE_RATE_FETCH_FAILED` runtime error |
| unsubscribe/remove/stop 后 in-flight 返回 | 不适用 | 不适用 | 返回给调用方；cache 写入按 generation/record 检查决定 | 忽略 cache 写入且不重排 |

## Requirements

* 新增 public `FeeManager`，挂到 `AcexClient.fee`。
* 新增 `src/types/fee.ts`，迁入 `GetSymbolFeeRateInput`、`SymbolFeeRate` 等 fee public types。
* `CreateClientOptions` 增加 `fee.refreshIntervalMs` 和 `fee.defaultRates`。
* FeeManager 按 `accountId + symbol` 持有 cache 和维护状态。
* `client.fee.subscribe()` 为关注 symbols 建立维护记录，多次调用增量维护，不重置已有记录。
* `client.fee.unsubscribe()` 支持按 symbols 移除，也支持省略 symbols 移除账号下全部 fee 记录。
* `client.fee.getSymbolFeeRate()` 同步读取本地值，不触发网络请求。
* `client.fee.getSymbolFeeRate()` 对未维护 symbol 自动加入维护集合并后台排队。
* 未读取到真实 fee 时，`getSymbolFeeRate()` 返回按 `Venue + MarketType` 匹配的默认 maker / taker，`source: "default"`。
* `client.fee.fetchSymbolFeeRate()` 提供即时远端查询能力，成功后更新同一份 cache，后续 `get` 返回 `source: "venue"` 的真实值。
* `fetchSymbolFeeRate()` 和后台 worker 共用同一 venue request gate，不能互相并发。
* Binance 后台刷新必须单 worker / 单 request gate 串行，且内部最小请求间隔 3000ms。
* 默认刷新周期为 24h，可通过 `CreateClientOptions.fee.refreshIntervalMs` 覆盖。
* Binance MVP 只对 `swap` 做真实远端刷新；`spot` / `future` 保留默认值，显式 fetch 抛 `VENUE_NOT_SUPPORTED`。
* 凭证更新后，账号下已有真实 fee cache 降级为默认值并重新排队。
* `stop()` 停止 fee 刷新 timer / queue；`removeAccount()` 清理该账号 fee cache 和队列项。
* 后台刷新失败不抛给业务调用方，通过 `client.events.errors()` 发布 `source: "fee"` 的 `AcexError`。
* `AcexInternalError.source` 增加 `"fee"`。
* 删除 `client.order.getSymbolFeeRate()` public API、实现、文档和测试；fee rate 领域逻辑统一迁移到 `FeeManager`。
* 删除或替换 `.changeset/symbol-fee-rate.md`，新增 breaking changeset 描述从 `client.order` 迁移到 `client.fee`。

## Acceptance Criteria

* [ ] `client.fee` 存在，类型从根入口导出。
* [ ] `client.fee.subscribe({ accountId, symbols })` 为关注 symbols 建立维护记录。
* [ ] 多次调用 `client.fee.subscribe()` 会增量添加新 symbols，不删除或重置既有维护项。
* [ ] `client.fee.getSymbolFeeRate({ accountId, symbol })` 同步返回 `SymbolFeeRate`。
* [ ] 未维护 symbol 调用 `getSymbolFeeRate()` 时自动加入维护集合并入队后台刷新。
* [ ] 未读取到真实 fee 时返回对应 `Venue + MarketType` 默认 maker / taker，且 `source === "default"`。
* [ ] catalog miss 时 `marketType` 兜底为 `"swap"`，不阻塞同步 get。
* [ ] Binance 默认费率覆盖 spot、swap、future；调用方可用 `CreateClientOptions.fee.defaultRates` 覆盖。
* [ ] `client.fee.fetchSymbolFeeRate()` 立即远端查询单个 symbol，成功后更新内部 cache，后续 `getSymbolFeeRate()` 返回同一份真实值且 `source === "venue"`。
* [ ] `fetchSymbolFeeRate()` 成功后重置该 key 的下一次后台刷新时间，不会马上被后台队列重复请求。
* [ ] Binance `swap` fee 读取走 PAPI UM `commissionRate`，成功后缓存更新为真实值。
* [ ] Binance `spot` / `future` 的 `get` 返回默认值，显式 `fetch` 抛 `VENUE_NOT_SUPPORTED`。
* [ ] 后台 worker 与 public `fetchSymbolFeeRate()` 对 Binance 同一时刻最多一个 fee REST 在飞。
* [ ] 后台 worker 对 Binance 连续请求间隔不小于 3000ms。
* [ ] 周期刷新失败保留旧真实值；无旧真实值时继续返回默认值，并发布 `source: "fee"` runtime error。
* [ ] 凭证更新后旧 `source: "venue"` 值不再返回，先降级默认值，再重新刷新。
* [ ] `unsubscribe()`、`removeAccount()`、`stop()` 后 in-flight 响应不会写回已失效 cache。
* [ ] `client.fee.getSymbolFeeRate()` 遇到不存在账号抛 `ACCOUNT_NOT_FOUND`。
* [ ] `client.fee.fetchSymbolFeeRate()` 遇到远端失败抛 `FEE_RATE_FETCH_FAILED`，保留 `cause`、`details.venue/accountId/symbol`、可用 `venueError/transport`。
* [ ] `client.order.getSymbolFeeRate()` 从 public API、实现、文档和测试中删除。
* [ ] `docs/api.md` 只说明 `client.fee` 的默认值、真实值来源、刷新周期、Binance 低频补齐和 breaking change。
* [ ] changeset 说明删除旧 order API、新增 `client.fee` API 和错误码变化。
* [ ] `bun run lint`、`bun run type-check`、`bun run test` 通过。

## Definition of Done

* PRD 已确认，没有阻塞性开放问题。
* public types、manager、runtime wiring、docs、changeset、测试全部更新。
* 单元/集成测试覆盖默认值、订阅增量、lazy get、fetch 写回、Binance 串行限速、凭证更新、unsubscribe/remove/stop in-flight 行为。
* lint、type-check、test 全部通过。

## Technical Approach

* 新增 `src/managers/fee-manager.ts`，由 FeeManager 持有 fee records、queue、timer、venue request gate 和 account generation。
* 新增 `src/types/fee.ts`，`src/types/index.ts` 导出 fee types，`src/types/client.ts` 给 `AcexClient` 增加 `fee`。
* `src/client/runtime.ts` 实例化 `FeeManagerImpl`，在 start/stop/removeAccount/updateCredentials 生命周期中调用 FeeManager。
* `ClientContext` 保留或迁移现有内部 `fetchSymbolFeeRate()` helper 给 FeeManager 使用，但 `OrderManager` 不再调用。
* `ClientContext` 增加只读 market lookup helper，例如 `getMarketDefinition(venue, symbol)`，FeeManager 用它同步获取已加载 catalog 的 market type；不得直接依赖 `MarketManagerImpl` 具体类。
* `src/types/order.ts` 和 `src/managers/order-manager.ts` 删除 fee public types、方法和错误包装。
* `src/errors.ts` 增加 `FEE_RATE_FETCH_FAILED`，移除 `ORDER_FEE_RATE_FETCH_FAILED`。
* `src/types/shared.ts` 的 `AcexInternalError.source` 增加 `"fee"`。
* Binance adapter 的 PAPI UM `fetchSymbolFeeRate()` 可继续复用；本任务不新增 spot/future adapter。

## Decision (ADR-lite)

**Context**: 手续费是账号级数据，既需要下游同步读取，也需要 SDK 内部异步补齐。上一版把即时查询放在 `OrderManager`，导致领域归属不清，并且无法承载默认值、订阅集合、周期刷新和 Binance 低频扫描。

**Decision**: 新增独立 `FeeManager`。下游通过 `client.fee.subscribe()` / `client.fee.getSymbolFeeRate()` / `client.fee.fetchSymbolFeeRate()` 使用；删除 `client.order.getSymbolFeeRate()`。FeeManager 本地永远返回一个 `SymbolFeeRate` 或明确账号错误，未获取真实值时使用 `Venue + MarketType` 默认值。Binance 真实刷新在 MVP 中只覆盖 swap，并通过单 request gate + 3000ms spacing 低频串行执行。

**Consequences**: 下游需要从 `client.order.getSymbolFeeRate()` 迁移到 `client.fee.fetchSymbolFeeRate()` 或 `client.fee.getSymbolFeeRate()`。SDK 内部多一个后台维护 manager，但领域边界更清晰；未来补 spot/future 或其他 venue 时扩展 adapter support matrix 即可，不需要改 public API。

## Out of Scope

* 不做“已发生成交手续费汇总”；该能力继续由 order trades 下游聚合。
* 不新增 Binance spot / coin-margined futures fee adapter。
* 不新增其他交易所 fee adapter。
* 不保证启动后立即拥有所有 symbol 的真实费率；真实费率是后台逐步补齐。
* 不暴露刷新并发、请求间隔、手动 refresh-all 等调度旋钮。
* 不新增 fee 专属事件流或 public fee health snapshot；后台错误通过现有 `client.events.errors()` 暴露。

## Open Questions

当前无阻塞开放问题。用户已确认本任务只做 Binance `swap` 真实远端刷新，`spot` / `future` 先返回默认值并在显式 `fetch` 时抛 `VENUE_NOT_SUPPORTED`。

## Technical Notes

* 相关规范：`.trellis/spec/backend/code-organization.md`、`type-safety.md`、`error-handling.md`。
* 现有旧 API：
  * `src/types/order.ts`：`GetSymbolFeeRateInput`、`SymbolFeeRate`、`OrderManager.getSymbolFeeRate`
  * `src/managers/order-manager.ts`：旧 `getSymbolFeeRate()` 实现
  * `src/client/runtime.ts`：内部 adapter 分派 helper
  * `src/adapters/binance/private-adapter.ts`：PAPI UM `fetchSymbolFeeRate()`
  * `docs/api.md`、`.changeset/symbol-fee-rate.md`、`tests/integration/order.test.ts`
* 预计新增/修改：
  * 新增 `src/types/fee.ts`
  * 新增 `src/managers/fee-manager.ts`
  * 修改 `src/types/client.ts`、`src/types/shared.ts`、`src/types/index.ts`
  * 修改 `src/client/context.ts`、`src/client/runtime.ts`
  * 清理 `src/types/order.ts`、`src/managers/order-manager.ts`
  * 更新 tests、docs、changeset
