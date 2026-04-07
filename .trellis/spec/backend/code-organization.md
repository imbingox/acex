# Code Organization

## Scenario: Bun SDK 源码按领域拆分，避免 `client.ts` / `types.ts` 再次膨胀

### 1. Scope / Trigger

- Trigger: 新增 public API、增加 manager、增加 runtime helper、或某个文件开始同时承担多类职责时。
- 目标: 保持 SDK 结构稳定，让 public contract、runtime、manager、internal primitive 各自有固定落点。

### 2. Signatures

当前源码结构：

```text
index.ts
src/
  index.ts
  client.ts
  types.ts
  errors.ts
  client/
    create-client.ts
    records.ts
    runtime.ts
  managers/
    market-manager.ts
    account-manager.ts
    order-manager.ts
  types/
    index.ts
    shared.ts
    client.ts
    market.ts
    account.ts
    order.ts
  internal/
    async-event-bus.ts
```

入口职责签名：

```ts
// index.ts
export * from "./src/index.ts";

// src/index.ts
export { createClient } from "./client.ts";
export * from "./types.ts";

// src/client.ts
export { createClient } from "./client/create-client.ts";

// src/types.ts
export * from "./types/index.ts";
```

### 3. Contracts

#### 3.1 入口文件只做导出聚合

- `index.ts`、`src/index.ts`、`src/client.ts`、`src/types.ts` 不写业务逻辑。
- 这些文件存在的目的只有两个：
  - 提供稳定 import path
  - 降低重构时的导出面变动

#### 3.2 `src/types/*` 只放 public contract

- `src/types/shared.ts` 放跨领域共用类型：
  - `Exchange`
  - `CreateClientOptions`
  - `AccountCredentials`
  - 通用状态枚举
- `src/types/market.ts` 只放 market 领域类型与 manager 接口。
- `src/types/account.ts` 只放 account 领域类型与 manager 接口。
- `src/types/order.ts` 只放 order 领域类型与 manager 接口。
- `src/types/client.ts` 只放顶层 client 接口、健康视图、聚合事件类型。

#### 3.3 `src/client/*` 只放 client 运行时相关实现

- `create-client.ts` 只创建 `AcexClient` 实例。
- `runtime.ts` 负责：
  - client 生命周期
  - 账户注册表
  - 全局 event bus
  - record 的创建和状态发布
- `records.ts` 负责：
  - record 数据结构
  - key / filter / clone helper
  - 与 runtime 强相关但不属于 manager 的小型工具

#### 3.4 `src/managers/*` 一文件一领域

- `market-manager.ts` 只实现 `MarketManager`。
- `account-manager.ts` 只实现 `AccountManager`。
- `order-manager.ts` 只实现 `OrderManager`。
- manager 可以依赖 runtime 暴露的方法，但不能反过来把 manager 私有逻辑塞回入口文件。

#### 3.5 `src/internal/*` 只放领域无关原语

- 可被多个领域复用，且不携带 market/account/order 语义的能力，放进 `src/internal/*`。
- 当前例子是 `src/internal/async-event-bus.ts`。

### 4. Validation & Error Matrix

| 场景 | 正确落点 | 禁止做法 |
|---|---|---|
| 新增市场数据类型 | `src/types/market.ts` | 塞回 `src/types.ts` |
| 新增账户订阅实现 | `src/managers/account-manager.ts` | 塞回 `src/client.ts` |
| 新增 client 生命周期逻辑 | `src/client/runtime.ts` | 分散到三个 manager 各写一份 |
| 新增通用异步流原语 | `src/internal/*` | 混进某个 manager 文件 |
| 新增根导出 | `src/index.ts` 或 wrapper 文件 | 让调用方直接依赖深层内部路径 |

需要继续拆分的信号：

- 一个文件同时定义 public type、runtime 实现、manager 实现。
- 一个文件开始横跨 `market/account/order` 多个领域。
- 一个文件的修改原因长期来自两个以上独立功能。

### 5. Good / Base / Bad Cases

#### Good

新增 `ticker` 市场能力时：

- 类型放 `src/types/market.ts`
- 实现放 `src/managers/market-manager.ts`
- 如需 record 字段，补到 `src/client/records.ts`
- 如需全局状态发布，补到 `src/client/runtime.ts`

#### Base

一个 helper 先放在 `src/client/runtime.ts` 是可接受的，前提是：

- 它明显依赖 client 内部状态
- 暂时没有第二个领域复用它

一旦第二个领域也依赖它，评估是否迁到 `src/client/records.ts` 或 `src/internal/*`。

#### Bad

- 为了少建文件，把 `MarketManagerImpl`、`AccountManagerImpl`、`OrderManagerImpl` 再次合并回一个 `src/client.ts`
- 为了图省事，把所有 public types 再次合并回一个 `src/types.ts`
- 让 `src/internal/*` 直接依赖某个具体领域类型，结果变成伪 internal

### 6. Tests Required

每次涉及目录和导出结构调整，至少执行：

```bash
bunx tsc --noEmit
bun test
```

断言重点：

- 根入口 `index.ts` 仍能导出 public API
- manager 方法签名不变
- `subscribe*()` / `unsubscribe*()` / `get*()` 语义不被重构破坏

### 7. Wrong vs Correct

#### Wrong

```ts
// src/client.ts
export function createClient() {}

export class AcexClientImpl {
  // client 生命周期
}

export class MarketManagerImpl {}
export class AccountManagerImpl {}
export class OrderManagerImpl {}
```

问题：

- 入口文件承担了工厂、runtime、三个 manager 四类职责
- 后续新增一个领域时，所有改动都集中到同一文件

#### Correct

```ts
// src/client.ts
export { createClient } from "./client/create-client.ts";

// src/client/create-client.ts
export function createClient(options?: CreateClientOptions): AcexClient {
  return new AcexClientImpl(options);
}
```

```ts
// src/managers/market-manager.ts
export class MarketManagerImpl implements MarketManager {
  // 只处理 market 领域行为
}
```

效果：

- 对外 import path 稳定
- 实现按职责拆开
- 后续可以继续把 runtime 内部再细分，而不影响 public entry
