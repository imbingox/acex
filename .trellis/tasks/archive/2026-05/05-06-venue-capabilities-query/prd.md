# Venue Capabilities 查询

## Goal

为 SDK 增加公开的 venue capability 查询规划，让调用方能在调用前判断某个 venue 在当前 SDK 运行时是否支持行情、账户、订单等能力，例如是否支持下单、撤单、订单订阅、资金费率订阅，而不是只能通过调用后捕获 `VENUE_NOT_SUPPORTED` 判断。

## What I Already Know

* 当前 SDK 的 public `Venue` 包含 `binance`、`okx`、`bybit`、`gate`、`juplend`，但运行时支持不是等价的。
* `AcexClient` 当前只有 `market` / `account` / `order` / `events`、状态和账户生命周期 API，没有 `getVenueCapabilities()` 之类的公开查询入口。
* README 当前限制写明：market/order 运行时只支持 `binance`；account 支持 Binance PAPI UM 与 Juplend 只读账户；`okx` / `bybit` / `gate` 仅类型定义。
* `JuplendPrivateAdapter` 明确是只读：`createOrder` / `cancelOrder` / `cancelAllOrders` 均抛 `VENUE_NOT_SUPPORTED`。
* Binance order 第一版支持 `createOrder`、`cancelOrder`、`cancelAllOrders`，但 `createOrder` 仅支持 `limit` / `market`，`cancelAllOrders` 必须按 symbol，不支持账户级全撤。
* Funding rate 不是 venue 级单一能力，当前仅 Binance 永续 market 支持，spot/future 到具体 market 时可能不支持。

## Requirements (Evolving)

* 提供公开 API 查询某个 `Venue` 在当前 SDK 运行时支持的能力。
* 查询入口采用顶层 `AcexClient` API：
  * `client.getVenueCapabilities(venue)`
  * `client.listVenueCapabilities()`
* 查询结果必须表达“SDK 已实现能力”，不能只表达交易所理论能力。
* 第一版只做 venue 级能力查询，不做 symbol/market 级能力查询。
* venue 级能力需要表达是否有 market catalog、private account、order 命令、订单流等运行时实现。
* funding rate 这类依赖 market type 的能力在 venue 级用 `market_dependent` 表达，不展开到具体 symbol。
* 查询结果需要能回答最常见问题：某 venue 是否支持下单。
* 查询结果需要能解释“不支持”的原因，例如 `not_implemented`、`read_only`、`market_type_unsupported`、`sdk_reserved`。
* 能力字段应尽量稳定、可扩展，新增 venue 或新增 order type 时不需要破坏旧字段。

## Capability Draft

### 1. Venue Registry / Availability

用于回答“这个 venue 在 SDK 里处于什么状态”。

建议字段：

* `venue: Venue`
* `runtimeStatus: "available" | "type_only" | "reserved"`
* `readOnly: boolean`
* `notes?: string[]`

当前映射草案：

* `binance`: `available`, `readOnly: false`
* `juplend`: `available`, `readOnly: true`
* `okx` / `bybit` / `gate`: `type_only`, `readOnly: false`

### 2. Market Capabilities

用于回答“这个 venue 是否能加载市场、订阅哪些行情”。

建议字段：

* `market.catalog: "supported" | "unsupported"`
* `market.l1Book: "supported" | "unsupported"`
* `market.fundingRate: "supported" | "market_dependent" | "unsupported"`
* `market.marketTypes?: MarketType[]`

当前映射草案：

* Binance：catalog 支持，L1 book 支持，funding rate 是 `market_dependent`，market types 来自 catalog。
* Juplend：不支持 market catalog / L1 / funding rate。
* OKX / Bybit / Gate：当前 SDK 运行时不支持。

### 3. Account Capabilities

用于回答“这个 venue 是否支持账户视图、认证、订阅或 polling”。

建议字段：

* `account.register: "supported" | "unsupported"`
* `account.snapshot: "supported" | "unsupported"`
* `account.updates: "websocket" | "polling" | "unsupported"`
* `account.balances: "supported" | "unsupported"`
* `account.positions: "supported" | "unsupported"`
* `account.risk: "supported" | "unsupported"`
* `account.lending: "supported" | "unsupported"`
* `account.credentialsRequired: boolean`

当前映射草案：

* Binance：账户快照、余额、持仓、风险、WS updates 支持；无 lending facet。
* Juplend：只读账户快照、polling updates、lending facet 支持；positions 为空或不适用。
* OKX / Bybit / Gate：当前 SDK 运行时不支持。

### 4. Order Capabilities

用于回答“是否支持下单、撤单、订单订阅，以及支持哪些订单形态”。

建议字段：

* `order.supported: boolean`
* `order.openOrders: "supported" | "unsupported"`
* `order.updates: "websocket" | "polling" | "unsupported"`
* `order.create: "supported" | "unsupported"`
* `order.cancel: "supported" | "unsupported"`
* `order.cancelAll: "symbol" | "account" | "unsupported"`
* `order.orderTypes: CreateOrderType[]`
* `order.timeInForce?: ("gtc" | "post_only")[]`
* `order.postOnly: boolean`
* `order.reduceOnly: boolean`
* `order.positionSide: "optional" | "required_for_hedge" | "unsupported"`
* `order.clientOrderId: boolean`
* `order.reason?: VenueCapabilityReason`

当前映射草案：

* Binance：`supported: true`；open orders 支持；updates 为 websocket；create/cancel 支持；cancelAll 为 `symbol`；orderTypes 为 `limit` / `market`；postOnly、reduceOnly、clientOrderId 支持；positionSide 为 `required_for_hedge`。
* Juplend：`supported: false`，reason 为 `read_only`。
* OKX / Bybit / Gate：`supported: false`，reason 为 `not_implemented`。

### 5. Market-Specific Capability Query (Out of Scope for MVP)

venue 级能力不足以表达 funding rate、spot/swap/future 差异。需要考虑第二个 API：

* `client.getMarketCapabilities({ venue, symbol })`
* 或挂在 `client.market.getCapabilities({ venue, symbol })`

建议字段：

* `venue`
* `symbol`
* `type: MarketType`
* `active: boolean`
* `l1Book: boolean`
* `fundingRate: boolean`
* `orderEntry: boolean`
* `orderTypes: CreateOrderType[]`
* `precision: { priceStep; amountStep; minAmount?; minNotional? }`

第一版明确不实现该 API；后续如需要精确判断某个 symbol 是否支持 funding rate 或 order entry，再单独加 `getMarketCapabilities()`。

## Feasible API Shapes

### Approach A: Top-Level Client Query (Selected)

在 `AcexClient` 上新增：

```ts
getVenueCapabilities(venue: Venue): VenueCapabilities;
listVenueCapabilities(): VenueCapabilities[];
```

优点：

* 最符合“查询某个 venue 能力”的问题模型。
* 不要求 client `start()` 或网络连接。
* 能聚合 market/account/order 三个领域能力。

缺点：

* `AcexClient` 顶层 API 会变宽。
* 后续 market-specific 能力还需要另一个入口或参数。

### Approach B: Manager-Scoped Query

分别在 manager 上新增：

```ts
client.market.getCapabilities(venue)
client.account.getCapabilities(venue)
client.order.getCapabilities(venue)
```

优点：

* 领域边界清晰，manager 自己维护自己能力。
* 适合后续新增单个领域能力。

缺点：

* 调用方要回答“某 venue 支持什么”时需要查多个 manager。
* `readOnly`、`type_only` 这类跨领域语义会分散。

### Approach C: Export Static Capability Helper

从包入口导出：

```ts
getVenueCapabilities(venue: Venue): VenueCapabilities;
listVenueCapabilities(): VenueCapabilities[];
```

优点：

* 不需要创建 client 即可查询静态能力。
* 对只依赖类型和 UI 配置的调用方友好。

缺点：

* 未来如果 capabilities 受 `CreateClientOptions`、sandbox 或 adapter registry 影响，静态 helper 容易和 client 实例状态脱节。

## Acceptance Criteria

* [x] 调用方能查询 `binance` 并得到 `order.supported === true`。
* [x] 调用方能查询 `juplend` 并得到 `order.supported === false` 且 reason 为 `read_only`。
* [x] 调用方能查询 `okx` / `bybit` / `gate` 并得到运行时未实现，而不是误认为可用。
* [x] 能力查询不需要真实网络连接，不要求 `client.start()`。
* [x] 第一版不提供 symbol/market 级能力查询；venue 级 funding rate 使用 `market_dependent` 表达。
* [x] public types 可从根入口导入，且字段使用闭合联合类型而不是宽泛 `string`。
* [x] README / docs/api 说明 capabilities 的语义是 SDK runtime capability，不是交易所官网 capability。

## Technical Approach

第一版采用 adapter-owned capability + runtime 聚合，由 `AcexClientImpl` 暴露只读查询：

* 新增 public capability types，建议放在 `src/types/client.ts` 或独立 `src/types/capabilities.ts` 后由 `src/types/index.ts` 导出。
* 在 `AcexClient` interface 上新增 `getVenueCapabilities()` / `listVenueCapabilities()`。
* `MarketAdapter` 声明 market capability；`PrivateUserDataAdapter` 声明 account/order capability、只读状态和说明。
* runtime 层只聚合已注册 adapter 的 capability，并为 type-only venue 返回未实现 fallback。
* 查询返回 clone，避免调用方改写 SDK 内部 capability 表。
* capability 只表达 SDK 当前实现：Binance 可交易，Juplend 只读，OKX/Bybit/Gate 未实现。
* 文档明确它不是实时交易权限检查，不读取 API key 权限，也不代表交易所官网完整能力。

## Decision (ADR-lite)

**Context**: 调用方需要在执行下单、订阅账户或显示 venue UI 前判断 SDK 是否支持某 venue 的能力。当前只能通过调用后捕获 `VENUE_NOT_SUPPORTED`，不利于预检查和 UI 配置。

**Decision**: 第一版只做 venue 级 capability，入口放在顶层 `AcexClient`，提供 `getVenueCapabilities(venue)` 和 `listVenueCapabilities()`。

**Consequences**: 顶层 client API 会增加两个方法，但跨 `market/account/order` 的能力聚合位置清晰。adapter 负责维护自己实现的领域能力，runtime 负责聚合和 type-only fallback。market/symbol 级差异暂不展开，funding rate 用 `market_dependent` 表达；后续如需要精确 symbol 判断，再新增独立 market-level capability API。

## Definition of Done

* Tests added/updated (unit/integration where appropriate)
* `bun run lint`
* `bun run type-check`
* `bun run test`
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (Draft)

* 不在本任务实现 OKX / Bybit / Gate 运行时 adapter。
* 不实现 symbol/market 级 capability API。
* 不查询交易所实时账户权限，例如 API key 是否有交易权限。
* 不查询交易所实时 symbol 可交易状态之外的动态风控限制。
* 不实现改单、条件单、账户级全撤等当前 SDK 尚未实现的 order 命令。

## Technical Notes

* 公开类型应放在 `src/types/*`，根入口已经通过 `src/types/index.ts` 导出。
* runtime 当前硬编码 `BinanceMarketAdapter`，private adapter registry 包含 Binance 和 Juplend。
* adapter contract 要求交易所特定类型不能泄漏到 public API；capabilities 也应是统一标准类型。
* 如果能力查询来自 adapter 实例，需避免 adapter 特定 capability 结构泄漏到 manager/runtime。
* 相关文件：
  * `src/types/shared.ts`
  * `src/types/client.ts`
  * `src/types/market.ts`
  * `src/types/order.ts`
  * `src/client/runtime.ts`
  * `src/adapters/types.ts`
* `src/adapters/juplend/private-adapter.ts`
  * `README.md`
  * `docs/api.md`
