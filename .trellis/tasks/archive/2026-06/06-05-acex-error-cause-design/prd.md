# brainstorm: AcexError 根因透传设计

## Goal

为 Acex SDK 设计一个不过度复杂的错误模型改进方案：保留现有稳定 `AcexErrorCode` 分类，同时让调用方在 `try/catch` 中能拿到交易所或底层 adapter 的真实拒绝原因。

## What I already know

* 现有 `AcexError` 主要表达 SDK 稳定错误分类，目前只有 `code` 和 `message`。
* client/account/market/order 都已有可预期失败的 `AcexErrorCode` 覆盖，不是只有订单链路封装 `AcexError`。
* 订单链路中 `createOrder` / `cancelOrder` 捕获 adapter `TransportError` 后，会发布 adapter 错误事件，但最终 reject 的新 `AcexError` 没有保留底层错误。
* market catalog/server time 失败也有同类模式：底层 adapter error 发布到 error event，但抛出的 `AcexError` 不包含 `cause`。
* 用户希望先对比 ccxt 和主流 SDK/error 设计方式，再收敛到不过度复杂的方案。

## Assumptions (temporary)

* 目标是兼容现有 `AcexErrorCode` 使用方式，避免破坏用户依赖 `error.code` 的逻辑。
* 根因透传的 MVP 覆盖所有当前明确会丢失底层根因的包装点。

## Open Questions

* 无。已确认 MVP 采用 `cause` + 小型公开 `details`，其中 `details.exchange` 用于结构化交易所原因，`details.transport.rawBody` 仅作为无法结构化时的诊断兜底。

## Requirements (evolving)

* 保留 `AcexErrorCode` 作为稳定分类。
* 让调用方可从抛出的 `AcexError` 访问底层根因。
* 避免引入过深的错误类型层级或复杂 normalization。
* 对比 ccxt 和主流 JavaScript/TypeScript SDK 的错误设计后再定方案。
* 不公开 adapter-only 的 internal `TransportError`，只公开 `AcexError` 及其 `details` 类型。
* 不从 `src/index.ts` 导出 `TransportError` / `isTransportError`。

## Research References

* [`research/error-design-comparison.md`](research/error-design-comparison.md) — ccxt 偏错误类层级和 per-exchange mapping；Stripe/Axios/AWS 更偏公共错误对象上的 raw/metadata/cause，后者更适合当前 Acex。

## Candidate Designs

### A. 只给 `AcexError` 增加 `cause`

示意：

```ts
new AcexError("ORDER_CREATE_FAILED", message, { cause: error });
```

Pros:

* 最小变更，符合 native JavaScript `ErrorOptions.cause`。
* 向后兼容，现有 `code` / `message` 不变。
* 与现有 `TransportError` 风格一致。

Cons:

* `TransportError` 当前是 internal type，SDK 用户在 TypeScript 中只能通过 `err.cause instanceof Error` 或手写 duck typing 访问 `rawBody/status`。
* 对“catch 里直接拿到交易所拒绝原因”的体验仍偏弱。

### B. `cause` + 小型公开 `details`（推荐）

示意：

```ts
new AcexError("ORDER_CREATE_FAILED", message, {
  cause: error,
  details: {
    venue,
    accountId,
    symbol,
    exchange: {
      code: "-2010",
      message: "Account has insufficient balance...",
    },
    transport: {
      kind,
      status,
      statusText,
      retryAfterMs,
      retryable,
      attempts,
      rawBody,
      url,
    },
  },
});
```

Pros:

* 保留完整根因链：`error.cause` 是底层 Error。
* 调用方不需要 import internal `TransportError`，即可读取交易所拒绝原因和常用诊断字段。
* 字段来自现有 `TransportError`，不需要新增复杂解析逻辑。
* 可用于 order、market catalog/server time、account/order bootstrap 等包装点。

Cons:

* `AcexError` 公开 API 增加一个新字段，需要文档和测试。
* `rawBody` 虽然已由 http-client redaction 处理，但仍应只放 redacted body，不能复制未脱敏请求参数。

### C. ccxt 式错误 taxonomy / exchange rejection normalization

示意：

```ts
class InsufficientFundsError extends AcexError {}
class OrderNotFoundError extends AcexError {}
```

或：

```ts
details: {
  exchange: {
    code: "-2010",
    message: "Account has insufficient balance...",
    normalizedReason: "insufficient_funds",
  },
}
```

Pros:

* 对交易 SDK 用户最友好，能直接分支处理 `InsufficientFunds`、`OrderNotFound`、`RateLimitExceeded`。
* 更接近 ccxt 这种成熟多交易所库。

Cons:

* 需要大量 per-venue/per-endpoint 映射和维护。
* 很容易把 Binance 的 schema 误当成所有 venue 的标准。
* 对当前阶段过重，且可能导致错误分类 API 提前固化。

## Recommended MVP

选择 B：`AcexError` 增加 native `cause` 和小型公开 `details`，其中 `details.exchange` 属于 MVP 字段但按可解析性填充；暂不做 ccxt 式错误 taxonomy。

字段职责：

* `error.code`：SDK 稳定错误分类，用于程序分支。
* `error.message`：人类可读摘要，用于日志和简单展示；应保留操作上下文，并在有明确交易所拒绝原因时追加短原因。
* `error.details.exchange`：交易所返回的结构化拒绝原因，供下游精确读取。
* `error.details.transport`：HTTP/transport 诊断信息，作为排障和兜底。
* `error.cause`：底层错误链，供高级调试，不作为业务逻辑首选字段。

### MVP Implementation Scope

| 链路 | 覆盖要求 |
|---|---|
| `createOrder()` / `cancelOrder()` / `cancelAllOrders()` | must cover：命令失败抛出的 `AcexError` 必须保留 `cause`，填充 `details`，Binance `{code,msg}` 响应应填 `details.exchange` |
| `market.loadMarkets()` / catalog reload | must cover：catalog adapter 失败包装为 `MARKET_CATALOG_LOAD_FAILED` 时保留 `cause`，填充 transport 诊断；纯文本/HTML 错误不填 `details.exchange` |
| `market.fetchServerTime()` | must cover：server time adapter 失败包装为 `MARKET_SERVER_TIME_FETCH_FAILED` 时保留 `cause`，填充 transport 诊断 |
| `subscribeAccount()` bootstrap | must cover：`ACCOUNT_BOOTSTRAP_FAILED` 保留底层 `cause`，Binance-style 错误可填 `details.exchange` |
| `subscribeOrders()` bootstrap | must cover：`ORDER_BOOTSTRAP_FAILED` 保留底层 `cause`，Binance-style 错误可填 `details.exchange` |

### Field Contract

* `message` 只放简短人类可读摘要：SDK 操作上下文 + 可选的短交易所原因；不得拼入 rawBody、URL、headers、credentials、signature。
* `details.exchange` 只放 SDK 明确识别出的交易所错误结构；`code` 必须 string 化，`message` 必须是交易所返回的人类可读原因。
* `details.transport` 只复制已脱敏的 transport metadata；`url` 必须来自 `TransportError.url`，`rawBody` 必须来自 `TransportError.rawBody`。
* `details.transport.rawBody` 可以在底层响应体存在时复制，用于诊断；下游业务读取交易所原因时不应优先依赖它。
* `cause` 类型保持为 `unknown`；可保留原始 `TransportError` 或普通 `Error`，但不是业务分支 API。

推荐字段：

```ts
export interface AcexErrorDetails {
  readonly venue?: Venue;
  readonly accountId?: string;
  readonly symbol?: string;
  readonly exchange?: AcexExchangeErrorDetails;
  readonly transport?: AcexErrorTransportDetails;
}

export interface AcexExchangeErrorDetails {
  readonly code?: string;
  readonly message?: string;
}

export interface AcexErrorTransportDetails {
  readonly kind?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  readonly attempts?: number;
  readonly rawBody?: string;
  readonly url?: string;
}
```

下单失败示例：

```ts
new AcexError(
  "ORDER_CREATE_FAILED",
  "Failed to create order for main-binance: BTC/USDT:USDT (Binance rejected: Account has insufficient balance...)",
  {
    cause: transportError,
    details: {
      venue: "binance",
      accountId: "main-binance",
      symbol: "BTC/USDT:USDT",
      exchange: {
        code: "-2010",
        message: "Account has insufficient balance...",
      },
      transport: {
        kind: "http",
        status: 400,
        rawBody: "{\"code\":-2010,\"msg\":\"Account has insufficient balance...\"}",
      },
    },
  },
);
```

`details.exchange` 应由 adapter 或明确的 venue parser 显式提取，不在 `AcexError` 通用层猜测所有 raw body。无法解析时不填 `details.exchange`，下游可再用 `details.transport.rawBody` 做诊断兜底。

用户确认：该分层可接受。下游业务读取交易所拒绝原因时首选 `error.details.exchange?.message` / `error.details.exchange?.code`；只有网络失败、超时、HTML/纯文本错误页、未知 JSON 结构、JSON 解析失败等不能结构化识别的场景，才退回查看 `error.details.transport?.rawBody`。

### Exchange Parser Contract

MVP parser 只支持明确的 Binance-style JSON object：

* `{ "code": -2010, "msg": "Order would immediately trigger." }`
* `{ "code": -2010, "message": "Order would immediately trigger." }`

规则：

* `code` 可以是 string 或 number，输出时统一转成 string。
* `msg` / `message` 必须是非空 string。
* 只解析顶层 object；数组、嵌套结构、未知字段名、HTML、纯文本、空 body、parse/network/timeout 错误都不填 `details.exchange`。
* 不做 `normalizedReason`、不新增 `InsufficientFunds` / `OrderNotFound` 等 taxonomy。

### Security Contract

实现和测试必须保证：

* `AcexError.message` 不包含 `signature`、`apiKey` / `api_key` / `key`、`secret`、`token` / `access_token`、`listenKey` / `listen_key`、`passphrase` 等敏感值。
* `details.transport.url` 只复制已脱敏 URL，不复制原始请求 URL。
* `details.transport.rawBody` 只复制已脱敏 body，不复制 headers、credentials 或未脱敏 body。
* adapter 层仍不得构造 `AcexError`；public 错误码仍归 manager/runtime 包装。

## Acceptance Criteria (evolving)

* [x] 形成 2-3 个可行方案，并说明取舍。
* [x] 推荐一个 MVP 设计，明确字段、兼容性和覆盖范围。
* [x] PRD 记录研究结论和最终选择。
* [x] `AcexError` constructor 支持 `{ cause, details }`，且 `code` / `message` 现有用法保持兼容。
* [x] order command 失败可在 reject 的 `AcexError.details.exchange` 读取 Binance `{code,msg}`。
* [x] market catalog/server time 失败保留 `cause` 与 `details.transport`，不可结构化 body 不填 `details.exchange`。
* [x] account/order bootstrap 失败保留 `cause` 与可解析的 `details.exchange`。
* [x] 安全测试覆盖 message/url/rawBody 不泄漏敏感值。
* [x] `docs/api.md` 更新错误处理示例。

## Definition of Done (team quality bar)

* 设计决策明确，可指导后续实现。
* 补充或更新单元/集成测试覆盖 constructor、parser、order、market、bootstrap failure。
* Lint / typecheck / CI green。
* 文档或类型注释随行为变化更新。

## Out of Scope (explicit)

* 暂不重写所有 adapter 的错误解析。
* 暂不建立完整的跨交易所错误码标准化体系。
* 暂不移除或重命名现有 `AcexErrorCode`。

## Technical Notes

* `src/errors.ts` 当前 `AcexError` 只有 `code` / `message`。
* `src/internal/http-client.ts` 的 `TransportError` 已有 `cause`、`kind`、`status`、`statusText`、`retryAfterMs`、`retryable`、`attempts`、`headers`、`rawBody`、`url`。
* `src/managers/order-manager.ts` 的 `wrapCommandError()` 当前发布 adapter error event 后返回新的 `AcexError`，没有挂 `cause`。
* `src/managers/market-manager.ts` 的 `createCatalogLoadError()` / `createServerTimeFetchError()` 也有类似包装方式。
* `src/client/private-subscription-coordinator.ts` 的 account/order bootstrap failure 也会包装成新的 `AcexError`，本任务同批覆盖。
* 子代理 PRD review 结论：字段分层方向 Go，但实现前必须明确范围、parser contract、安全验收和测试验收；这些已在本 PRD 中补齐。
