# SDK Architecture

## Scenario: SDK 采用 5 层架构，每层只依赖下层，职责边界由接口契约保证

### 1. Scope / Trigger

- Trigger: 新增 public API、增加 manager、增加交易所适配器、增加 runtime helper、或某个文件开始同时承担多类职责时。
- 目标: 保持 SDK 层次稳定，让 public contract、编排层、领域层、适配层、基础设施各自有固定落点。

### 2. Signatures

当前源码结构（5 层模型）：

```text
src/
├── index.ts                              # Layer 4: 公开 barrel
├── errors.ts                             # Layer 4: 错误类型
│
├── types/                                # 类型定义（跨层共享，不算独立层）
│   ├── index.ts
│   ├── shared.ts
│   ├── client.ts
│   ├── market.ts
│   ├── account.ts
│   ├── order.ts
│   ├── fee.ts
│   └── risk-limit.ts
│
├── internal/                             # Layer 0: 基础设施
│   ├── async-event-bus.ts
│   ├── decimal.ts                        # canonical decimal string 转换
│   ├── filters.ts
│   ├── http-client.ts                    # REST timeout / retry / TransportError / redaction
│   ├── managed-websocket.ts
│   ├── rate-limiter.ts                   # 默认 reactive RateLimiter
│   ├── rate-limiter/                     # limiter topology / state / snapshot / usage
│   ├── subscription-multiplexer.ts       # 通用订阅多路复用原语（venue-agnostic）
│   ├── syncing-time-provider.ts          # 签名时间同步
│   └── watermark.ts                      # 跨 clock domain stale update 防护
│
├── adapters/                             # Layer 1: 交易所适配器
│   ├── types.ts                          # MarketAdapter / PrivateUserDataAdapter 接口契约
│   ├── binance/
│   │   ├── adapter.ts                    # BinanceMarketAdapter（行情经 multiplexer 复用连接）
│   │   ├── error-codes.ts                # venue error code 归一
│   │   ├── funding-history.ts            # funding history REST parser
│   │   ├── market-catalog.ts             # Binance 市场目录加载
│   │   ├── private-adapter.ts            # BinancePrivateAdapter (PAPI UM listenKey + WS)
│   │   ├── public-market-http.ts         # public market REST helper
│   │   ├── public-trades.ts              # public trade REST queries
│   │   ├── rate-limit.ts
│   │   ├── rate-limit-topology.ts
│   │   ├── server-time.ts
│   │   └── stream-protocol.ts            # BinanceStreamProtocol（L1/funding 的 VenueStreamProtocol 策略）
│   ├── deribit/
│   │   ├── adapter.ts                    # DeribitMarketAdapter（option catalog + quote stream）
│   │   ├── market-catalog.ts
│   │   └── stream-protocol.ts
│   └── juplend/
│       ├── lend-read.ts                  # @jup-ag/lend-read 边界封装
│       └── private-adapter.ts            # JuplendPrivateAdapter (HTTP polling 只读借贷)
│
├── managers/                             # Layer 2: 领域 Manager
│   ├── account-manager.ts
│   ├── fee-manager.ts
│   ├── market-manager.ts
│   ├── order-manager.ts
│   ├── risk-limit-manager.ts
│   └── order/                            # OrderManager 私有子模块（model / identity / snapshot / store / data-status）
│
└── client/                               # Layer 3: 编排层
    ├── create-client.ts
    ├── context.ts                        # ClientContext 接口 + 生命周期接口
    ├── private-subscription-coordinator.ts
    ├── venue-capabilities.ts             # capability 聚合 helper
    └── runtime.ts                        # AcexClientImpl（编排器）
```

层级依赖方向：

```text
Layer 4  公开 API          src/index.ts, src/errors.ts
Layer 3  编排层            src/client/{runtime, create-client, context, private-subscription-coordinator, venue-capabilities}.ts
Layer 2  领域层            src/managers/{market, account, order, fee, risk-limit}-manager.ts
Layer 1  适配层            src/adapters/{types, binance/*, deribit/*, juplend/*}
Layer 0  基础设施          src/internal/{async-event-bus, decimal, filters, http-client, managed-websocket, rate-limiter*, subscription-multiplexer, syncing-time-provider, watermark}.ts
         类型定义          src/types/*（跨层共享）
```

**禁止反向依赖**：下层不能 import 上层模块。

入口职责签名：

```ts
// src/index.ts — 直接从实际位置导出，无中间层
export { BigNumber } from "bignumber.js";
export { createClient } from "./client/create-client.ts";
export type {
  AcexErrorCode,
  AcexErrorDetails,
  AcexErrorOptions,
  AcexErrorTransportDetails,
  AcexErrorTransportKind,
  AcexVenueErrorDetails,
  VenueErrorReason,
} from "./errors.ts";
export { AcexError, isOrderStateUnknown } from "./errors.ts";
export * from "./types/index.ts";
```

### 3. Contracts

#### 3.1 入口文件只做导出聚合

- `src/index.ts` 直接从 `./client/create-client.ts` 和 `./types/index.ts` 导出。
- **不允许中间 re-export 文件**（如 `src/client.ts` 或 `src/types.ts`），每多一层 re-export 就多一层认知负担。

#### 3.2 `src/types/*` 只放 public contract

- `src/types/shared.ts`：跨领域共用类型（`Venue`、`CreateClientOptions`、状态枚举等）。
- `src/types/market.ts`：market 领域类型与 `MarketManager` 接口。
- `src/types/account.ts`：account 领域类型与 `AccountManager` 接口。
- `src/types/order.ts`：order 领域类型与 `OrderManager` 接口。
- `src/types/fee.ts`：fee 领域类型与 `FeeManager` 接口。
- `src/types/risk-limit.ts`：risk limit / leverage 领域类型与 `RiskLimitManager` 接口。
- `src/types/client.ts`：顶层 `AcexClient` 接口、健康视图、聚合事件类型。

#### 3.3 `src/internal/*` 只放领域无关原语

- 可被多个领域复用，且不携带 market/account/order 语义的能力。
- 当前包括：`async-event-bus.ts`（异步事件总线）、`decimal.ts`（canonical decimal string 转换）、`filters.ts`（事件过滤器匹配函数）、`http-client.ts`（REST timeout / retry / typed `TransportError` / redaction）、`managed-websocket.ts`（WebSocket 生命周期管理）、`rate-limiter.ts` 与 `rate-limiter/*`（默认 reactive limiter、topology、usage snapshot）、`subscription-multiplexer.ts`（venue-agnostic 订阅多路复用：连接池化 + 重连重放 + per-subscription ready/stale + 控制帧限速，靠注入的 `VenueStreamProtocol` 策略隔离交易所细节）、`syncing-time-provider.ts`（签名时间同步）、`watermark.ts`（跨 clock domain stale update 防护）。
- **不能依赖上层任何模块**（只能依赖 `src/types/*`）。

#### 3.4 `src/adapters/*` 封装交易所特定实现

- `src/adapters/types.ts` 定义 `MarketAdapter` 接口、`PrivateUserDataAdapter` 接口、`StreamHandle`、所有 `Raw*` 标准化类型（`RawL1BookUpdate`、`RawAccountBootstrap`、`RawAccountUpdate`、`RawOrderUpdate`）、回调和选项类型。
- 每个交易所一个子目录（如 `binance/`），内含：
  - `adapter.ts`：实现 `MarketAdapter` 接口（行情 catalog + L1 Book / funding 流，行情流经共享的 `SubscriptionMultiplexer` 复用物理连接）。
  - `stream-protocol.ts`：实现 `VenueStreamProtocol` 策略（base URL / 订阅帧 / 消息路由），把交易所 WS 细节注入通用复用器。
  - `private-adapter.ts`：实现 `PrivateUserDataAdapter` 接口（账户 bootstrap、open orders bootstrap、交易命令、私有 WS 流、listenKey keepalive）。
  - 交易所特定的 catalog / REST 逻辑文件。
- 私有 adapter 必须把交易所特定 REST / WS 细节、签名方案、listenKey 维护完全封装在 `adapters/<venue>/` 内部，对外只返回标准化的 `RawAccountBootstrap` / `RawAccountUpdate` / `RawOrderUpdate`。
- **交易所特定类型（如 `BinanceMarketDefinition.family`）不得泄漏到适配器之外**。适配器对外只返回标准 `MarketDefinition` / `Raw*` 类型。
- 完整接口级契约见 [Adapter Contract](./adapters.md)。

#### 3.5 `src/managers/*` 各自持有领域状态

- 每个 Manager **拥有自己的状态**：record Map、事件总线（AsyncEventBus）、工厂方法。
- Manager 通过 `ClientContext` 接口访问 runtime 服务，**不直接依赖 `AcexClientImpl` 具体类**。
- Manager 实现以下内部接口（定义在 `src/client/context.ts`）：
  - `ManagerLifecycle`：`onClientStarted()` / `onClientStopping(now)`
  - `HealthReporter<T>`：`getStatuses(): T[]`
  - `AccountAwareManager`（仅 account/order）：`onAccountRemoved()` / `onCredentialsUpdated()`
- 小型 manager 的 Record 类型（如 `MarketRecord`）优先内联定义在各自 manager 文件中，不共享。
- 当单个 manager 文件开始承担过多内部状态机职责时，可以使用 `src/managers/<domain>/` 私有子模块拆分领域内部纯逻辑。约束：
  - `<domain>-manager.ts` 仍是该领域唯一 public/runtime 入口，继续持有 record map、事件总线和 `ClientContext` 交互；
  - 私有子模块不得从 `src/index.ts` 或 public barrel 导出，不跨领域复用；
  - `model.ts` 这类内部类型文件只服务同一 manager 子域，不放 public contract；
  - 需要 runtime error、health event、命令错误包装或外部事件发布的逻辑留在 manager 文件中，避免私有 helper 膨胀成第二个 manager。

#### 3.6 `src/client/*` 是编排层

- `create-client.ts`：工厂函数，只创建 `AcexClientImpl`。
- `context.ts`：定义 `ClientContext` 接口、`ManagerLifecycle`、`AccountAwareManager`、`HealthReporter<T>`，以及 `RegisteredAccountRecord` 和凭证工具函数。
- `runtime.ts`：`AcexClientImpl` 实现 `AcexClient` + `ClientContext`，只做跨领域编排，不持有 market/account/order 领域快照：
  - Client 状态管理（idle → running → stopped）
  - 账户注册表与 adapter registry（`marketAdapters` / `privateAdapters`）
  - Venue capability 聚合与 clone 返回
  - 跨域事件总线（healthBus、errorBus）
  - 生命周期协调（调用 manager 的 lifecycle 方法）
  - Health 聚合（调用 manager 的 `getStatuses()`）
  - manager / private coordinator 分派（private 订阅、order command、credentials/account remove）
- `private-subscription-coordinator.ts`：每账户一条 private user stream 的编排器，只做：
  - 复用 account / order 共用的 private stream
  - 协调 adapter bootstrap、reconnect、credentials refresh、account remove
  - 把标准化后的 raw update 分发给 `AccountManagerImpl` / `OrderManagerImpl`
  - **不持有 account/order 领域快照**，这些状态仍归对应 manager

### 4. Validation & Error Matrix

| 场景 | 正确落点 | 禁止做法 |
|---|---|---|
| 新增市场数据类型 | `src/types/market.ts` | 塞进 `src/index.ts` |
| 新增账户订阅实现 | `src/managers/account-manager.ts` | 塞进 runtime.ts |
| 新增 client 生命周期逻辑 | `src/client/runtime.ts` | 分散到三个 manager 各写一份 |
| 新增通用异步流原语 | `src/internal/*` | 混进某个 manager 文件 |
| 新增交易所适配逻辑 | `src/adapters/<venue>/` | 混进 manager 或 runtime |
| 新增 account/order 共享 private stream 编排 | `src/client/private-subscription-coordinator.ts` | 让两个 manager 各自维护一条 websocket |
| 新增根导出 | `src/index.ts` | 让调用方直接依赖深层内部路径 |
| Manager 需要访问 runtime | 通过 `ClientContext` 接口 | 直接 import `AcexClientImpl` 具体类 |
| 交易所特定类型 | 留在 `adapters/<venue>/` 内部 | 泄漏到 manager 或 runtime 的类型签名中 |

需要继续拆分的信号：

- 一个文件同时定义 public type、runtime 实现、manager 实现。
- 一个文件开始横跨 `market/account/order` 多个领域。
- runtime.ts 开始重新膨胀，承担非编排职责。
- adapter 代码出现在 `src/managers/` 或 `src/client/` 中。

### 5. Good / Base / Bad Cases

#### Good

新增 runtime venue 支持时：

- 创建 `src/adapters/<venue>/` 子目录
- 在其中实现 `<Venue>MarketAdapter`（implements `MarketAdapter`）和/或 `<Venue>PrivateAdapter`（implements `PrivateUserDataAdapter`）
- **加入 runtime registry**：在 `src/client/runtime.ts` 中把 venue 加入 `RuntimeSupportedVenue` 和 `RUNTIME_VENUE_FACTORIES`，由 factory 创建 adapter group，再汇入 `marketAdapters: Map<Venue, MarketAdapter>` / `privateAdapters: Map<Venue, PrivateUserDataAdapter>`。`MarketManagerImpl` 已按 `key.venue` 从 `marketAdapters` registry 分派（每 venue 独立 catalog 懒加载、互不影响），`PrivateSubscriptionCoordinator` / `getPrivateAdapter()` 也都按 `venue` 分派——新增 market venue **不需要改 manager**
- 行情 WS：实现该 venue 的 `VenueStreamProtocol`（参考 `binance/stream-protocol.ts`），交给 `SubscriptionMultiplexer` 即可复用连接，不要自己写 per-symbol 连接
- Manager 代码不需要改动（Manager 通过 `ClientContext` 与 runtime 交互，不直接持有 adapter 引用）
- 新 adapter 的接口级约束见 [Adapter Contract](./adapters.md)

新增 `ticker` 市场能力时：

- 类型放 `src/types/market.ts`
- 实现放 `src/managers/market-manager.ts`（新方法 + 新 record 字段）
- 若需适配器支持，在 `MarketAdapter` 接口上添加方法

新增 private account/order 流时：

- listenKey、REST bootstrap、WS payload parsing 放在 `src/adapters/binance/private-adapter.ts`
- 每账户流复用、reconnect/reconcile 放在 `src/client/private-subscription-coordinator.ts`
- account/order manager 只维护自己的 snapshot/status/event bus，不直接拥有 websocket

#### Base

一个 helper 先放在 `src/managers/market-manager.ts` 是可接受的，前提是：

- 它明确只用于 market 领域
- 暂时没有第二个领域复用它

一旦第二个领域也依赖它，迁到 `src/internal/*`。

#### Bad

- 为了少建文件，把三个 Manager 的状态和逻辑堆回 `runtime.ts`（重新制造 God Class）
- 让 manager 直接 import `AcexClientImpl` 具体类而不是 `ClientContext` 接口
- 在 manager 或 runtime 中出现 `BinanceMarketDefinition` 类型引用（适配器泄漏）
- 创建 `src/client.ts` 或 `src/types.ts` 等中间 re-export 文件

### 6. Tests Required

每次涉及目录和导出结构调整，至少执行：

```bash
bun run type-check
bun run test
bun run lint
```

断言重点：

- 根入口 `src/index.ts` 仍能导出 public API
- manager 方法签名不变
- `subscribe*()` / `unsubscribe*()` / `get*()` 语义不被重构破坏
- 层级依赖方向不被破坏（下层不 import 上层）

### 7. Wrong vs Correct

#### Wrong — God Class

```ts
// 旧的 God Class 形态
export class AcexClientImpl {
  // 持有所有状态：market/account/order records + 8 条事件总线
  // 所有工厂方法、所有 publish 方法、所有 WS 流管理
  // Manager 只是空壳 facade
}
```

问题：
- 所有领域逻辑集中在一个文件
- Manager 没有实际职责
- 新增领域或交易所会让 runtime 继续膨胀

#### Wrong — Manager 依赖具体类

```ts
// src/managers/market-manager.ts
import type { AcexClientImpl } from "../client/runtime.ts";

export class MarketManagerImpl {
  constructor(private readonly client: AcexClientImpl) {}
  // 调用 client 上 20+ 个内部方法
}
```

问题：
- Manager 与 runtime 实现强耦合
- 无法独立测试 manager
- 内部 API 边界不清晰

#### Correct — 接口依赖 + 状态自治

```ts
// src/managers/market-manager.ts
import type { ClientContext, HealthReporter, ManagerLifecycle } from "../client/context.ts";
import type { MarketAdapter } from "../adapters/types.ts";

export class MarketManagerImpl
  implements MarketManager, ManagerLifecycle, HealthReporter<MarketDataStatus>
{
  private readonly records = new Map<string, MarketRecord>();
  private readonly marketBus = new AsyncEventBus<MarketEvent>();

  constructor(
    context: ClientContext,
    adapters: Map<Venue, MarketAdapter>,
    options: MarketManagerOptions,
  ) {}
}
```

```ts
// src/client/runtime.ts（当前编排器形态）
export class AcexClientImpl implements AcexClient, ClientContext {
  constructor(options: CreateClientOptions = {}) {
    const adapterGroups = createVenueAdapterGroups(/* runtime options */);
    this.marketAdapters = new Map(
      adapterGroups.flatMap((group) =>
        group.marketAdapter
          ? [[group.marketAdapter.venue, group.marketAdapter]]
          : [],
      ),
    );
    const privateAdapters = adapterGroups.flatMap((group) =>
      group.privateAdapter ? [group.privateAdapter] : [],
    );
    this.privateAdapters = new Map(
      privateAdapters.map((a) => [a.venue, a]),
    );

    this.marketManager = new MarketManagerImpl(this, this.marketAdapters, marketOptions);
    this.accountManager = new AccountManagerImpl(this);
    this.orderManager = new OrderManagerImpl(this);
    this.feeManager = new FeeManagerImpl(this, options.fee);
    this.riskLimitManager = new RiskLimitManagerImpl(this, options.riskLimit);
    this.privateCoordinator = new PrivateSubscriptionCoordinator(
      this,
      privateAdapters,
      this.accountManager,
      this.orderManager,
      options.account,
      options.order,
    );
  }
}
```

效果：
- Manager 持有自己的状态和事件总线
- 通过 `ClientContext` 接口与 runtime 交互
- private stream 复用逻辑收敛在 client 层，不再散落到两个 manager
- 交易所细节封装在 adapter 中
- 各层职责清晰，可独立演进

## Scenario: 公开事件流的背压、conflation 与 status 发布门控

### 1. Scope / Trigger

- Trigger: 修改 `AsyncEventBus`、公开事件流方法签名、manager/runtime 的事件总线接线，或新增 market/account/order/health/error 事件流。
- 目标: 每个订阅者都有明确背压语义；高频行情流默认 latest-wins，顺序敏感流默认有界 FIFO；status 事件只在可观察状态变化时发布。

### 2. Signatures

public 类型只暴露调用方可控制的选项：

```ts
export type EventStreamMode = "buffer" | "conflate";

export interface EventStreamOptions {
  mode?: EventStreamMode;
  maxBuffer?: number;
}

export interface BufferedEventStreamOptions {
  maxBuffer?: number;
}
```

market 事件流使用 `EventStreamOptions`：

```ts
interface MarketEventStreams {
  l1BookUpdates(filter?, options?: EventStreamOptions): AsyncIterable<L1BookUpdatedEvent>;
  fundingRateUpdates(filter?, options?: EventStreamOptions): AsyncIterable<FundingRateUpdatedEvent>;
  status(filter?, options?: EventStreamOptions): AsyncIterable<MarketStatusChangedEvent>;
  all(filter?, options?: EventStreamOptions): AsyncIterable<MarketEvent>;
}
```

account/order/client 事件流只使用 `BufferedEventStreamOptions`：

```ts
interface AccountEventStreams {
  updates(filter?, options?: BufferedEventStreamOptions): AsyncIterable<AccountEvent>;
  status(filter?, options?: BufferedEventStreamOptions): AsyncIterable<AccountStatusChangedEvent>;
}

interface OrderEventStreams {
  updates(filter?, options?: BufferedEventStreamOptions): AsyncIterable<OrderEvent>;
  status(filter?, options?: BufferedEventStreamOptions): AsyncIterable<OrderStatusChangedEvent>;
}

interface ClientEventStreams {
  health(filter?, options?: BufferedEventStreamOptions): AsyncIterable<HealthEvent>;
  errors(options?: BufferedEventStreamOptions): AsyncIterable<AcexInternalError>;
}
```

内部 `AsyncEventBus` 可以接受 `conflateKey` 和 `onOverflow`，但这两个字段不能进入 public event stream options：

```ts
interface AsyncEventBusStreamOptions<T> {
  mode?: "buffer" | "conflate";
  maxBuffer?: number;
  conflateKey?: (event: T) => string;
  onOverflow?: (info: { maxBuffer: number }) => void;
}
```

### 3. Contracts

- 所有公开事件流方法保留第一参 `filter`，第二参为可选 `options`。
- `buffer` 模式是有界 FIFO；默认 `maxBuffer = 10_000`，超过上限时 drop oldest 并通过注入的 `onOverflow` 上报。
- `conflate` 模式按 key latest-wins；同 key 新事件替换旧事件，不同 key 保持首次插入顺序。
- pending consumer 正在等待 `next()` 时，两种模式都直接 hand-off 当前事件，不先进队列。
- `conflateKey` 是 SDK 内部实现参数：market manager 为公开 market 流注入 key，用户不能传入自定义 key。
- market `l1BookUpdates()` 和 `fundingRateUpdates()` 默认 `mode: "conflate"`，key 为 `venue:symbol`。
- market `all()` 默认 `mode: "buffer"`；调用方显式传 `mode: "conflate"` 时，key 为 `type:venue:symbol`，避免不同 market event type 相互覆盖。
- market `status()` 默认 `mode: "buffer"`；调用方显式传 `mode: "conflate"` 时，key 为 `venue:symbol`。
- order/account/health/errors 流只暴露 `BufferedEventStreamOptions`，类型层面不提供 `mode: "conflate"`，避免吞掉订单中间状态、账户增量或错误事件。
- market status 发布以 `activity` / `ready` / `freshness` / `reason` 四字段作为去重 key；首次发布必须发生。
- `lastReceivedAt` / `lastReadyAt` / `inactiveSince` / `ts` 不参与 status 发布比较；这些时间字段仍必须更新到 manager record，供 `getMarketStatus()` 读路径返回最新状态。

### 4. Validation & Error Matrix

| 场景 | 默认模式 / key | 允许 options | 不变量 |
|---|---|---|---|
| `market.events.l1BookUpdates()` | conflate，`venue:symbol` | `EventStreamOptions` | 慢消费者只保留每个市场最新 L1 |
| `market.events.fundingRateUpdates()` | conflate，`venue:symbol` | `EventStreamOptions` | 慢消费者只保留每个市场最新 funding |
| `market.events.all()` | buffer；显式 conflate key 为 `type:venue:symbol` | `EventStreamOptions` | 默认不吞混合事件；显式 conflate 不跨 type 覆盖 |
| `market.events.status()` | buffer；显式 conflate key 为 `venue:symbol` | `EventStreamOptions` | 发布本身已按状态比较字段门控 |
| `account.events.updates/status()` | buffer | `BufferedEventStreamOptions` | 不暴露 conflate |
| `order.events.updates/status()` | buffer | `BufferedEventStreamOptions` | 不暴露 conflate |
| `client.events.health()` | buffer | `BufferedEventStreamOptions` | overflow source 归 runtime |
| `client.events.errors()` | buffer | `BufferedEventStreamOptions` | 溢出不再发布 overflow，防递归 |
| market L1 tick 只更新时间戳字段 | 不适用 | 不适用 | 不重复发布 `market.status_changed` |
| market `activity` / `ready` / `freshness` / `reason` 任一变化 | 不适用 | 不适用 | 必须发布新的 `market.status_changed` |

### 5. Good / Base / Bad Cases

#### Good

```ts
this.marketBus.stream(
  (event): event is L1BookUpdatedEvent =>
    event.type === "l1_book.updated" && matchesMarketFilter(event, filter),
  this.createStreamOptions(
    "market.l1BookUpdates",
    options,
    "conflate",
    marketKey,
  ),
);
```

#### Base

```ts
this.orderBus.stream(matchesOrderEvent, {
  maxBuffer: options?.maxBuffer,
  onOverflow: this.createOverflowHandler("order.updates"),
});
```

order 流保持 buffer 语义，因为中间状态和错误恢复信号都可能对调用方有意义。

#### Bad

```ts
interface OrderEventStreams {
  updates(filter?, options?: EventStreamOptions): AsyncIterable<OrderEvent>;
}
```

问题：public 类型允许订单流 conflate，会静默吞掉部分订单状态转换。

### 6. Tests Required

修改事件流背压或 status 发布门控时至少执行：

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- conflate 流同 key 发布多次只消费最新事件；不同 key 各保留最新且按首次插入顺序消费。
- buffer 流超过 `maxBuffer` 后 drop oldest，并且每个积压 episode 只触发一次 overflow。
- pending consumer 在 buffer/conflate 模式下都直接收到当前事件。
- market L1/funding 默认 conflate；显式 `{ mode: "buffer" }` 时保留每条事件。
- public 类型导出 `EventStreamOptions` 和 `BufferedEventStreamOptions`，并经 `src/types/index.ts` 汇出。
- market status 连续相同 `activity` / `ready` / `freshness` / `reason` 不重复发布，但 `getMarketStatus()` 仍能读到持续更新的时间字段。

### 7. Wrong vs Correct

#### Wrong

```ts
statusPublicationKey = {
  ready: status.ready,
  freshness: status.freshness,
  lastReceivedAt: status.lastReceivedAt,
};
```

问题：`lastReceivedAt` 高频变化会让每个 L1 tick 都重新发布 status，抵消去重。

#### Correct

```ts
statusPublicationKey = {
  activity: status.activity,
  ready: status.ready,
  freshness: status.freshness,
  reason: status.reason,
};
```

效果：status 事件只反映订阅活跃度、可用性、fresh/stale 与原因变化；时间戳仍留在 record 给读路径使用。
