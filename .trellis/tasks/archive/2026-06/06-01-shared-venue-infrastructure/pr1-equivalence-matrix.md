# PR1 行为等价矩阵

> 范围：共享 HTTP 客户端 + Binance private、Binance catalog、Juplend 三处迁移。唯一有意行为差异是 D5 redaction；PR1 另新增 typed transport error、headers 暴露、timeout 与显式 retry 地基。

| 类别 | 迁移前 | 迁移后 | 结论 |
|---|---|---|---|
| Binance catalog fetch 注入 | `loadBinanceMarkets(fetchFn = fetch)`，`fetchJson(fetchFn, url)` | `loadBinanceMarkets(fetchFn = fetch)`，传入 `httpRequest({ fetchFn })` | 保持 |
| Binance catalog method/header/query | 裸 `fetchFn(url)`，默认 GET，无额外 header/query | `httpRequest` 默认 GET，无额外 header/query | 保持 |
| Binance catalog success JSON | 成功走 `response.json()` | `jsonParseMode: "response"`，成功仍走 `response.json()` | 保持 |
| Binance catalog empty body | 由 `response.json()` 自然失败 | 仍由 `response.json()` 自然失败并 typed 为 `kind: "parse"` | parse 类型更精确；业务失败语义保持 |
| Binance catalog JSON parse 失败 | `response.json()` 抛原始 parse error | typed transport error `kind: "parse"`，adapter/manager 冒泡/包装 | 有意归一 |
| Binance catalog non-2xx body | message 只含 status/statusText，不保留 body | message 仍只含 status/statusText；typed error `rawBody` 保留 redacted body | public message 保持，debug 字段新增 |
| Binance catalog timeout | 无 timeout | 默认 10s per-attempt timeout | PR1 新能力 |
| Binance catalog upstream signal | 无调用点 | 客户端支持，catalog 当前不传 signal | 地基新增，不改变调用 |
| Binance catalog error message | `Binance request failed: <status> <statusText>` | 同格式 | 保持 |
| Binance catalog raw body 保留 | 无 | typed `rawBody` 保留 redacted body | 新增 |
| Binance catalog header 暴露 | 无 | `HttpClientResponse.headers` / `TransportError.headers` | 新增，服务 PR3 |
| Binance signed GET fetch 注入 | 直接 `fetch` | adapter constructor internal-only `fetchFn`；runtime 默认 `fetch` | 默认保持；测试注入能力新增 |
| Binance signed GET method/header/query | GET；query 含 call params + `timestamp` + `recvWindow` + `signature`；`X-MBX-APIKEY` header | 同 method/header/query；`accountOptions.timestamp` 仍优先，`recvWindow` 默认/override 不变 | 保持 |
| Binance signed GET empty body | 空 body 返回 `{}` | `emptyBody: "empty_object"` | 保持 |
| Binance signed GET JSON parse 失败 | `JSON.parse(text)` 抛原始 parse error | typed `kind: "parse"` | 有意归一 |
| Binance signed GET non-2xx body | message 含 status/statusText/完整 signed URL/body | typed `kind: "http"` 或 `rate_limited`；`rawBody` redacted 保留；message 不含完整 signed query | body 保留；redaction 是 intended diff |
| Binance signed GET timeout | 无 timeout | 默认 10s timeout | PR1 新能力 |
| Binance signed GET upstream signal | 无调用点 | 客户端支持，signed GET 当前不传 signal | 地基新增，不改变调用 |
| Binance signed GET retry | 无 retry | 显式 `SAFE_READ_RETRY_POLICY`：idempotent GET，network/timeout/5xx 最多 3 次；429/418 不重放 | PR1 新能力 |
| Binance signed GET error message | 可能泄漏完整 signed URL | 不含 `signature`、API key、完整 signed query | intended diff：D5 redaction |
| Binance signed GET raw body 保留 | message 里有 body | typed `rawBody` 保留 redacted body | 保持/更结构化 |
| Binance signed GET header 暴露 | 无 | response/error headers 暴露 | 新增，服务 PR3 |
| Binance order POST/DELETE fetch 注入 | 直接 `fetch` | adapter constructor internal-only `fetchFn`；runtime 默认 `fetch` | 默认保持；测试注入能力新增 |
| Binance order POST/DELETE method/header/query | `POST /papi/v1/um/order`、`DELETE /papi/v1/um/order`、`DELETE /papi/v1/um/allOpenOrders`；signed query；`X-MBX-APIKEY` | 同 method/path/header/query/signing | 保持 |
| Binance order POST/DELETE empty body | 空 body返回 `{}` | `emptyBody: "empty_object"` | 保持 |
| Binance order POST/DELETE JSON parse 失败 | 原始 parse error | typed `kind: "parse"` | 有意归一 |
| Binance order POST/DELETE non-2xx body | message 含完整 signed URL/body | typed body 保留，message redacted | intended diff：D5 redaction |
| Binance order POST/DELETE timeout | 无 timeout | 默认 10s timeout | PR1 新能力 |
| Binance order POST/DELETE retry | 无 retry | 显式 `NO_RETRY_POLICY`，network/timeout/5xx/429/418 均不重放 | 保持非重试语义 |
| Binance order POST/DELETE header 暴露 | 无 | response/error headers 暴露 | 新增 |
| Binance listenKey POST fetch 注入 | 直接 `fetch` | adapter constructor internal-only `fetchFn`；runtime 默认 `fetch` | 默认保持 |
| Binance listenKey POST method/header/query | `POST /papi/v1/listenKey`，`X-MBX-APIKEY`，无 query | 同 | 保持 |
| Binance listenKey POST retry | 无 retry | 显式 `NO_RETRY_POLICY` | 保持 |
| Binance listenKey PUT method/header/query | `PUT /papi/v1/listenKey?listenKey=...`，`X-MBX-APIKEY` | 同；URL redaction 会隐藏 listenKey | 保持；redaction 新增 |
| Binance listenKey PUT retry | 无 retry | 显式 keepalive retry：network/timeout/5xx 最多 3 次；429/418 不重放 | PR1 新能力 |
| Binance listenKey DELETE method/header/query | `DELETE /papi/v1/listenKey?listenKey=...`，`X-MBX-APIKEY` | 同 | 保持 |
| Binance listenKey DELETE retry | 无 retry | 显式 `NO_RETRY_POLICY` | 保持 |
| Binance listenKey empty body | 空 body 返回 `{}` | `emptyBody: "empty_object"` | 保持 |
| Binance listenKey non-2xx body | message 含 URL/body | typed body 保留，message redacted | intended diff：D5 redaction |
| Juplend fetch 注入 | 直接 `fetch`，通过 global fake 测试 | constructor 第 3 参数 internal-only `fetchFn`；runtime 默认 `fetch` | 默认保持；测试注入能力新增 |
| Juplend method/header/query | GET；Jup API key 用 `x-api-key`；query 由原调用构造 | 同 method/header/query | 保持 |
| Juplend success JSON | 成功走 `response.json()` | `jsonParseMode: "response"`，成功仍走 `response.json()` | 保持 |
| Juplend empty body | 由 `response.json()` 自然失败 | 仍由 `response.json()` 自然失败并 typed 为 `kind: "parse"` | parse 类型更精确 |
| Juplend JSON parse 失败 | 原始 parse error | typed `kind: "parse"` | 有意归一 |
| Juplend non-2xx body | message `Juplend HTTP <status>: <statusText>`，不带 body | message 保持；typed `rawBody` 保留 redacted body | public message 保持，debug 字段新增 |
| Juplend timeout | `AbortController` 10s，message `Juplend fetch timeout after 10000ms` | 共享客户端 10s，message 保持 | 保持 |
| Juplend upstream signal | upstream abort 传播到内部 controller；message `Juplend fetch aborted` | 共享客户端合并 upstream signal；message 保持 | 保持 |
| Juplend retry | 无 retry | read-only GET 显式 idempotent retry：network/timeout/5xx 最多 3 次；429/418 不重放 | PR1 新能力 |
| Juplend error message | 固定 Juplend HTTP/timeout/abort 文案 | 文案保持，transport 字段新增 | 保持 |
| Juplend raw body 保留 | 无 | typed `rawBody` 保留 redacted body | 新增 |
| Juplend header 暴露 | 无 | response/error headers 暴露 | 新增 |

## Intended Diff 清单

- D5 redaction：所有对外 message 不包含 `signature`、API key、secret、完整 signed query；typed error 中只保留 redacted URL/body。
- HTTP typed error：非 2xx、timeout、network、parse、429/418 均结构化为 `TransportError`，adapter 不构造 `AcexError`。
- Headers 暴露：成功响应与 transport error 都保留 `Headers`，供 PR3 limiter 读取。
- Retry/timeout 地基：read-only GET 与 listenKey keepalive PUT 按显式策略有限重试；order POST/DELETE、listenKey POST/DELETE 显式不重试；429/418 只分类和解析 `Retry-After`，PR1 不 sleep/重放。
