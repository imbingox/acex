# Deribit 期权行情 MVP 技术设计

## 目标与边界

本设计实现 Deribit 公开期权行情 MVP：Deribit option catalog、option market / pair discovery、`quote.<instrument>` L1 Book 订阅，以及与现有 Binance 永续 L1 一起用于下游套利扫描的数据准备。

不实现 Deribit 账户、私有流、订单、仓位、风控、Greeks / IV / mark price 稳定 API、L2/depth、套利计算或交易执行。

## 公共类型与配置

### Venue / MarketType

- 在 `src/types/shared.ts` 的 `SUPPORTED_VENUES` 增加 `"deribit"`。
- `MarketType` 增加 `"option"`。
- 所有 `Record<MarketType, ...>`、穷尽分支和文档示例必须同步处理 `option`。

### Runtime venue 选择

新增顶层配置：

```ts
interface CreateClientOptions {
  venues?: Venue[];
}
```

语义：

- `venues` 省略：注册 SDK 当前所有 runtime-supported venues。本 MVP 完成后包含 Binance、Juplend、Deribit。
- `venues` 显式传入：只注册列出的 runtime adapters。
- 空数组或规范化后为空数组：配置错误。
- 包含 type-only venue（例如当前未实现 runtime 的 `okx` / `bybit` / `gate`）：配置错误。
- `market.venues.*` / `account.venues.*` 继续只表示各模块的 venue-specific 配置，不负责启用 venue。

Runtime 实现建议：

- 在 `src/client/runtime.ts` 定义 runtime factory registry，避免用硬编码数组分散判断。
- `createVenueAdapterGroups()` 根据 normalized selected venues 调用对应 factory。
- `listVenueCapabilities()` 仍遍历 `SUPPORTED_VENUES`，但 capability 是否 available 由当前 client 注册的 adapter registry 决定。

### Deribit market 配置

新增：

```ts
interface DeribitMarketRuntimeOptions {
  underlyings?: string[];
}

interface MarketRuntimeOptions {
  venues?: {
    binance?: BinanceMarketRuntimeOptions;
    deribit?: DeribitMarketRuntimeOptions;
  };
}
```

语义：

- `underlyings` 是 SDK 语义，表示 Deribit option underlying 列表，例如 `["BTC", "ETH"]`。
- adapter 内部把每个 underlying 映射到 Deribit `public/get_instruments` 的 `currency` 参数。
- Deribit 被当前 client 选择且 `underlyings` 省略时默认 `["BTC"]`。
- `underlyings` 必须 trim、uppercase、去重。
- 空数组或规范化后为空数组是配置错误。
- 任一 underlying 请求失败或 Deribit 不支持时，catalog load 失败，不静默跳过。

### MarketDefinition / OptionMarketDefinition

当前 `MarketDefinition` 是 interface，Binance 内部 `BinanceMarketDefinition extends MarketDefinition`。为了让 `type: "option"` 可被 TypeScript discriminated union 收窄，同时避免破坏交易所内部 subtype，公共类型改为：

```ts
interface BaseMarketDefinition {
  venue: Venue;
  symbol: string;
  id: string;
  type: MarketType;
  base: string;
  quote: string;
  settle?: string;
  active: boolean;
  contract: boolean;
  linear?: boolean;
  inverse?: boolean;
  contractSize?: string;
  pricePrecision: number;
  amountPrecision: number;
  priceStep: string;
  amountStep: string;
  minAmount?: string;
  minNotional?: string;
  expiry?: number;
  raw: Record<string, unknown>;
}

interface StandardMarketDefinition extends BaseMarketDefinition {
  type: "spot" | "swap" | "future";
}

interface OptionMarketDefinition extends BaseMarketDefinition {
  type: "option";
  underlying: string;
  expiry: number;
  strike: string;
  strikeCurrency: string;
  optionType: "call" | "put";
  premiumCurrency: string;
  settle: string;
  contract: true;
  contractSize: string;
}

type MarketDefinition = StandardMarketDefinition | OptionMarketDefinition;
```

Implementation notes:

- `BinanceMarketDefinition` should extend `StandardMarketDefinition` or `BaseMarketDefinition`, not the `MarketDefinition` union.
- Existing market helpers that do not care about option-specific fields continue accepting `MarketDefinition`.
- `MarketAdapter.loadMarkets()` continues returning `Promise<MarketDefinition[]>`.
- `OptionMarketDefinition` stays public and is exported through existing type barrel.

## Option discovery API

Add to `src/types/market.ts`:

```ts
interface ListOptionMarketsFilter {
  venue?: Venue;
  underlying?: string;
  optionType?: "call" | "put";
  expiry?: number;
  strike?: DecimalInput;
  strikeCurrency?: string;
  premiumCurrency?: string;
  settle?: string;
  active?: boolean;
}

interface OptionPair {
  venue: Venue;
  underlying: string;
  strikeCurrency: string;
  premiumCurrency: string;
  settle: string;
  expiry: number;
  strike: string;
  call: OptionMarketDefinition;
  put: OptionMarketDefinition;
}

type ListOptionPairsFilter = Omit<ListOptionMarketsFilter, "optionType">;
```

Add to `MarketManager`:

```ts
listOptionMarkets(filter?: ListOptionMarketsFilter): OptionMarketDefinition[];
listOptionPairs(filter?: ListOptionPairsFilter): OptionPair[];
```

Manager behavior:

- Pure catalog reads, same as `listMarkets()`: do not load catalog and do not touch network.
- If Deribit is not selected or catalog is not loaded, return the current catalog result, normally empty.
- Normalize string filters with `trim().toUpperCase()`.
- Normalize `strike` with `toCanonical(new BigNumber(input))` and exact-match the canonical string.
- `active` omitted means no active filtering.
- `listOptionPairs()` first filters single-leg option markets, then groups by `venue + underlying + strikeCurrency + premiumCurrency + settle + expiry + strike`; only complete call + put pairs are returned.
- Sorting:
  - markets: `venue`, `underlying`, `strikeCurrency`, `premiumCurrency`, `settle`, `expiry`, numeric `strike`, `optionType` with call before put.
  - pairs: same fields except `optionType`.

## Deribit market adapter

Add `src/adapters/deribit/`:

```text
src/adapters/deribit/adapter.ts
src/adapters/deribit/market-catalog.ts
src/adapters/deribit/stream-protocol.ts
```

### Capabilities

`DeribitMarketAdapter.marketCapabilities`:

- `catalog: "supported"`
- `serverTime: "unsupported"`
- `l1Book: "supported"`
- `marketTypes: ["option"]`
- `fundingRate: "unsupported"`
- `fundingRateHistory: "unsupported"`
- `publicTrades: "unsupported"`
- `publicRawTrades: "unsupported"`

`MarketAdapter` should gain optional read-only metadata:

```ts
interface MarketAdapter {
  readonly venue: Venue;
  readonly readOnly?: boolean;
  readonly notes?: string[];
  readonly marketCapabilities: VenueMarketCapabilities;
  ...
}
```

Deribit sets `readOnly = true`. Capability aggregation uses this when no private adapter exists:

- if a private adapter exists, keep current private adapter truth source.
- if no private adapter exists and `marketAdapter.readOnly === true`, return `readOnly: true` and `order.reason: "read_only"`.
- account remains fully unsupported with `credentialsRequired: false`.

### Catalog loading

For each normalized underlying:

- Request Deribit `public/get_instruments` with `kind=option` and the underlying mapped to Deribit `currency`.
- Use shared transport patterns and keep default tests fixture/fake-transport based; no default test should call real Deribit.
- Normalize each instrument to `OptionMarketDefinition`.

Field mapping:

- `id = instrument_name`
- `base = underlying = base_currency`
- `quote = strikeCurrency = counter_currency`
- `premiumCurrency = quote_currency`
- `settle = settlement_currency`
- `expiry = expiration_timestamp`
- `strike = canonical decimal string`
- `optionType = option_type === "call" ? "call" : "put"`
- `contract = true`
- `contractSize = contract_size`
- `inverse/linear` from `instrument_type`; known `reversed` option maps `inverse: true`
- `active = is_active === true && (state === undefined || state === "open")`
- `priceStep = tick_size`
- `amountStep = min_trade_amount`
- `minAmount = min_trade_amount`
- `pricePrecision / amountPrecision` derived from steps
- raw payload preserved in `raw`; `tick_size_steps` remains only in raw

Symbol format:

```text
<underlying>/<strikeCurrency>:<settle>-<YYYYMMDD>-<strike>-<C|P>
```

Example:

```text
BTC/USD:BTC-20260621-57000-C
```

The catalog should keep a map from SDK symbol to Deribit `instrument_name` for stream subscription.

## L1 stream and no_quote design

Deribit L1 uses public WS channel:

```text
quote.<instrument_name>
```

The Deribit stream protocol should parse JSON-RPC subscription messages and route by channel/instrument.

Complete quote validation:

- `best_bid_price`
- `best_bid_amount`
- `best_ask_price`
- `best_ask_amount`

All four fields must be present, finite, and positive. Only then emit a normal L1 payload.

### Status-only no_quote path

`no_quote` must not be delivered as normal `data` through `SubscriptionMultiplexer`, because normal data clears the initial ready timer and resolves subscription ready.

Extend `SubscriptionMultiplexer` and `VenueStreamProtocol.routeMessage()` with a status-only route, for example:

```ts
type RoutedMessage<TPayload, TStatusPayload> =
  | { kind: "data"; subscriptionKey: string; payload: TPayload }
  | { kind: "status"; subscriptionKey: string; payload: TStatusPayload }
  | { kind: "ack" }
  | { kind: "ignore" };

interface MultiplexedStreamCallbacks<TPayload, TStatusPayload = never> {
  onPayload(payload: TPayload, receivedAt: number): void;
  onStatus?(payload: TStatusPayload, receivedAt: number): void;
  ...
}
```

Status route semantics:

- Does not clear the initial data timer.
- Does not resolve ready.
- Does not mark the subscriber fresh.
- Only delivers `onStatus`.
- Existing Binance behavior remains unchanged because Binance routes only `data` / `ack` / `ignore`.

Add adapter-level callback support:

```ts
interface RawL1NoQuoteUpdate {
  receivedAt: number;
  exchangeTs?: number;
  raw?: Record<string, unknown>;
}

interface L1BookStreamCallbacks {
  onUpdate(update: RawL1BookUpdate): void;
  onNoQuote?(update: RawL1NoQuoteUpdate): void;
  ...
}
```

Manager handling:

- `MarketDataStatus["reason"]` includes `"no_quote"`.
- `L1BookStreamCallbacks.onNoQuote` updates L1 stream freshness to stale/no_quote.
- If no complete L1 has ever been published, do not resolve leases and do not publish `l1_book.updated`.
- If a complete L1 exists:
  - Keep top-level `bidPrice`, `bidSize`, `askPrice`, `askSize`, `receivedAt`, `updatedAt`, `exchangeTs`, and `version` unchanged.
  - Update `book.status.freshness = "stale"`.
  - Update `book.status.reason = "no_quote"`.
  - Update `book.status.lastReceivedAt` to the no-quote local receive time.
  - Update aggregate `market.status_changed.status.lastReceivedAt` to the same time.
  - Publish `market.status_changed`; do not publish `l1_book.updated`.
- Next complete quote publishes a new `L1Book`, increments version, and restores `fresh`.

Implementation detail:

- Add per-channel last input timestamps to `MarketRecord`, e.g. `l1LastReceivedAt` and `fundingRateLastReceivedAt`.
- On L1 update, set `l1LastReceivedAt = update.receivedAt`.
- On no_quote, set `l1LastReceivedAt = update.receivedAt` even though the snapshot top-level timestamps stay unchanged.
- `resolveLastReceivedAt()` should use the per-channel last input timestamps rather than only snapshot `receivedAt`.

## Runtime registry and docs

Runtime changes:

- Add Deribit adapter factory in `src/client/runtime.ts`.
- Normalize top-level `venues`.
- Default selected venues are all runtime-supported factories.
- Ensure `listVenueCapabilities()` still returns all public `SUPPORTED_VENUES`, with unselected runtime venues falling back to `type_only`.

Docs:

- Update `docs/api.md` / README public examples with:
  - `createClient({ venues: ["binance"] })` for Binance-only.
  - Deribit default underlyings and `market.venues.deribit.underlyings`.
  - option discovery and option pair example.
  - L1 price unit caveat: Deribit option L1 price is in `premiumCurrency`, not Binance USDT.
  - Greeks / IV / mark price out of stable MVP API.

Specs:

- Update `.trellis/spec/backend/adapter-contract.md` for:
  - `OptionMarketDefinition` as standard public market contract.
  - status-only multiplexer route / no_quote callback semantics.
  - market-only read-only capability aggregation.
- Update `.trellis/spec/backend/venue-capabilities.md` for market-only read-only venues.

## Test strategy

Unit tests:

- Deribit catalog normalization:
  - symbol format.
  - strike canonicalization including scientific notation.
  - base/quote/underlying/strikeCurrency/premiumCurrency/settle mapping.
  - active from `is_active` + optional `state`.
  - amount/price step precision.
  - raw `tick_size_steps` preserved.
- Option discovery:
  - filters and canonical strike matching.
  - stable sorting.
  - pair grouping and incomplete pair exclusion.
  - no implicit active filtering.
- Deribit config:
  - top-level `venues` omitted / `["binance"]` / empty / type-only.
  - Deribit `underlyings` omitted / trim uppercase dedupe / empty / invalid request failure.
- Deribit stream protocol:
  - complete quote produces L1.
  - null/missing/non-finite/non-positive fields produce no_quote status only.
  - no_quote before first valid data does not resolve ready.
  - no_quote after valid data updates statuses without publishing `l1_book.updated`.

Integration tests:

- Default client capabilities include Deribit available after MVP.
- `createClient({ venues: ["binance"] })` leaves Deribit type-only and `loadMarkets()` does not call Deribit.
- Deribit selected capability reports read-only market-only runtime with account/order unsupported.

Validation commands:

```bash
bun run lint
bun run type-check
bun run test
```

Live Deribit smoke, if added, must be an explicit script and must not be included in default `bun run test`.
