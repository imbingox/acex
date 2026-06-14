# Error Handling

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
| symbol 手续费费率查询失败 | `ORDER_FEE_RATE_FETCH_FAILED`，保留 `cause`，填 `details.venue/accountId/symbol`、可用 `details.venueError` / `details.transport` | 不填 |
| account/order bootstrap 返回 `{code,msg}` | `ACCOUNT_BOOTSTRAP_FAILED` / `ORDER_BOOTSTRAP_FAILED`，保留 `cause`，填 `details.venueError` | 不填 |
| market catalog/server-time 返回纯文本/HTML | 不填 `details.venueError`，只填 `details.transport.rawBody/status/url` | 不填 |
| market stream 首包超时 | `MARKET_STREAM_TIMEOUT`，保留 `cause`，填 `details.venue/symbol`，不填 `details.venueError` | 不填 |
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
- order command、market catalog/server time、market stream timeout、account/order bootstrap 失败都保留 `cause` 和正确 details。
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
- `AsyncEventBus` 是 Layer 0 原语，只调用注入的 `onOverflow`；不得直接 import runtime、manager、`AcexError` 或 `errorBus`。

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
