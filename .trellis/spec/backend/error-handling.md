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
}
```

根入口只导出 `AcexError`、`AcexErrorCode` 和 `AcexError*Details` public types。不要从 `src/index.ts` 导出 `TransportError` 或 `isTransportError`。

### 3. Contracts

- `code` 是 SDK 稳定错误分类，调用方可用于程序分支。
- `message` 是日志/展示摘要，只包含 SDK 操作上下文和可选短交易所原因；不得拼入 rawBody、URL、headers、signature 或 credentials。
- `details.venueError` 是下游读取交易所拒绝原因的首选字段。MVP 只解析 Binance-style 顶层 JSON object：`{ code, msg }` 或 `{ code, message }`。
- `details.transport` 只复制已脱敏的 `TransportError` 字段；`url` 必须来自 `TransportError.url`，`rawBody` 必须来自 `TransportError.rawBody`。
- `cause` 保留底层错误链，类型保持 `unknown`，不作为业务分支 API。
- adapter/internal 层仍只抛 `TransportError` 或普通 `Error`，不得构造 public `AcexError`；public 错误码归 manager/runtime 包装。

### 4. Validation & Error Matrix

| 场景 | `AcexError` 行为 |
|---|---|
| 下单/撤单 REST 返回 `{code,msg}` | `ORDER_*_FAILED`，保留 `cause`，填 `details.venueError.code/message` 和 `details.transport` |
| account/order bootstrap 返回 `{code,msg}` | `ACCOUNT_BOOTSTRAP_FAILED` / `ORDER_BOOTSTRAP_FAILED`，保留 `cause`，填 `details.venueError` |
| market catalog/server-time 返回纯文本/HTML | 不填 `details.venueError`，只填 `details.transport.rawBody/status/url` |
| network/timeout/parse 无可结构化交易所 body | 不填 `details.venueError`，保留 `cause` 与可用 transport metadata |
| 本地校验错误 | 可填 `venue/accountId/symbol`，不填 `cause` / `transport` |
| 敏感 query/body/header 出现在底层请求 | public `message`、`details.transport.url`、`details.transport.rawBody` 都不得泄漏敏感值 |

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
- 未知 JSON、HTML、纯文本、parse/network/timeout 不填 `details.venueError`。
- order command、market catalog/server time、account/order bootstrap 失败都保留 `cause` 和正确 details。
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

