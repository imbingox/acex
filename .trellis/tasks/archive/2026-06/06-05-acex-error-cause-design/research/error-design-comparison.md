# Error design comparison

## Scope

本研究用于指导 Acex SDK 的 `AcexError` 根因透传设计。目标不是复制完整外部 SDK，而是判断哪些模式适合当前仓库：

* 现有公开错误分类为 `AcexErrorCode`。
* 底层 HTTP/adapter 失败已有 `TransportError`，包含 `kind`、`status`、`statusText`、`retryAfterMs`、`retryable`、`attempts`、`headers`、`rawBody`、`url`、`cause`。
* `TransportError` 目前位于 `src/internal/http-client.ts`，不是公开 API。

## ccxt

Source:

* `https://github.com/ccxt/ccxt/blob/master/ts/src/base/errors.ts`
* `https://github.com/ccxt/ccxt/blob/master/ts/src/base/Exchange.ts`
* `https://github.com/ccxt/ccxt/blob/master/ts/src/binance.ts`

Pattern:

* ccxt 有较深的错误类层级，例如 `ExchangeError`、`AuthenticationError`、`PermissionDenied`、`InsufficientFunds`、`InvalidOrder`、`OrderNotFound`、`OperationFailed`、`NetworkError`、`RateLimitExceeded`、`RequestTimeout`。
* 每个 exchange 可以维护 `exceptions.exact` / `exceptions.broad` 映射，把交易所错误码或消息映射到 ccxt 的语义错误类。
* `Exchange` 保留 `last_http_response`、`last_json_response`、`last_response_headers`、`last_request_*` 这类诊断字段，并在 `handleErrors(...)` 后按 HTTP status 兜底。

Implication for Acex:

* ccxt 的强项是跨交易所语义归一化，但成本是大量 per-exchange mapping 和错误类层级维护。
* Acex 当前还处在少量 venue/adapter 阶段，不宜直接引入 ccxt 风格的完整错误 taxonomy。
* 可以借鉴“稳定分类 + 原始响应可诊断”的思路，但不必在 MVP 阶段做 `InsufficientFunds` / `OrderNotFound` 等跨交易所归一化。

## Stripe Node SDK

Source:

* `https://github.com/stripe/stripe-node/blob/master/src/Error.ts`

Pattern:

* `StripeError` 是基类，派生 `StripeCardError`、`StripeInvalidRequestError`、`StripeRateLimitError`、`StripeAPIError` 等。
* 错误对象保留 provider 返回的结构化字段：`type`、`raw`、`rawType`、`code`、`doc_url`、`param`、`detail`、`headers`、`requestId`、`statusCode`、`decline_code` 等。
* 这种模式适合单 provider 或 provider error schema 稳定的场景。

Implication for Acex:

* 可以借鉴“公共错误对象上保留 raw/provider metadata”。
* 不宜直接套用 Stripe 的大量 provider-specific 字段，因为 Acex 是多 venue SDK，不同交易所字段不统一。

## Axios

Source:

* `https://github.com/axios/axios/blob/v1.x/index.d.ts`
* `https://github.com/axios/axios/blob/v1.x/lib/core/AxiosError.js`

Pattern:

* `AxiosError` 顶层字段包括 `code`、`config`、`request`、`response`、`status`、`isAxiosError`、`cause`。
* `AxiosError.from(...)` 会把原始错误挂到 `cause`。
* `response` 保留 HTTP 响应对象，调用方可自行读取 `response.status` / `response.data`。

Implication for Acex:

* 适合 Acex 的地方是：包装错误时保留 `cause`，同时提供少量 HTTP/transport 诊断字段。
* Acex 不应暴露完整 request/config，避免凭证、签名、URL 查询参数等泄露风险。

## AWS SDK JS v3 / Smithy

Source:

* `https://unpkg.com/@smithy/core@3.24.6/dist-types/submodules/client/smithy-client/exceptions.d.ts`
* `https://unpkg.com/@smithy/types@4.14.3/dist-types/response.d.ts`
* `https://unpkg.com/@smithy/types@4.14.3/dist-types/shapes.d.ts`

Pattern:

* `ServiceException` extends `Error`，包含 `name`、`message`、`$fault`、`$retryable`、`$metadata`、`$response`。
* `$metadata` 是公开、相对稳定、可诊断的响应元数据，例如 `httpStatusCode`、`requestId`、`attempts`、`totalRetryDelay`。
* `$response` 是低层 HTTP response 引用。

Implication for Acex:

* 值得借鉴“结构化 metadata + 原始底层响应引用”的分层。
* 对 Acex 而言，`details.transport` 可以承担 `$metadata` 的角色，`cause` 承担底层错误引用角色。

## Native JavaScript Error cause

Project constraint:

* 仓库 `tsconfig.json` 使用 `target: "ESNext"`、`lib: ["ESNext"]`。
* `TransportError` 已经使用 `super(message, { cause })` 并声明 `override readonly cause?: unknown`。

Implication for Acex:

* `AcexError` 可以同样支持 `ErrorOptions.cause`，与现有代码风格一致。
* 这是最低成本且最符合 JS 生态的根因透传方式。

## Recommended direction

不要走 ccxt 式完整错误 taxonomy。Acex 更适合：

1. 保留 `AcexErrorCode` 作为 SDK 稳定错误分类。
2. 扩展 `AcexError` 支持 `cause`。
3. 增加一个小型公开 `details` 对象，复制调用方常用且安全的上下文、交易所拒绝原因和 transport metadata。
4. `details.venueError` 作为 MVP 的可选字段：adapter 或明确的 venue parser 能解析交易所错误结构时填充；不能解析时不填，由 `details.transport.rawBody` 兜底。不要在通用 `AcexError` 层猜测所有 raw body。
