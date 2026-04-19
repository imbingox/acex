# Type Safety

## Scenario: SDK public contract 必须按领域收口，避免类型宽化和循环引用

### 1. Scope / Trigger

- Trigger: 新增 public type、调整 manager 返回值、修复 TypeScript 报错、或重构导出结构时。
- 目标: 保持 public contract 清晰，避免因为拆文件引入 `string` 宽化、隐式返回类型漂移或自引用类型错误。

### 2. Signatures

当前类型入口：

```ts
// src/index.ts — 直接从 types/ 导出，无中间层
export * from "./types/index.ts";

// src/types/index.ts
export * from "./shared.ts";
export * from "./market.ts";
export * from "./account.ts";
export * from "./order.ts";
export * from "./client.ts";
```

当前代码库里的代表性签名：

```ts
export type Exchange = (typeof SUPPORTED_EXCHANGES)[number];

export interface HealthEventFilter {
  scope?: "client" | "market" | "account" | "order";
  exchange?: Exchange;
  accountId?: string;
  symbol?: string;
}

createOrderStatus(
  accountId: string,
  exchange: Exchange,
  activity: "active" | "inactive",
): OrderDataStatus
```

### 3. Contracts

#### 3.1 闭合集合必须复用已有联合类型

- 已有 `Exchange`、`ClientStatus`、`PrivateRuntimeStatus` 这类闭合集合时，不要重新写成裸 `string`。
- filter、status、event 上下游必须共用同一个联合类型。

#### 3.2 runtime helper 的返回类型显式标注

- 像 `createOrderStatus()` 这种返回 public status 的 helper，必须写显式返回类型。
- 原因是对象字面量很容易把联合字面量推宽成 `string`，重构后会悄悄破坏 contract。

#### 3.3 不允许自引用 type import

- 领域类型文件不能从自己再次 import 类型别名。
- 例如 `src/types/order.ts` 不允许出现从 `./order.ts` 导入 `OrderDataStatus` 再改名使用的写法。

#### 3.4 implementation 优先 `import type`

- 只在需要运行时值时使用普通 import。
- 纯类型依赖默认使用 `import type`，减少循环依赖和构建噪音。

#### 3.5 union event filter 请求字段时，缺字段事件必须失败

- `HealthEvent` 是 `client` / `market` / `account` / `order` 的 union，不是每个事件都带 `exchange`、`accountId`、`symbol`。
- 当 `matchesHealthFilter()` 收到 `exchange`、`accountId` 或 `symbol` 条件时，**没有该字段的事件必须返回 `false`**。
- 不能写成“字段存在才比较，否则直接跳过”的逻辑，否则会把 `client.status_changed` 这类事件错误放进 `health({ exchange: "binance" })`。

### 4. Validation & Error Matrix

| 场景 | 正确写法 | 常见错误 |
|---|---|---|
| 事件 filter 上的交易所字段 | `exchange?: Exchange` | `exchange?: string` |
| `HealthEvent` union 上的字段过滤 | 请求 `exchange` / `accountId` / `symbol` 时，缺字段事件直接过滤掉 | 只有字段存在才比较，导致 `client.status_changed` 被错误放行 |
| runtime 创建状态对象 | 显式返回 `OrderDataStatus` | 省略返回类型导致 `runtimeStatus` 被推成 `string` |
| manager 返回状态 | 直接返回 `OrderDataStatus` | 通过自引用 alias 或重复定义接口 |
| 纯类型依赖 | `import type { Foo }` | 普通 import 造成不必要运行时依赖 |

### 5. Good / Base / Bad Cases

#### Good

```ts
export interface HealthEventFilter {
  exchange?: Exchange;
}
```

```ts
if (filter.exchange) {
  if (!("exchange" in event) || event.exchange !== filter.exchange) {
    return false;
  }
}
```

```ts
createOrderStatus(...): OrderDataStatus {
  return {
    accountId,
    exchange,
    activity,
    ready: false,
    runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
  };
}
```

#### Base

```ts
import type { MarketManager } from "../types/index.ts";
```

从 barrel import 类型在当前仓库可以接受；如果后续出现明显循环依赖，再改成更细的领域 import。

#### Bad

```ts
export interface HealthEventFilter {
  exchange?: string;
}
```

```ts
if ("exchange" in event && filter.exchange && event.exchange !== filter.exchange) {
  return false;
}
```

问题：
- `client.status_changed` 没有 `exchange` 字段，会直接漏过这段判断
- 调用 `health({ exchange: "binance" })` 时会错误收到 client 级事件

```ts
createOrderStatus(...) {
  return {
    runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
  };
}
```

### 6. Tests Required

每次改 public types 或导出结构，至少执行：

```bash
bunx tsc --noEmit
bun test
```

断言重点：

- public contract 仍可从根入口正确导入
- `Exchange`、状态枚举、事件 filter 等没有被宽化成 `string`
- 重构后 manager 返回值仍符合文档约定
- `health({ exchange })` / `health({ accountId })` / `health({ symbol })` 不会收到缺少对应字段的 union 成员事件

### 7. Wrong vs Correct

#### Wrong

```ts
import type { OrderDataStatus as _OrderDataStatus } from "./order.ts";

export interface OrderManager {
  getOrderStatus(accountId: string): _OrderDataStatus | undefined;
}
```

问题：

- 自引用 import 没有任何价值
- 增加循环依赖和阅读噪音

#### Correct

```ts
export interface OrderManager {
  getOrderStatus(accountId: string): OrderDataStatus | undefined;
}
```

效果：

- 类型来源直接、稳定
- 文件拆分后不容易引入伪别名和循环引用
