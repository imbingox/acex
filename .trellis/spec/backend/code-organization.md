# Code Organization

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
│   └── order.ts
│
├── internal/                             # Layer 0: 基础设施
│   ├── async-event-bus.ts
│   ├── managed-websocket.ts
│   └── filters.ts
│
├── adapters/                             # Layer 1: 交易所适配器
│   ├── types.ts                          # MarketAdapter 接口契约
│   └── binance/
│       ├── adapter.ts                    # BinanceMarketAdapter
│       ├── book-ticker.ts               # Binance WS bookTicker
│       └── market-catalog.ts            # Binance 市场目录加载
│
├── managers/                             # Layer 2: 领域 Manager
│   ├── market-manager.ts
│   ├── account-manager.ts
│   └── order-manager.ts
│
└── client/                               # Layer 3: 编排层
    ├── create-client.ts
    ├── context.ts                        # ClientContext 接口 + 生命周期接口
    └── runtime.ts                        # AcexClientImpl（薄编排器）
```

层级依赖方向：

```text
Layer 4  公开 API          src/index.ts, src/errors.ts
Layer 3  编排层            src/client/{runtime, create-client, context}.ts
Layer 2  领域层            src/managers/{market, account, order}-manager.ts
Layer 1  适配层            src/adapters/{types, binance/*}
Layer 0  基础设施          src/internal/{async-event-bus, managed-websocket, filters}.ts
         类型定义          src/types/*（跨层共享）
```

**禁止反向依赖**：下层不能 import 上层模块。

入口职责签名：

```ts
// src/index.ts — 直接从实际位置导出，无中间层
export { createClient } from "./client/create-client.ts";
export type { AcexErrorCode } from "./errors.ts";
export { AcexError } from "./errors.ts";
export * from "./types/index.ts";
```

### 3. Contracts

#### 3.1 入口文件只做导出聚合

- `src/index.ts` 直接从 `./client/create-client.ts` 和 `./types/index.ts` 导出。
- **不允许中间 re-export 文件**（如 `src/client.ts` 或 `src/types.ts`），每多一层 re-export 就多一层认知负担。

#### 3.2 `src/types/*` 只放 public contract

- `src/types/shared.ts`：跨领域共用类型（`Exchange`、`CreateClientOptions`、状态枚举等）。
- `src/types/market.ts`：market 领域类型与 `MarketManager` 接口。
- `src/types/account.ts`：account 领域类型与 `AccountManager` 接口。
- `src/types/order.ts`：order 领域类型与 `OrderManager` 接口。
- `src/types/client.ts`：顶层 `AcexClient` 接口、健康视图、聚合事件类型。

#### 3.3 `src/internal/*` 只放领域无关原语

- 可被多个领域复用，且不携带 market/account/order 语义的能力。
- 当前包括：`async-event-bus.ts`（异步事件总线）、`managed-websocket.ts`（WebSocket 生命周期管理）、`filters.ts`（事件过滤器匹配函数）。
- **不能依赖上层任何模块**（只能依赖 `src/types/*`）。

#### 3.4 `src/adapters/*` 封装交易所特定实现

- `src/adapters/types.ts` 定义 `MarketAdapter` 接口、`StreamHandle`、`RawL1BookUpdate`、回调和选项类型。
- 每个交易所一个子目录（如 `binance/`），内含：
  - `adapter.ts`：实现 `MarketAdapter` 接口。
  - 交易所特定的 WS/REST 逻辑文件。
- **交易所特定类型（如 `BinanceMarketDefinition.family`）不得泄漏到适配器之外**。适配器对外只返回标准 `MarketDefinition`。

#### 3.5 `src/managers/*` 各自持有领域状态

- 每个 Manager **拥有自己的状态**：record Map、事件总线（AsyncEventBus）、工厂方法。
- Manager 通过 `ClientContext` 接口访问 runtime 服务，**不直接依赖 `AcexClientImpl` 具体类**。
- Manager 实现以下内部接口（定义在 `src/client/context.ts`）：
  - `ManagerLifecycle`：`onClientStarted()` / `onClientStopping(now)`
  - `HealthReporter<T>`：`getStatuses(): T[]`
  - `AccountAwareManager`（仅 account/order）：`onAccountRemoved()` / `onCredentialsUpdated()`
- Record 类型（如 `MarketRecord`）内联定义在各自 manager 文件中，不共享。

#### 3.6 `src/client/*` 是薄编排层

- `create-client.ts`：工厂函数，只创建 `AcexClientImpl`。
- `context.ts`：定义 `ClientContext` 接口、`ManagerLifecycle`、`AccountAwareManager`、`HealthReporter<T>`，以及 `RegisteredAccountRecord` 和凭证工具函数。
- `runtime.ts`：`AcexClientImpl` 实现 `AcexClient` + `ClientContext`，只做：
  - Client 状态管理（idle → running → stopped）
  - 账户注册表
  - 跨域事件总线（healthBus、errorBus）
  - 生命周期协调（调用 manager 的 lifecycle 方法）
  - Health 聚合（调用 manager 的 `getStatuses()`）

### 4. Validation & Error Matrix

| 场景 | 正确落点 | 禁止做法 |
|---|---|---|
| 新增市场数据类型 | `src/types/market.ts` | 塞进 `src/index.ts` |
| 新增账户订阅实现 | `src/managers/account-manager.ts` | 塞进 runtime.ts |
| 新增 client 生命周期逻辑 | `src/client/runtime.ts` | 分散到三个 manager 各写一份 |
| 新增通用异步流原语 | `src/internal/*` | 混进某个 manager 文件 |
| 新增交易所适配逻辑 | `src/adapters/<exchange>/` | 混进 manager 或 runtime |
| 新增根导出 | `src/index.ts` | 让调用方直接依赖深层内部路径 |
| Manager 需要访问 runtime | 通过 `ClientContext` 接口 | 直接 import `AcexClientImpl` 具体类 |
| 交易所特定类型 | 留在 `adapters/<exchange>/` 内部 | 泄漏到 manager 或 runtime 的类型签名中 |

需要继续拆分的信号：

- 一个文件同时定义 public type、runtime 实现、manager 实现。
- 一个文件开始横跨 `market/account/order` 多个领域。
- runtime.ts 开始重新膨胀，承担非编排职责。
- adapter 代码出现在 `src/managers/` 或 `src/client/` 中。

### 5. Good / Base / Bad Cases

#### Good

新增 OKX 交易所支持时：

- 创建 `src/adapters/okx/` 子目录
- 在其中实现 `OkxMarketAdapter`（implements `MarketAdapter`）
- runtime 的适配器选择逻辑补上 OKX
- Manager 代码无需改动

新增 `ticker` 市场能力时：

- 类型放 `src/types/market.ts`
- 实现放 `src/managers/market-manager.ts`（新方法 + 新 record 字段）
- 若需适配器支持，在 `MarketAdapter` 接口上添加方法

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
bun test
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
// src/client/runtime.ts (1050+ 行)
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
    adapter: MarketAdapter,
    options: MarketManagerOptions,
  ) {}
}
```

```ts
// src/client/runtime.ts (~280 行，薄编排器)
export class AcexClientImpl implements AcexClient, ClientContext {
  constructor(options: CreateClientOptions = {}) {
    const adapter = new BinanceMarketAdapter();
    this.marketManager = new MarketManagerImpl(this, adapter, marketOptions);
    this.accountManager = new AccountManagerImpl(this);
    this.orderManager = new OrderManagerImpl(this);
  }
}
```

效果：
- Manager 持有自己的状态和事件总线
- 通过 `ClientContext` 接口与 runtime 交互
- 交易所细节封装在 adapter 中
- 各层职责清晰，可独立演进
