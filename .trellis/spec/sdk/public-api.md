# Public API Contract

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
export type Venue = (typeof SUPPORTED_VENUES)[number];

export interface HealthEventFilter {
  scope?: "client" | "market" | "account" | "order";
  venue?: Venue;
  accountId?: string;
  symbol?: string;
}

export type PrivateRuntimeReason =
  | "credentials_missing"
  | "auth_failed"
  | "http_failed"
  | "rate_limited"
  | "ws_disconnected"
  | "heartbeat_timeout"
  | "reconciling";

// src/managers/order-manager.ts
private createStatus(
  accountId: string,
  venue: Venue,
  activity: "active" | "inactive",
): OrderDataStatus
```

### 3. Contracts

#### 3.1 闭合集合必须复用已有联合类型

- 已有 `Venue`、`ClientStatus`、`PrivateRuntimeStatus` 这类闭合集合时，不要重新写成裸 `string`。
- filter、status、event 上下游必须共用同一个联合类型。
- 当两个领域共享同一组原因码时，提取到 `src/types/shared.ts`。
  - 当前 `AccountDataStatus.reason` 与 `OrderDataStatus.reason` 都必须复用 `PrivateRuntimeReason`
  - 不允许两个文件各自复制 `"auth_failed" | "ws_disconnected" | ...` 这一组字面量联合

#### 3.2 runtime helper 的返回类型显式标注

- 像 `OrderManagerImpl.createStatus()`、`AccountManagerImpl.createStatus()` 这类返回 public status 的 helper，必须写显式返回类型。
- 原因是对象字面量很容易把联合字面量推宽成 `string`，重构后会悄悄破坏 contract。

#### 3.3 Public 数值输出必须是 canonical decimal string

- `src/types/market.ts`、`src/types/account.ts`、`src/types/order.ts` 中的 public snapshot / market 数值字段必须使用 `string`，代表 canonical decimal string（无科学计数法、不补尾零）。`L1Book` 的 bid/ask price/size 是特例：使用 `string | null`，其中 `null` 表示该侧当前已知无有效报价。
- `BigNumber` 只允许作为根入口 re-export 的下游计算工具，以及 `DecimalInput = string | number | BigNumber` 这类输入侧宽类型；不能出现在 public output 类型里。
- 新增 `MarketDefinition`、`L1Book`、`FundingRateSnapshot`、`FundingRateHistoryEntry`、`BalanceSnapshot`、`PositionSnapshot`、`RiskSnapshot`、`OrderSnapshot` 或 lending facet 字段时，数量 / 价格 / 金额 / 比率字段都必须按 string 输出；只有明确表达“已知无该值”的 public 字段才可使用 `string | null`，当前仅适用于 `L1Book` bid/ask top-of-book 字段。
- manager 出口使用 `toCanonical()` 统一 canonical 化；adapter / manager 内部可用 BigNumber 计算，但不得把第三方数值对象泄漏到 public contract。

#### 3.4 不允许自引用 type import

- 领域类型文件不能从自己再次 import 类型别名。
- 例如 `src/types/order.ts` 不允许出现从 `./order.ts` 导入 `OrderDataStatus` 再改名使用的写法。

#### 3.5 implementation 优先 `import type`

- 只在需要运行时值时使用普通 import。
- 纯类型依赖默认使用 `import type`，减少循环依赖和构建噪音。

#### 3.6 union event filter 请求字段时，缺字段事件必须失败

- `HealthEvent` 是 `client` / `market` / `account` / `order` 的 union，不是每个事件都带 `venue`、`accountId`、`symbol`。
- 当 `matchesHealthFilter()` 收到 `venue`、`accountId` 或 `symbol` 条件时，**没有该字段的事件必须返回 `false`**。
- 不能写成“字段存在才比较，否则直接跳过”的逻辑，否则会把 `client.status_changed` 这类事件错误放进 `health({ venue: "binance" })`。

### 4. Validation & Error Matrix

| 场景 | 正确写法 | 常见错误 |
|---|---|---|
| 事件 filter 上的交易所字段 | `venue?: Venue` | `venue?: string` |
| `HealthEvent` union 上的字段过滤 | 请求 `venue` / `accountId` / `symbol` 时，缺字段事件直接过滤掉 | 只有字段存在才比较，导致 `client.status_changed` 被错误放行 |
| runtime 创建状态对象 | 显式返回 `OrderDataStatus` | 省略返回类型导致 `runtimeStatus` 被推成 `string` |
| public 数值输出字段 | `price?: string`、`riskRatio?: string` | `price?: BigNumber` 或 `price?: number` |
| public `BigNumber` 使用 | 根入口 re-export、`DecimalInput` 输入侧 | `OrderSnapshot` / `RiskSnapshot` / `MarketDefinition` 输出侧 |
| manager 返回状态 | 直接返回 `OrderDataStatus` | 通过自引用 alias 或重复定义接口 |
| 纯类型依赖 | `import type { Foo }` | 普通 import 造成不必要运行时依赖 |
| account/order 共享状态 reason | 提取 `PrivateRuntimeReason` | 两个领域各自复制一份同样的联合类型 |

### 5. Good / Base / Bad Cases

#### Good

```ts
export interface HealthEventFilter {
  venue?: Venue;
}
```

```ts
export type PrivateRuntimeReason =
  | "credentials_missing"
  | "auth_failed"
  | "http_failed"
  | "rate_limited"
  | "ws_disconnected"
  | "heartbeat_timeout"
  | "reconciling";
```

```ts
export interface OrderSnapshot {
  price?: string;
  amount: string;
  filled: string;
  remaining?: string;
}

export type DecimalInput = string | number | BigNumber;
```

```ts
if (filter.venue) {
  if (!("venue" in event) || event.venue !== filter.venue) {
    return false;
  }
}
```

```ts
createStatus(...): OrderDataStatus {
  return {
    accountId,
    venue,
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
  venue?: string;
}
```

```ts
export interface RiskSnapshot {
  riskRatio?: BigNumber;
}
```

问题：

- public snapshot 无法稳定 JSON / IPC / worker 传输
- 下游会被迫依赖特定 BigNumber 实例来源和构造器配置

```ts
// src/types/account.ts
reason?: "auth_failed" | "ws_disconnected" | "reconciling";

// src/types/order.ts
reason?: "auth_failed" | "ws_disconnected" | "reconciling";
```

```ts
if ("venue" in event && filter.venue && event.venue !== filter.venue) {
  return false;
}
```

问题：
- `client.status_changed` 没有 `venue` 字段，会直接漏过这段判断
- 调用 `health({ venue: "binance" })` 时会错误收到 client 级事件

```ts
createStatus(...) {
  return {
    runtimeStatus: activity === "active" ? "bootstrap_pending" : "stopped",
  };
}
```

### 6. Tests Required

每次改 public types 或导出结构，至少执行：

```bash
bun run type-check
bun run test
```

断言重点：

- public contract 仍可从根入口正确导入
- `Venue`、状态枚举、事件 filter 等没有被宽化成 `string`
- public output type 不暴露 BigNumber / number 数值字段；`tests/unit/public-decimal-contract.test.ts` 必须继续覆盖这一点
- 重构后 manager 返回值仍符合文档约定
- `health({ venue })` / `health({ accountId })` / `health({ symbol })` 不会收到缺少对应字段的 union 成员事件

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

## Scenario: SDK runtime venue 能力查询

### 1. Scope / Trigger

- Trigger: 新增或修改 `getVenueCapabilities()` / `listVenueCapabilities()`、新增 venue、接入新的 market/account/order runtime 能力、或改变某个 venue 的只读/可交易状态。
- 目标: 让调用方在执行下单、订阅账户或展示 UI 前，能查询 **当前 SDK runtime 已实现能力**。
- 边界: capability 不是交易所官网完整能力，也不是实时 API key 权限检查；不访问网络，不依赖 `client.start()`。

### 2. Signatures

公开入口固定在顶层 `AcexClient`：

```ts
interface AcexClient {
  getVenueCapabilities(venue: Venue): VenueCapabilities;
  listVenueCapabilities(): VenueCapabilities[];
}
```

核心返回类型：

```ts
interface VenueCapabilities {
  venue: Venue;
  runtimeStatus: "available" | "type_only" | "reserved";
  readOnly: boolean;
  notes: string[];
  market: VenueMarketCapabilities;
  account: VenueAccountCapabilities;
  order: VenueOrderCapabilities;
}

interface VenueMarketCapabilities {
  catalog: "supported" | "unsupported";
  serverTime: "supported" | "unsupported";
  publicTrades: "supported" | "unsupported";
  publicRawTrades: "supported" | "unsupported";
  fundingRateHistory: "supported" | "unsupported";
  l1Book: "supported" | "unsupported";
  fundingRate: "supported" | "unsupported" | "market_dependent";
  marketTypes: MarketType[];
}
```

### 3. Contracts

- `runtimeStatus = "available"` 表示该 venue 至少有一类 runtime adapter/manager 链路可用。
- `runtimeStatus = "type_only"` 表示 venue 只出现在 public `Venue` 类型中，当前没有 runtime adapter。
- `readOnly = true` 表示 SDK 对该 venue 只提供读能力，不允许通过 `OrderManager` 或链上写操作修改状态。
- `market.fundingRate = "market_dependent"` 表示 venue 级无法保证所有 market 都支持；具体 symbol 仍以 `acquireFundingRateSubscription()` 的实际结果为准。
- `market.publicTrades = "supported"` 表示当前 SDK runtime 实现了 public market trades 查询链路。Binance 当前返回 `aggTrades` 聚合成交，不是逐笔 raw trade。
- `market.publicRawTrades = "supported"` 表示当前 SDK runtime 实现了逐笔 raw public trade 查询链路。Binance 该方法需要 market-data API key；capability 不检查 key 是否已配置或权限是否有效。
- `market.fundingRateHistory = "supported"` 表示当前 SDK runtime 可通过 `client.market.fetchFundingRateHistory()` 查询历史 funding rate；具体 symbol 仍需是永续合约，spot / dated future 会由 manager 抛 `MARKET_FUNDING_RATE_UNSUPPORTED`。
- `market.serverTime = "supported"` 表示当前 SDK runtime 可通过 `client.market.fetchServerTime(venue)` 获取交易所服务器时间、单次 RTT 与 NTP 式时钟偏移估算。Binance 当前测量源固定为 USDⓈ-M REST 集群 `/fapi/v1/time`。
- `order.supported = true` 才表示可以通过当前 SDK 调 `createOrder()` / `cancelOrder()` / `cancelAllOrders()`。
- `order.supported = true` 是 venue 级能力，不是 market/symbol 级能力。例如 Binance 当前订单命令按 symbol 路由 PAPI UM 与 PAPI margin，不能据此推断 Binance COIN-M、交割合约、条件单或改单都可通过 `OrderManager` 下单。
- `order.reason` 只在 `order.supported = false` 时使用，常见值：
  - `read_only`: venue 只读，例如 Juplend
  - `not_implemented`: venue 仅类型占位或 runtime 未接入
- capability 真源应尽量靠近 adapter：
  - `MarketAdapter.marketCapabilities` 声明该 market adapter 已实现的 catalog / server time / public trades / public raw trades / funding history / L1 / funding rate 能力。
  - `MarketAdapter.readOnly?: true` 可声明 market-only read-only runtime。没有 private adapter 时，runtime 仍应返回 `runtimeStatus:"available"`、`readOnly:true`、account unsupported、order unsupported 且 `order.reason:"read_only"`。Deribit public option market data 属于该形态。
  - `PrivateUserDataAdapter.accountCapabilities` 声明账户视图能力。
  - `PrivateUserDataAdapter.orderCapabilities` 声明订单命令与订单流能力。
  - `PrivateUserDataAdapter.readOnly` / `notes` 声明私有链路的只读状态和说明。
- runtime 只负责聚合 market/private adapter capability，并为没有 adapter 的 `type_only` venue 提供 fallback。
- 返回对象必须是 clone，调用方修改 `notes`、`marketTypes`、`orderTypes`、`timeInForce` 等数组不得污染内部 capability 表。

### 4. Validation & Error Matrix

| 场景 | 约定 |
|---|---|
| 查询 `binance` | `runtimeStatus = "available"`，`order.supported = true`，`order.orderTypes = ["limit", "market"]` |
| 查询 `binance` 的 market 能力 | `catalog = "supported"`，`serverTime = "supported"`，`publicTrades = "supported"`，`publicRawTrades = "supported"`，`fundingRateHistory = "supported"`，`l1Book = "supported"`，`fundingRate = "market_dependent"` |
| 查询 `deribit`（runtime 被选择） | `runtimeStatus = "available"`，`readOnly = true`，`market.catalog = "supported"`，`market.l1Book = "supported"`，`market.marketTypes = ["option"]`，account 全 unsupported，`order.reason = "read_only"` |
| 查询 `juplend` | `runtimeStatus = "available"`，`readOnly = true`，`market.serverTime = "unsupported"`，`order.supported = false`，`reason = "read_only"` |
| 查询 `okx` / `bybit` / `gate` | `runtimeStatus = "type_only"`，runtime 能力均为 unsupported，`market.serverTime = "unsupported"`，`order.reason = "not_implemented"` |
| client 未 `start()` | capability 查询仍可用 |
| 调用方修改返回数组 | 下一次查询结果不受影响 |
| 新增 public capability 字段 | 必须更新 docs、测试和 changeset |

### 5. Good / Base / Bad Cases

Good:

```ts
const capabilities = client.getVenueCapabilities("juplend");
if (!capabilities.order.supported) {
  // 不展示下单按钮，或提前拒绝策略配置
}
```

Base:

```ts
const venues = client
  .listVenueCapabilities()
  .filter((capabilities) => capabilities.runtimeStatus === "available");
```

Bad:

```ts
// 不要把 SUPPORTED_VENUES 当成 runtime 可用列表
for (const venue of SUPPORTED_VENUES) {
  await client.order.createOrder({ accountId, venue, ...input });
}
```

问题：`SUPPORTED_VENUES` 包含 type-only venue，不代表 SDK 当前可以下单。

### 6. Tests Required

- Integration: `getVenueCapabilities("binance")` 返回 `order.supported = true`、`fundingRate = "market_dependent"`。
- Integration: `getVenueCapabilities("binance")` 返回 `market.serverTime = "supported"`。
- Integration: `getVenueCapabilities("binance")` 返回 `market.publicTrades = "supported"`、`market.publicRawTrades = "supported"` 与 `market.fundingRateHistory = "supported"`。
- Integration: `getVenueCapabilities("deribit")` 在 Deribit 被 runtime 选择时返回 `readOnly = true`、`market.marketTypes = ["option"]`、`market.l1Book = "supported"`、`order.reason = "read_only"`，且不需要 private adapter。
- Integration: `getVenueCapabilities("juplend")` 返回 `readOnly = true`、`market.serverTime = "unsupported"`、`order.reason = "read_only"`、`account.updates = "polling"`。
- Integration: `okx` / `bybit` / `gate` 返回 `runtimeStatus = "type_only"`、`market.serverTime = "unsupported"` 和 `order.reason = "not_implemented"`。
- Integration: 不调用 `client.start()` 也能查询。
- Integration: 修改返回对象的数组后再次查询，结果仍是原始 capability。
- Release: 新增或改变 public capability 字段时补 `.changeset/*.md`。

### 7. Wrong vs Correct

#### Wrong

```ts
export function getVenueCapabilities(venue: Venue): VenueCapabilities {
  return VENUE_CAPABILITIES[venue];
}
```

问题：

- capability 表远离 adapter，接入或修改 adapter 时容易忘记同步。
- 调用方可以修改返回对象，污染后续查询。

#### Correct

```ts
export function getVenueCapabilities(venue: Venue): VenueCapabilities {
  return cloneVenueCapabilities(
    composeVenueCapabilities({
      venue,
      marketAdapter,
      privateAdapter,
    }),
  );
}
```

效果：adapter 是领域能力真源，runtime 只做聚合，public 返回值只是可安全消费的快照。

## Scenario: Public `AcexError` 保留稳定分类，同时透传底层根因

### 1. Scope / Trigger

- Trigger: 修改 `src/errors.ts`、新增 public error 字段、调整 manager/runtime 对 adapter 错误的包装方式，或新增 adapter REST/WS 失败链路。
- 目标: SDK 用户用稳定 `AcexErrorCode` 做分支，同时能在 `catch` 里读取交易所拒绝原因和已脱敏 transport 诊断信息。

### 2. Signatures

公开错误入口：

```ts
export class AcexError extends Error {
  readonly code: AcexErrorCode;
  readonly details?: AcexErrorDetails;
  readonly cause?: unknown;
}

export interface AcexErrorDetails {
  readonly venue?: Venue;
  readonly accountId?: string;
  readonly symbol?: string;
  readonly venueError?: {
    readonly code?: string;
    readonly message?: string;
    readonly reason?:
      | "insufficient_balance"
      | "would_take"
      | "order_not_found"
      | "filter_violation"
      | "rate_limited"
      | "timestamp_out_of_sync"
      | "unknown";
  };
  readonly transport?: {
    readonly kind?: "timeout" | "http" | "network" | "rate_limited" | "parse";
    readonly status?: number;
    readonly statusText?: string;
    readonly retryAfterMs?: number;
    readonly retryable?: boolean;
    readonly attempts?: number;
    readonly rawBody?: string;
    readonly url?: string;
  };
  readonly orderState?: "not_placed" | "unknown";
}
```

根入口只导出 `AcexError`、`isOrderStateUnknown()`、`AcexErrorCode`、`VenueErrorReason` 和 `AcexError*Details` public types。不要从 `src/index.ts` 导出 `TransportError` 或 `isTransportError`。

### 3. Contracts

- `code` 是 SDK 稳定错误分类，调用方可用于程序分支。
- `message` 是日志/展示摘要，只包含 SDK 操作上下文和可选短交易所原因；不得拼入 rawBody、URL、headers、signature 或 credentials。
- `details.venueError` 是下游读取交易所拒绝原因的首选字段。MVP 只解析 Binance-style 顶层 JSON object：`{ code, msg }` 或 `{ code, message }`。
- `details.venueError.reason` 是 venue adapter 提供的稳定归一原因，当前公共枚举为 `insufficient_balance` / `would_take` / `order_not_found` / `filter_violation` / `rate_limited` / `timestamp_out_of_sync` / `unknown`。原始 `code/message` 必须继续保留；adapter 没有实现归一方法或没有结构化 `code` 时，`reason` 保持 `undefined`。
- `details.orderState` 只在订单命令错误（`ORDER_CREATE_FAILED` / `ORDER_CANCEL_FAILED` / `ORDER_CANCEL_ALL_FAILED` / `ORDER_INPUT_INVALID`）上填写：`unknown` 表示请求可能已到达交易所，`not_placed` 表示 SDK 判定订单未落地。`isOrderStateUnknown(error)` 是调用方判断该语义的 public helper。
- `details.transport` 只复制已脱敏的 `TransportError` 字段；`url` 必须来自 `TransportError.url`，`rawBody` 必须来自 `TransportError.rawBody`。
- `cause` 保留底层错误链，类型保持 `unknown`，不作为业务分支 API。
- adapter/internal 层仍只抛 `TransportError` 或普通 `Error`，不得构造 public `AcexError`；public 错误码归 manager/runtime 包装。

### 4. Validation & Error Matrix

| 场景 | `AcexError` 行为 | `orderState` |
|---|---|---|
| 下单/撤单 REST 返回 `{code,msg}` 且 HTTP < 500 | `ORDER_*_FAILED`，保留 `cause`，填 `details.venueError.code/message/reason` 和 `details.transport` | `not_placed` |
| 下单/撤单 timeout / network / parse | `ORDER_*_FAILED`，保留 `cause`，填可用 `details.transport` | `unknown` |
| 下单/撤单 HTTP >= 500 | `ORDER_*_FAILED`，保留 `cause`，填可用 `details.transport`；即使 body 可解析，也按执行状态未知处理 | `unknown` |
| 下单/撤单限流（`transport.kind === "rate_limited"`） | `ORDER_*_FAILED`，保留 `cause`，填可用 `details.venueError` / `details.transport` | `not_placed` |
| symbol 手续费费率查询失败 | `FEE_RATE_FETCH_FAILED`，保留 `cause`，填 `details.venue/accountId/symbol`、可用 `details.venueError` / `details.transport` | 不填 |
| account/order bootstrap 返回 `{code,msg}` | `ACCOUNT_BOOTSTRAP_FAILED` / `ORDER_BOOTSTRAP_FAILED`，保留 `cause`，填 `details.venueError` | 不填 |
| market catalog/server-time 返回纯文本/HTML | 不填 `details.venueError`，只填 `details.transport.rawBody/status/url` | 不填 |
| market public REST query（public aggregate trades / raw historical trades / funding history）失败 | `MARKET_PUBLIC_TRADES_FETCH_FAILED` / `MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED`，保留 `cause`，填 `details.venue/symbol` 和可用 `details.transport` / `details.venueError`。Binance `fetchPublicRawTrades()` 缺 market API key 也包装为 `MARKET_PUBLIC_TRADES_FETCH_FAILED`，且必须在加载 market catalog 前失败，不发任何远端请求。 | 不填 |
| market stream 订阅 ACK / 初始 ready 超时或被拒绝 | `MARKET_STREAM_TIMEOUT`，保留 `cause`，填 `details.venue/symbol`，不填 `details.venueError` | 不填 |
| network/timeout/parse 无可结构化交易所 body | 不填 `details.venueError`，保留 `cause` 与可用 transport metadata | 订单命令为 `unknown`，其他错误不填 |
| 本地订单输入校验错误 | 可填 `venue/accountId/symbol`，不填 `cause` / `transport` | `not_placed` |
| 敏感 query/body/header 出现在底层请求 | public `message`、`details.transport.url`、`details.transport.rawBody` 都不得泄漏敏感值 | 不影响 |

### 5. Good / Base / Bad Cases

#### Good

```ts
const details = buildAcexErrorDetails({ venue, accountId, symbol }, error);
throw new AcexError(code, formatAcexErrorMessage(message, details), {
  cause: error,
  details,
});
```

#### Base

```ts
throw new AcexError("ORDER_INPUT_INVALID", "Limit orders require price", {
  details: buildAcexErrorDetails({ venue, accountId, symbol }),
});
```

本地输入错误没有底层 transport cause，但可以附带上下文 details。

#### Bad

```ts
throw new AcexError("ORDER_CREATE_FAILED", error.message);
```

问题：

- 丢失 `cause`
- 可能把 URL/rawBody 拼进 public `message`
- 下游无法稳定读取交易所 code/message

### 6. Tests Required

修改错误模型或包装点时至少执行：

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- `AcexError` constructor 保留 `code`、`message`、`cause`、`details`。
- Binance-style `{code,msg}` / `{code,message}` 解析到 `details.venueError`，`code` string 化。
- `details.venueError.reason` 只由 adapter normalizer 注入；未知 Binance code 归一为 `unknown`，缺少 normalizer 时保持 `undefined`。
- 订单命令错误的 `orderState` 判定矩阵：timeout / network / parse / HTTP >= 500 为 `unknown`；结构化 venue 拒单 / 本地输入校验 / `rate_limited` / HTTP < 500 为 `not_placed`；非订单命令错误不填。
- `isOrderStateUnknown(error)` 只在 `AcexError.details.orderState === "unknown"` 时返回 `true`。
- 未知 JSON、HTML、纯文本、parse/network/timeout 不填 `details.venueError`。
- order command、market catalog/server time、market public REST query、market stream timeout、account/order bootstrap 失败都保留 `cause` 和正确 details。
- public `message`、`details.transport.url`、`details.transport.rawBody` 不泄漏 `signature`、`apiKey/key`、`secret`、`token/listenKey/passphrase` 等敏感值。

### 7. Wrong vs Correct

#### Wrong

```ts
this.context.publishRuntimeError("adapter", error, metadata);
return new AcexError("ORDER_CREATE_FAILED", "Failed to create order");
```

问题：error event 有底层原因，但 `await createOrder()` 的调用方在 `catch` 里拿不到根因。

#### Correct

```ts
this.context.publishRuntimeError("adapter", error, metadata);
const details = buildAcexErrorDetails(metadata, error);
return new AcexError(
  "ORDER_CREATE_FAILED",
  formatAcexErrorMessage("Failed to create order", details),
  { cause: error, details },
);
```

效果：保留 error event 语义，同时让直接调用命令的 SDK 用户在 `catch` 中读取 `error.details.venueError?.message`。

## Scenario: 事件流 buffer overflow 通过 runtime error 事件上报且防递归

### 1. Scope / Trigger

- Trigger: 修改 `AsyncEventBus.stream()` 的 buffer 上限、事件流订阅 options、manager/runtime 的事件总线接线，或新增公开事件流。
- 目标: 慢消费者积压时内存保持有界，同时通过稳定 `AcexErrorCode.EVENT_BUFFER_OVERFLOW` 给观测侧一个明确、非递归的丢事件信号。

### 2. Signatures

公开错误码必须包含：

```ts
export type AcexErrorCode =
  | "EVENT_BUFFER_OVERFLOW"
  // ...
```

overflow 通过 `client.events.errors()` 暴露为 runtime error event；`stream` / `maxBuffer` 是事件 metadata，不是 `AcexErrorDetails` 字段：

```ts
export interface AcexInternalError {
  source: "client" | "market" | "account" | "order" | "adapter" | "runtime";
  stream?: string;
  maxBuffer?: number;
  error: Error; // AcexError("EVENT_BUFFER_OVERFLOW", ...)
  ts: number;
}
```

### 3. Contracts

- 只有 `buffer` 模式订阅者积压超过 `maxBuffer`、并丢弃最旧事件腾位时，才发布 `EVENT_BUFFER_OVERFLOW`。
- 默认 buffer 上限为 `10_000`；调用方显式传 `maxBuffer` 时，overflow metadata 必须回显实际上限。
- 每个积压 episode 只发布一次 overflow；队列排空后重新武装，下一次重新积压并溢出时可以再次发布。
- `conflate` 模式天然按 key 有界，不使用 `maxBuffer`，也不触发 overflow。
- `errors()` 自身的 buffer 溢出只丢弃最旧 error event，不再向 `errorBus` 发布新的 overflow，避免递归。
- `AsyncEventBus` 是 Layer 0 原语，只调用注入的 `onOverflow({ maxBuffer })`；不得直接 import runtime、manager、`AcexError` 或 `errorBus`。
- `onOverflow` callback 只接收 `{ maxBuffer }`。`stream` 和 `source` 不进入基础设施层参数，由 manager/runtime 的 overflow handler 按所在事件流补齐到 `AcexInternalError` metadata。
- `AsyncEventBus` 不捕获 `onOverflow` 抛出的异常；上层注入的 overflow handler 必须保持同步、无副作用失败，并自行保证不会让错误发布路径抛出。

### 4. Validation & Error Matrix

| 场景 | `AcexError` / error event 行为 | `source` | metadata |
|---|---|---|---|
| market 事件流（`all` / `l1BookUpdates` / `fundingRateUpdates` / `status`）buffer 积压超过 `maxBuffer` | 发布一次 `AcexError("EVENT_BUFFER_OVERFLOW", "Event stream buffer overflow: <stream>")` | `"market"` | `stream` + `maxBuffer` |
| account 事件流（`updates` / `status`）buffer 积压超过 `maxBuffer` | 同上 | `"account"` | `stream` + `maxBuffer` |
| order 事件流（`updates` / `status`）buffer 积压超过 `maxBuffer` | 同上 | `"order"` | `stream` + `maxBuffer` |
| health 事件流 buffer 积压超过 `maxBuffer` | 同上 | `"runtime"` | `stream` + `maxBuffer` |
| errors 事件流 buffer 积压超过 `maxBuffer` | 只 drop oldest，不发布新的 overflow error | 不适用 | 不适用 |
| 同一订阅者已处于积压 episode 且继续溢出 | 不重复发布 overflow | 保持首次 source | 保持首次 metadata 形态 |
| 订阅者队列排空后再次溢出 | 再发布一次 overflow | 按所在流决定 | `stream` + `maxBuffer` |

### 5. Good / Base / Bad Cases

#### Good

```ts
this.context.publishRuntimeError("market", error, {
  stream: "market.l1BookUpdates",
  maxBuffer,
});
```

#### Base

```ts
return this.errorBus.stream(() => true, {
  maxBuffer: options?.maxBuffer,
});
```

`errors()` 保持有界 buffer，但不传 `onOverflow`，避免 overflow 事件产生 overflow 事件。

#### Bad

```ts
this.errorBus.stream(() => true, {
  maxBuffer,
  onOverflow: this.createOverflowHandler("client.errors"),
});
```

问题：`errors()` 自身溢出会递归发布新的 error event，慢错误消费者会放大故障。

### 6. Tests Required

修改 overflow 行为时至少执行：

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- buffer 超过 `maxBuffer` 后 drop oldest，而不是无限增长或关闭流。
- 同一积压 episode 只触发一次 `onOverflow`；队列排空后再次溢出会再次触发。
- pending consumer 等待时直接 hand-off，不进入 buffer，也不触发 overflow。
- manager/runtime overflow handler 传入正确 `source`、`stream` 和 `maxBuffer`。
- `errors()` 溢出不发布新的 `EVENT_BUFFER_OVERFLOW`。

### 7. Wrong vs Correct

#### Wrong

```ts
// src/internal/async-event-bus.ts
errorBus.publish(new AcexError("EVENT_BUFFER_OVERFLOW", message));
```

问题：

- Layer 0 依赖上层 runtime 事件总线
- `errors()` 难以防递归
- source / stream metadata 会被基础设施层猜测

#### Correct

```ts
// src/internal/async-event-bus.ts
options.onOverflow?.({ maxBuffer });
```

```ts
// src/managers/market-manager.ts
this.context.publishRuntimeError("market", error, {
  stream,
  maxBuffer,
});
```

效果：基础设施只报告溢出事实，manager/runtime 按所在事件流补齐错误分类和 metadata。
