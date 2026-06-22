# Account funding fee history API Design

## Architecture

本任务按现有 SDK 5 层结构落地：

- Public contract：`src/types/account.ts` 增加 funding fee history 输入、输出和 `AccountManager.fetchFundingFeeHistory()`。
- Capability：`src/types/client.ts` 的 `VenueAccountCapabilities` 增加账户级 funding fee history 能力字段。
- Manager：`src/managers/account-manager.ts` 负责输入校验、symbols 策略、query-level pagination、错误包装、canonical decimal 和排序。
- Runtime context：`src/client/context.ts` / `src/client/runtime.ts` 增加 private read 转发方法，只做 account / adapter / credentials / support 检查。
- Adapter SPI：`src/adapters/types.ts` 在 `PrivateUserDataAdapter` 上增加可选 `fetchFundingFeeHistory()`，返回标准 `RawFundingFeeHistoryResult`。
- Binance adapter：`src/adapters/binance/private-adapter.ts` 使用 PAPI UM income history，固定 `incomeType=FUNDING_FEE`。
- Rate limit：`src/adapters/binance/rate-limit-topology.ts` 增加 PAPI UM income history semantic plan，按 Binance 文档权重 30 计入 PAPI request-weight bucket。
- Docs / tests：同步 README、`docs/managers.md`、`docs/types.md`、`docs/errors.md`、`docs/capabilities.md` 和对应 unit / integration tests。

## Public API

```ts
export interface FetchFundingFeeHistoryInput {
  accountId: string;
  symbols?: string[];
  startTs?: number;
  endTs?: number;
  page?: number;
  limit?: number;
}

export interface FundingFeeHistoryEntry {
  accountId: string;
  venue: Venue;
  symbol: string;
  asset: string;
  amount: string;
  fundingTime: number;
  receivedAt: number;
  venueTransactionId?: string;
  tradeId?: string;
  positionSide?: PositionSide;
  raw: Record<string, unknown>;
}

export interface FetchFundingFeeHistoryResult {
  fees: FundingFeeHistoryEntry[];
  startTs?: number;
  endTs?: number;
  page: number;
  limit: number;
  truncated: boolean;
  nextPage?: number;
}
```

`symbols` 语义：

- `undefined`：查询全账户 funding fee history。
- `[]`：直接返回空结果，不发远端请求。
- 去重后长度 `<= 5`：manager 内部按 symbol 循环调用 adapter。
- 去重后长度 `> 5`：manager 内部走 account-scan，并按 symbols 本地过滤。

`limit` 语义：

- 默认 1000，最大 1000。
- 它是底层 venue 请求 page size，不保证合并后的 `fees.length <= limit`。例如 per-symbol 路径一次可能返回最多 `symbols.length * limit` 条。

`truncated` 语义：

- 是 query-level pagination，不是 per-symbol completeness。
- per-symbol 路径：任意一个底层 symbol 查询返回数量达到 `limit`，则 `truncated = true`。
- account-scan 路径：账户级 income page 返回数量达到 `limit`，则 `truncated = true`。
- `truncated = true` 时 `nextPage = page + 1`；下游应保持同一查询条件请求下一页。

## Adapter Contract

```ts
export interface FetchFundingFeeHistoryRequest {
  symbol?: string;
  startTs?: number;
  endTs?: number;
  page: number;
  limit: number;
}

export interface RawFundingFeeHistoryEntry {
  symbol: string;
  asset: string;
  amount: string;
  fundingTime: number;
  receivedAt: number;
  venueTransactionId?: string;
  tradeId?: string;
  positionSide?: PositionSide;
  raw: Record<string, unknown>;
}

export interface RawFundingFeeHistoryResult {
  fees: RawFundingFeeHistoryEntry[];
  truncated: boolean;
}
```

Binance adapter 细节：

- Endpoint：`GET /papi/v1/um/income`。
- Query：
  - `incomeType=FUNDING_FEE`
  - `symbol` 仅在单 symbol 查询时传入，使用 Binance UM venue id。
  - `startTime` / `endTime` / `page` / `limit` 按 input 映射。
- Response 映射：
  - `symbol`：Binance venue id 映射回 unified symbol。
  - `asset`：原样字符串。
  - `amount`：来自 `income`，manager 出口 canonical 化。
  - `fundingTime`：来自 `time`。
  - `venueTransactionId`：来自 `tranId`，转成 string。
  - `tradeId`：存在且非空时保留。
  - `positionSide`：Binance income history 没有该字段时不填。
  - `raw`：保留原始 entry 浅拷贝。
- `truncated`：`response.length >= limit`。

## Error Handling

新增 public error code：

- `ACCOUNT_INPUT_INVALID`：本地 input 校验失败，例如 `page < 1`、`limit > 1000`、时间范围非法。
- `ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED`：adapter 请求、响应结构、symbol mapping 或远端失败。

错误包装要求：

- 未 start：沿用 `CLIENT_NOT_STARTED`。
- accountId 不存在：沿用 `ACCOUNT_NOT_FOUND`。
- 缺 private credentials：沿用 `CREDENTIALS_MISSING`。
- adapter 未实现：沿用 `VENUE_NOT_SUPPORTED`。
- adapter 抛错：manager 包装为 `ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED`，保留 `cause`，并填充 `details.venue/accountId/symbol` 与可用 transport / venue error。
- 多 symbol 循环中任一 symbol 失败时，整个调用失败，不返回部分结果。第一版不做 partial success。

## Capability

`VenueAccountCapabilities` 增加：

```ts
fundingFeeHistory: VenueCapabilitySupport;
```

取值：

- Binance：`"supported"`。
- Deribit / Juplend / type-only venue：`"unsupported"`。

Capability 查询不检查实际 API key 权限，只表示当前 SDK runtime 是否实现该能力。

## Data Flow

1. 下游调用 `client.account.fetchFundingFeeHistory(input)`。
2. `AccountManagerImpl` 校验 page / limit / time range，规范化 symbols。
3. Manager 根据 symbols 数量选择内部查询路径：
   - empty：返回空结果。
   - undefined：调用 context 一次，`symbol` 不传。
   - `<= 5`：逐 symbol 调用 context。
   - `> 5`：调用 context 一次，`symbol` 不传，然后过滤 symbols。
4. `AcexClientImpl` 获取 account、private adapter、credentials，检查 `accountCapabilities.fundingFeeHistory` 与 adapter hook。
5. Binance adapter 构造 signed PAPI 请求，固定 `incomeType=FUNDING_FEE`。
6. Adapter 返回 raw entries；manager canonical 化、补 account/venue、排序并生成 result。

## Pagination Example

下游拉完整时间窗口时固定 `endTs`：

```ts
const endTs = Date.now();
let page = 1;

for (;;) {
  const result = await client.account.fetchFundingFeeHistory({
    accountId,
    symbols,
    startTs,
    endTs,
    page,
    limit: 1000,
  });

  collect(result.fees);

  if (!result.nextPage) {
    break;
  }
  page = result.nextPage;
}
```

防御性去重：

- 优先：`accountId + venue + venueTransactionId`。
- 缺少 `venueTransactionId` 时：`accountId + venue + symbol + asset + fundingTime + amount + tradeId?`。

## Trade-offs

- 不暴露 internal strategy，避免下游依赖 `<=5` threshold。
- 不提供 per-symbol `pageInfo`，因为 account-scan 模式没有正确的 per-symbol truncated 语义。
- 普通 API 不自动扫完整窗口，避免单次调用隐藏大量请求；下游通过 `nextPage` 自行控制。
- `limit` 是底层 request page size，而不是返回数组的全局上限；这是支持 per-symbol 合并的代价，文档必须写清楚。
- 第一版只支持 Binance PAPI UM funding fee history，不扩展通用 income / ledger manager。
