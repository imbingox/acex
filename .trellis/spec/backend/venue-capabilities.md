# Venue Capabilities

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
- `market.fundingRate = "market_dependent"` 表示 venue 级无法保证所有 market 都支持；具体 symbol 仍以 `subscribeFundingRate()` 的实际结果为准。
- `market.publicTrades = "supported"` 表示当前 SDK runtime 实现了 public market trades 查询链路。Binance 当前返回 `aggTrades` 聚合成交，不是逐笔 raw trade。
- `market.publicRawTrades = "supported"` 表示当前 SDK runtime 实现了逐笔 raw public trade 查询链路。Binance 该方法需要 market-data API key；capability 不检查 key 是否已配置或权限是否有效。
- `market.fundingRateHistory = "supported"` 表示当前 SDK runtime 可通过 `client.market.fetchFundingRateHistory()` 查询历史 funding rate；具体 symbol 仍需是永续合约，spot / dated future 会由 manager 抛 `MARKET_FUNDING_RATE_UNSUPPORTED`。
- `market.serverTime = "supported"` 表示当前 SDK runtime 可通过 `client.market.fetchServerTime(venue)` 获取交易所服务器时间、单次 RTT 与 NTP 式时钟偏移估算。Binance 当前测量源固定为 USDⓈ-M REST 集群 `/fapi/v1/time`。
- `order.supported = true` 才表示可以通过当前 SDK 调 `createOrder()` / `cancelOrder()` / `cancelAllOrders()`。
- `order.supported = true` 是 venue 级能力，不是 market/symbol 级能力。例如 Binance 当前订单命令固定走 PAPI UM，不能据此推断 Binance spot、COIN-M 或交割合约都可通过 `OrderManager` 下单。
- `order.reason` 只在 `order.supported = false` 时使用，常见值：
  - `read_only`: venue 只读，例如 Juplend
  - `not_implemented`: venue 仅类型占位或 runtime 未接入
- capability 真源应尽量靠近 adapter：
  - `MarketAdapter.marketCapabilities` 声明该 market adapter 已实现的 catalog / server time / public trades / public raw trades / funding history / L1 / funding rate 能力。
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
