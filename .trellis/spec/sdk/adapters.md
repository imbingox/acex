# Adapter Contract

## Scenario: 新增交易所或修改 adapter 接口时，必须实现稳定的 `MarketAdapter` / `PrivateUserDataAdapter` 契约

### 1. Scope / Trigger

- Trigger: 新增 `src/adapters/<venue>/`、修改 `src/adapters/types.ts` 的接口、为已有 adapter 接入新数据类型（trades / kline / ...）、或扩展 `PrivateUserDataAdapter` 命令集时。
- 目标: 让每一家 adapter 在 `StreamHandle` 语义、回调顺序、错误传播、ManagedWebSocket 复用、标准化类型边界上表现一致，避免上层 manager 针对单个交易所写特判。

### 2. Signatures

接口契约定义在 `src/adapters/types.ts`，当前签名（引用源码，不重复展开）：

```ts
// 通用流句柄
export interface StreamHandle {
  readonly ready: Promise<void>;
  close(): void;
}

// 行情 adapter
export interface MarketAdapter {
  readonly venue: Venue;
  readonly readOnly?: boolean;
  readonly notes?: string[];
  readonly marketCapabilities: VenueMarketCapabilities;
  loadMarkets(): Promise<MarketDefinition[]>;
  fetchServerTime?(): Promise<VenueServerTime>;
  fetchPublicTrades?(
    market: MarketDefinition,
    request: FetchPublicTradesRequest,
  ): Promise<RawPublicTradesResult>;
  fetchPublicRawTrades?(
    market: MarketDefinition,
    request: FetchPublicRawTradesRequest,
  ): Promise<RawPublicTradesResult>;
  assertPublicRawTradesConfigured?(): void;
  fetchFundingRateHistory?(
    market: MarketDefinition,
    request: FetchFundingRateHistoryRequest,
  ): Promise<RawFundingRateHistoryResult>;
  createL1BookStream(
    market: MarketDefinition,
    callbacks: L1BookStreamCallbacks,
    options: L1BookStreamOptions,
  ): StreamHandle;
  createFundingRateStream(
    market: MarketDefinition,
    callbacks: FundingRateStreamCallbacks,
    options: FundingRateStreamOptions,
  ): StreamHandle;
}

// 私有链路 adapter
export interface PrivateUserDataAdapter {
  readonly venue: Venue;
  readonly readOnly: boolean;
  readonly notes: string[];
  readonly accountCapabilities: VenueAccountCapabilities;
  readonly orderCapabilities: VenueOrderCapabilities;
  normalizeVenueErrorCode?(code: string): VenueErrorReason;
  bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap>;
  refreshAccount?(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountUpdate>;
  reconcileAccount?(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap>;
  bootstrapOpenOrders(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]>;
  fetchOpenOrders?(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOpenOrdersSnapshot>;
  fetchOrder?(
    credentials: AccountCredentials,
    request: FetchOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate | undefined>;
  fetchSymbolFeeRate?(
    credentials: AccountCredentials,
    request: FetchSymbolFeeRateRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolFeeRate>;
  fetchSymbolRiskLimit?(
    credentials: AccountCredentials,
    request: FetchSymbolRiskLimitRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolRiskLimit>;
  fetchRiskLimits?(
    credentials: AccountCredentials,
    request: FetchRiskLimitsRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolRiskLimit[]>;
  setSymbolLeverage?(
    credentials: AccountCredentials,
    request: SetSymbolLeverageRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawSymbolLeverageUpdate>;
  createOrder(
    credentials: AccountCredentials,
    request: CreateOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate>;
  cancelOrder(
    credentials: AccountCredentials,
    request: CancelOrderRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate>;
  cancelAllOrders(
    credentials: AccountCredentials,
    request: CancelAllOrdersRequest,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]>;
  createPrivateStream(
    credentials: AccountCredentials,
    callbacks: PrivateStreamCallbacks,
    options: PrivateStreamOptions,
    accountOptions?: Record<string, unknown>,
  ): StreamHandle;
}
```

回调与标准化类型的完整定义位于同一文件：`RawL1BookUpdate`、`RawAccountBootstrap`、`RawAccountUpdate`、`RawOpenOrdersSnapshot`、`RawRiskLevelChange`、`RawOrderUpdate`、`RawSymbolFeeRate`、`RawSymbolRiskLimit`、`RawSymbolLeverageUpdate`、`L1BookStreamCallbacks`、`PrivateStreamCallbacks`、`L1BookStreamOptions`、`PrivateStreamOptions`。

当前参考实现：

```text
src/adapters/binance/adapter.ts            — BinanceMarketAdapter（行情经 SubscriptionMultiplexer 复用物理连接）
src/adapters/binance/error-codes.ts        — Binance venue error code 归一
src/adapters/binance/funding-history.ts    — Binance funding history REST parser
src/adapters/binance/market-catalog.ts     — loadBinanceMarkets
src/adapters/binance/private-adapter.ts    — BinancePrivateAdapter（PAPI UM listenKey + WS）
src/adapters/binance/public-market-http.ts — Binance public market REST helper
src/adapters/binance/public-trades.ts      — Binance public trade REST queries
src/adapters/binance/rate-limit*.ts        — Binance rate-limit topology / plan
src/adapters/binance/server-time.ts        — Binance server time sampler
src/adapters/binance/stream-protocol.ts    — BinanceStreamProtocol（L1/funding 的 VenueStreamProtocol 策略）
src/adapters/deribit/adapter.ts            — DeribitMarketAdapter（option catalog + quote stream）
src/adapters/deribit/market-catalog.ts     — Deribit instrument catalog
src/adapters/deribit/stream-protocol.ts    — Deribit quote stream protocol
src/adapters/juplend/lend-read.ts          — @jup-ag/lend-read 边界封装
src/adapters/juplend/private-adapter.ts    — JuplendPrivateAdapter（HTTP polling 只读借贷账户）
src/internal/subscription-multiplexer.ts   — SubscriptionMultiplexer（通用订阅多路复用原语，venue-agnostic）
```

capability 字段只声明该 adapter 的 SDK runtime 实现能力，完整聚合语义见 [Public API Contract](./public-api.md) 和 [Client Runtime](./client-runtime.md)。

### 3. Contracts

#### 3.0 capability 驱动的 private 分派

private 编排层不得用 venue 字面量决定账户 / 订单链路行为；新 adapter 通过声明正确的 capability 即可接入既有分派：

- 下单命令是否拒绝由 `orderCapabilities.supported` 决定。
- 订单订阅是否拒绝由 `orderCapabilities.updates` 决定。
- private credentials 是否必需由 `accountCapabilities.credentialsRequired` 决定。
- account stream 的启动顺序由 `accountCapabilities.updates` 决定：`"polling"` 先 bootstrap 再启动 stream，`"websocket"` 先启动 stream 再 bootstrap。
- REST account refresh polling 不看 venue，也不看 `accountCapabilities.updates`；只按 adapter 是否实现可选的 `refreshAccount()` 判别。refresh 成功仍必须用 `{ preserveStatus: true }` 更新 manager，避免覆盖当前 WS reconnect/degraded 状态。
- Private REST reconcile 是否需要启用，必须由 venue 的 private 数据语义决定：
  - 如果私有 WS 只提供增量事件，且消息可能丢失 / 乱序 / 不触发 reconnect，则必须提供 REST reconcile 能力，把 account / balances / positions / orders 等本地状态收敛到交易所真实状态。
  - 如果私有 WS 会定期推送权威全量 private snapshot，并能清理 stale balances / positions / orders，则不要求额外启用 REST 定时对账。
  - coordinator 不得硬编码“所有 private venue 都轮询 REST”；应通过 adapter capability / 可选 reconcile 方法是否存在来分派。

#### 3.0.1 新 venue 接入顺序

新增中心化交易所或其它 venue 时，按 capability → adapter → registry → tests → public docs 的顺序推进：

1. 先定义首版能力边界：market catalog、server time、L1 Book、funding rate、account snapshot / updates、open orders / updates、create / cancel / cancelAll、credentials 形状、symbol encode/decode 规则。
2. 判断 private 数据一致性模型：该 venue 的私有 WS 是增量流还是会定期推权威全量快照。增量流必须规划 REST reconcile；权威全量快照流可以不加 REST reconcile，但必须证明 stale balances / positions / orders 会被快照清理。
3. 如果只是类型占位，不要加入 runtime adapter registry；保持 `runtimeStatus = "type_only"`，避免 public capability 误报可用。
4. 交易所 payload、签名、URL、rate-limit header、symbol encode/decode 必须放在 `src/adapters/<venue>/`；manager/runtime 不写交易所特判。
5. `MarketAdapter` 首版至少保证 `loadMarkets()` 返回标准 `MarketDefinition[]`，market 数值字段是 canonical decimal string，交易所原始字段只放 `raw`。实现行情流时走 `SubscriptionMultiplexer` + `VenueStreamProtocol`。
6. `PrivateUserDataAdapter` 必须先声明 `readOnly`、`notes`、`accountCapabilities`、`orderCapabilities`。如果该 venue 需要 passphrase 或更复杂凭证，应补 per-adapter credential validator，不要把通用 credential helper 扩成交易所特判表。
7. 在 `src/client/runtime.ts` 注册 adapter 后，manager / coordinator 应通过 registry 和 capability 自然分派；如果需要改 manager 才能识别某个 venue，通常说明 adapter contract 或 capability 声明不完整。
8. 新增 public 能力时更新 `docs/capabilities.md`、`docs/managers.md` 或相关用户文档；adapter 接入流程、Layer 规则、基础设施 contract 只写在 `.trellis/spec/sdk/`，不要在 `docs/` 下新增 architecture / roadmap / venue-integration 文档。

#### 3.1 `StreamHandle` 语义

- **`ready` resolve 时机**：
  - 行情 `createL1BookStream()` / `createFundingRateStream()`：该 **logical 订阅**被底层 stream / venue 接受，通常是 subscribe ACK 到达；如果首条可路由 data 在 ACK 前到达且能确定属于该 pending subscription，也视为等价订阅接受信号。行情流经 `SubscriptionMultiplexer` 复用物理连接，ready 是 **per-subscription** 的（物理连接本身用 `readyWhen: "open"`，不再把整条连接的 open 当作某个订阅的 ready）。详见 §3.10。
  - 私有 `createPrivateStream()`：WebSocket `open` 事件后 + 鉴权 / listenKey 就绪（Binance PAPI UM 走 `readyWhen: "open"`，因为 listenKey 握手在 open 前已完成）
- `createManagedWebSocket({ readyWhen: "open" })` 的 `initialMessageTimeoutMs` 只约束 open 是否及时发生；open 后没有业务消息不得再触发 initial timeout。open 后静默由 message watchdog / venue keepalive 处理。
- **`ready` reject 时机**：初始连接超时、subscribe ACK 超时 / 拒绝、WS close 在 ready 前发生。reject 后 adapter 内部必须自行调用 close（参考 `src/internal/managed-websocket.ts:172-175`）。
- **`close()` 必须幂等**：多次调用不抛错、不重复关 socket、不重复清 timer。
- **`close()` 之后不得再触发任何回调**。

#### 3.2 `loadMarkets()` 约束

- 返回顺序必须稳定（当前 `loadBinanceMarkets` 按 `symbol.localeCompare` 排序）。
- 交易所特定字段必须通过 `raw: Record<string, unknown>` 透传，**不能在顶层新增非 `MarketDefinition` 字段**。
- 不允许把 `<Venue>MarketDefinition`（比如 `BinanceMarketDefinition.family`）暴露到 `Promise<MarketDefinition[]>` 返回值里——adapter 内部可以持有子类型用于后续路由（参考 `BinanceMarketAdapter.definitions`），但对外签名仍是 `MarketDefinition[]`。
- `MarketDefinition` 是 public discriminated union；`type:"option"` 必须返回标准 `OptionMarketDefinition`，不能只在 Deribit adapter 内部定义私有 subtype。Deribit option 的 `id` 保留原生 `instrument_name`，`symbol` 使用 SDK 稳定格式 `<underlying>/<strikeCurrency>:<settle>-<YYYYMMDD>-<strike>-<C|P>`，`base/quote/underlying/strikeCurrency/premiumCurrency/settle` 按 public contract 映射，`raw` 保留完整交易所 payload。
- 价格 / 数量精度字段：`priceStep`、`amountStep`、`contractSize`、`minAmount`、`minNotional` 必须是 canonical decimal string（无科学计数法、不补尾零）；`pricePrecision`、`amountPrecision` 必须由 step 反推得到（参考 `market-catalog.ts` 的 `precisionFromStep`）。adapter 内部可用 BigNumber 计算，但 public `MarketDefinition` 只能暴露 string。
- 不活跃市场 `active: false` 仍然要返回，不要在 adapter 里提前过滤。
- Binance derivatives 归类时 `contractType` 对永续判断优先于 `deliveryDate`：`PERPETUAL` 与 `TRADIFI_PERPETUAL` 都必须映射为 `MarketDefinition.type = "swap"`。Binance TradFi Perps 可能返回远期 `deliveryDate`，不得因此追加 expiry suffix 或误判为 `future`。

#### 3.2.1 `fetchServerTime()` 约束

- `fetchServerTime()` 是可选 market adapter 方法；venue 不支持时不要实现该方法，并在 `marketCapabilities.serverTime` 声明 `"unsupported"`。
- 返回值必须是标准 `VenueServerTime`：`serverTime` 为交易所服务器 epoch ms；`requestSentAt` / `responseReceivedAt` 为 SDK 本地墙钟 epoch ms；`roundTripMs` 为单调时钟差值；`estimatedOffsetMs = serverTime - (requestSentAt + responseReceivedAt) / 2`。
- `roundTripMs` 必须用单调时钟（`performance.now()` 或测试注入的等价 seam）计算，不要求等于 `responseReceivedAt - requestSentAt`。`requestSentAt` / `responseReceivedAt` 和 `estimatedOffsetMs` 继续使用墙钟。
- 时间戳采集点：必须在 `rateLimiter.beforeRequest()` resolve 之后、`httpRequest()` 之前采集 `requestSentAt` 与单调起点；必须在 `httpRequest()` resolve 之后采集 `responseReceivedAt` 与单调终点，避免限流等待混入 RTT。
- REST 调用必须复用共享 `httpRequest()`；用于延迟测量的 server-time 请求不得自动重试，`retryPolicy.maxAttempts` 必须为 `1`。
- adapter 失败时只抛 `TransportError`（HTTP / network / timeout / parse）或普通 `Error`（响应缺失或字段类型校验失败），不得构造 `AcexError`。manager 负责映射为 public 错误码。
- `estimatedOffsetMs` 基于 NTP 式上下行延迟对称假设；该值是估算，不保证等于真实时钟偏移。
- Binance 当前实现固定测量 USDⓈ-M REST 集群 `/fapi/v1/time`，不是 spot 或 COIN-M 集群时间源；未来需要精确区分集群时再扩展 public 参数。

#### 3.2.2 public market REST query 约束

- `fetchPublicTrades()` / `fetchPublicRawTrades()` / `fetchFundingRateHistory()` 是可选 market adapter 方法；venue 不支持时不要实现该方法，并分别在 `marketCapabilities.publicTrades` / `marketCapabilities.publicRawTrades` / `marketCapabilities.fundingRateHistory` 声明 `"unsupported"`。
- Adapter 输入必须接收标准 `MarketDefinition` 和标准 request 类型，内部自行映射为 venue symbol；返回值只能是标准 `RawPublicTrade` / `RawFundingRateHistoryEntry`，不得把 `BinanceMarketDefinition.family` 等 venue-private 字段泄漏到 manager。
- Adapter 只负责 REST 请求、交易所响应结构校验、`receivedAt` 采样和 `raw` clone；public decimal canonical 化在 `MarketManager` 出口用 `toCanonical()` 完成。
- Binance `fetchPublicTrades()` 当前使用 `aggTrades`，返回 aggregate trade，不承诺逐笔 raw trade。`RawPublicTrade.id` 是 aggregate trade id，`raw` 保留 venue 原始 `a/f/l/T/m` 等字段；`endTs` 仍由 manager public contract 定义为 exclusive，adapter 本地过滤。
- Binance `fetchPublicRawTrades()` 使用 `historicalTrades`，必须带 market-data API key（`CreateClientOptions.market.venues.binance.apiKey`，未显式传入时读 `BINANCE_MARKET_API_KEY`）。需要 key 的 adapter 必须实现 `assertPublicRawTradesConfigured()`，让 manager 在加载 market catalog 前先做本地配置预检；缺 key 时不得发任何远端请求。Adapter 必须先用 `aggTrades` 按 `startTs` 定位起始 raw trade id，再带 `X-MBX-APIKEY` 拉 `historicalTrades`，按 raw trade `time` 做 `[startTs, endTs)` 本地过滤；locator 请求不得把调用方的完整 `endTs` 窗口传给 `aggTrades`，避免触发 Binance 对 aggregate-trade start/end time lookup 的窗口限制。若 locator 返回的首条 aggregate trade 时间已经 `>= endTs`，应返回空结果且不得继续请求 `historicalTrades`。可查询范围同时受 Binance `aggTrades` locator 与 `historicalTrades` / `MARKET_DATA` 端点自身的数据可用性限制。
- 历史 funding 查询只支持永续合约。Manager 必须先用 `MarketDefinition.type === "swap"` 与 `contract === true` 拒绝 spot / dated future，并抛 `MARKET_FUNDING_RATE_UNSUPPORTED`；adapter 可保留防御性检查，但不作为 public 分支语义来源。
- `RawFundingRateHistoryEntry.fundingTime` 必须直接来自交易所历史 funding record 的 `fundingTime`，表示历史结算/生效时间；不得用 SDK 本地 `receivedAt` 或 server time 代替。`receivedAt` 是 REST 响应到达本地后的采样时间，两者必须分离。
- `RawFundingRateHistoryEntry.markPrice` 是 optional；USDⓈ-M 当前返回该字段，COIN-M 可能不返回。缺字段时不得报错。
- Binance public market REST 请求必须复用共享 `httpRequest()` 和 public market HTTP helper，`retryPolicy.maxAttempts = 1`，并把 endpoint-specific `messages` 注入 helper，避免不同 public market query 的错误文案互相污染。
- Binance funding history endpoint：
  - USDⓈ-M: `GET /fapi/v1/fundingRate`，rate-limit plan 使用 500/5min/IP 专用 bucket。
  - COIN-M: `GET /dapi/v1/fundingRate`，request weight 为 1。
  - 请求参数为 `symbol`、`startTime`、`endTime`、`limit`；`startTime` / `endTime` 按交易所文档都是 inclusive。
  - `limit` 最大 1000；manager 必须在调用 adapter 前校验。
- Binance raw historical trades endpoint:
  - Spot: `GET /api/v3/historicalTrades`，request weight 为 25。
  - USDⓈ-M: `GET /fapi/v1/historicalTrades`，request weight 为 20。
  - COIN-M: `GET /dapi/v1/historicalTrades`，request weight 为 20。
  - 只需要 API key header，不需要 secret/signature。缺 key 是本地配置错误；无效 key 或权限不足由 manager 包装为 `MARKET_PUBLIC_TRADES_FETCH_FAILED`。

#### 3.3 `createL1BookStream()` 回调约束

- `onUpdate(update)`：每条标准化后的 L1 推送一次，`RawL1BookUpdate` 字段为 `string | null`（`bidPrice` / `bidSize` / `askPrice` / `askSize`）。price/size 在同一侧必须成对为 string 或 null；side validity 为 price 有限且大于 0、size 有限且大于 0，任一字段无效则该侧成对置 null。manager 出口只对非 null 数值调用 `toCanonical()`；不要把第三方数值对象泄漏进 Raw 或 public contract。
- L1 的 two-sided、bid-only、ask-only 和 empty 都必须走 `onUpdate`。不得用 status-only callback 表达正常盘口形态，也不得新增 public `quoteState` / `L1BookQuoteState` 这类第二事实源。
- `onFreshnessChange("fresh" | "stale", reason?)`：`fresh` ↔ `stale` 必须成对，不允许连续两次 `stale`。`reason` 仅支持 `"heartbeat_timeout"`（其他原因由上层根据 `onDisconnected` 推断为 `"ws_disconnected"`）。
- 行情多路复用下，健康物理连接中单个订阅没有新消息不再标记 stale；bookTicker 无推送表示盘口未变，缓存仍有效。`stale` 仅由连接级 `messageWatchdog` / 重连补标驱动，`reason` 仍仅为 `"heartbeat_timeout"`；`fresh` ↔ `stale` 成对契约不变。
- `onDisconnected()`：每次底层连接关闭触发一次。包括主动 close（手动 unsubscribe）和被动 close（服务器断、网络断），manager 统一视为 `activity` 变化来源。
- `onError(error)`：仅用于不可恢复错误（消息解析失败、签名失败等）。**不要把 close 事件当成 error**。

#### 3.4 `createPrivateStream()` 回调约束

- `onAccountUpdate(update)` / `onRiskLevelChange(event)` / `onOrderUpdate(update)`：消息类型路由由 adapter 负责（Binance 通过事件字段 `e` 分派）；同一条物理消息不得同时触发多个回调。
- Binance PAPI 私有流连接的是 `wss://fstream.binance.com/pm/ws`。账户风控告警必须按 PAPI `riskLevelChange` 处理，不要实现 USDⓈ-M / COIN-M 独立合约流的 `MARGIN_CALL` per-position 形状。`riskLevelChange` 是账户级聚合事件，无 `symbol`、无逐仓位数组，因此不得进入 symbol mapping / quarantine。
- `riskLevelChange` → `RawRiskLevelChange` 映射：`s` 映射为 `riskLevel`（`MARGIN_CALL` → `margin_call`、`REDUCE_ONLY` → `reduce_only`、`FORCE_LIQUIDATION` → `force_liquidation`；未知风险字符串保守归 `margin_call`），`u` → `riskRatio`，`eq` → `netEquity`，`ae` → `riskEquity`，`m` → `maintenanceMargin`，`E` → `exchangeTs`，`receivedAt` 使用 SDK 本地接收时间。所有 decimal 字段必须先归一为 canonical decimal string。
- Binance `riskLeverage` 的 WS 即时回填归 AccountManager 负责，不放在 adapter：`ACCOUNT_UPDATE` 没有 `notional` / `markPrice`，adapter 只映射标准 position 增量；manager 在应用 size update 后，只有当前 `PositionSnapshot.markPrice` 和 `RiskSnapshot.riskEquity` 都可用时，才按 `sum(abs(size * markPrice)) / riskEquity` 派生 `riskLeverage`，全平时写 `"0"`，缺 mark price 时保留旧值等待 REST refresh 校准。`riskLevelChange.ae` 更新 `riskEquity` 时同理可基于当前 positions 派生 `riskLeverage`，并透出到 `account.risk_level_change.riskLeverage`。
- `ACCOUNT_CONFIG_UPDATE` 表示 PAPI futures 账户配置变更；当前只处理 leverage 更新。`ac.s` 必须走 Binance UM symbol mapping，miss 时复用 private WS quarantine + catalog refresh + replay；`ac.l` 映射为 `RawPositionUpdate.leverage`。该事件没有 position side，adapter 应对 `net` / `long` / `short` 都发出 size-less position update，AccountManager 只更新已有 position 并保留旧 size，其它字段按缺省保留。
- `onFreshnessChange("stale", "heartbeat_timeout")`：私有流连接级 message watchdog 触发时调用；上层 coordinator 将 account/order 状态置为 `runtimeStatus: "reconnecting"` 且 `reason: "heartbeat_timeout"`。不要把 watchdog stale 包装成 `http_failed`。
- `onDisconnected()` / `onReconnected()`：必须成对。`onReconnected` 只表示底层 WS 已重连成功，不代表上层已完成 reconcile——reconcile 由 `PrivateSubscriptionCoordinator` 触发。
- `onError(error)`：鉴权失败、listenKey 请求失败、消息解析失败等不可恢复错误。
- **listenKey keepalive 由 adapter 自己负责**：必须在 stream 内部维护定时 ping/keepalive（Binance PAPI UM 默认 30 分钟），不能让上层代理。`PrivateStreamOptions.listenKeyKeepAliveMs` 是调优参数，不是 on/off 开关。
- **listenKey 失效必须主动轮换 session**：Binance 私有流收到 `listenKeyExpired`、listenKey keepalive（PUT）重试耗尽、或连接级 `messageWatchdog` stale 时，adapter 必须关闭当前 WS、尽力 DELETE 旧 listenKey、重新 POST 新 listenKey，并用新 URL 建立 ManagedWebSocket。新 WS open 后通过 `onReconnected()` 触发上层 reconcile；普通网络断线仍交给 ManagedWebSocket 用同一 URL 自动重连。
- **私有流 watchdog 阈值由 runtime 传入**：`PrivateStreamOptions.staleAfterMs` 必须传给 `createManagedWebSocket().messageWatchdog.staleAfterMs`；Binance 默认值由 `CreateClientOptions.account.venues.binance.privateStreamStaleAfterMs` 调优，默认 65 分钟。Binance private user data stream 是事件驱动的，账户/订单无变化时可以长时间没有业务消息；该 watchdog 只能作为长周期兜底恢复机制，不能按行情 freshness 的 5s/15s 口径配置。测试可以把该值降到毫秒级，但生产默认必须保持长周期，避免正常低频账户事件被过度重建。
- **终态 order update 应带 `orderId`**：`RawOrderUpdate.orderId` / `.clientOrderId` 类型上都可选，但 manager 用 `(symbol, orderId)` 作为终态订单（filled / canceled / rejected / expired）的稳定主键（`clientOrderId` 仅 open 内唯一、终态后可复用，不能作终态主键，详见 [Binance Venue Spec](./venues/binance.md) 的订单身份约定）。adapter 在订单进入终态时**应当**带上交易所 `orderId`；Binance 的 REST 响应、`/papi/v1/um/openOrders`、`/papi/v1/margin/openOrders`、UM `ORDER_TRADE_UPDATE` 与 margin `executionReport` 均满足。只带 `clientOrderId` 的终态单会被 manager 以 provisional key 暂存，`orderId` 与 `clientOrderId` 都缺失时会被丢弃并告警。
- **成交明细只通过 `RawOrderUpdate.trade?` 随订单 update 原子到达**：私有 WS 如果在订单生命周期消息里同时带逐笔成交（Binance UM `ORDER_TRADE_UPDATE`、PAPI margin `executionReport`），adapter 必须在同一个 `RawOrderUpdate` 上填 optional `trade`，由 OrderManager 拆成订单状态事件与独立 `order.trade` 事件。Binance 只在 `x === "TRADE"` 且 `Number(l) > 0` 时填 `trade`；`trade.price = L`、`trade.qty = l`、`trade.tradeId = t`、`trade.maker = m`。UM 事件还映射 `trade.realizedPnl = rp` 与 `trade.positionSide = ps`；margin 事件没有 realized PnL / position side，不得伪造。手续费 `fee` 只有在 `n` 和 `N` 都存在时填写，`n` 为 `"0"` 或负值（maker rebate）也必须保留；`N` 缺失时省略整个 `fee`。adapter 不做 trade 去重、不累计 fee/realizedPnl、不持有任何成交状态；`exchangeTs` / `receivedAt` 继续放在父 `RawOrderUpdate` 上。
- **Binance margin 私有流事件必须按事件语义处理**：`executionReport.s` 走 spot catalog 映射 unified symbol；`outboundAccountPosition` 是 changed-asset balance snapshot（`free=f`、`used=l`、`total=f+l`），可直接发 `RawAccountUpdate.balances`；`balanceUpdate` 是 delta，不得当完整余额写入，也不作为常规 REST reconcile 触发源；`liabilityChange.l` 是当前 total liability，不是 delta，必须覆盖对应 asset 的 lending liability facet；`openOrderLoss` 当前没有 public risk 字段，必须进入 delayed private reconcile / risk refresh，不能静默丢弃。
- **private reconcile reason 要区分 immediate 与 delayed**：`PrivateStreamCallbacks.requestReconcile(reason)` 的 reason 至少包含 `symbol_mapping_miss`、`margin_balance_delta`、`margin_liability_change`、`margin_open_order_loss`。`symbol_mapping_miss` 影响 symbol 正确性，继续走 immediate；margin 风险/异常校准 reason 进入 per-account delayed queue，复用 private reconcile dirty/drain 机制，并设置 debounce + min interval，避免一条 WS 事件触发一次重 REST 对账。默认 `balanceUpdate` 和 `liabilityChange` 不触发 reconcile，只有异常恢复或衍生字段上下文不足时才使用对应 reason。
- **账号级 symbol 手续费费率走可选 `fetchSymbolFeeRate()`**：这是 private read API，不是订单 lifecycle update。adapter 输入接受 unified symbol，内部映射为 venue id；返回 `RawSymbolFeeRate { symbol, maker, taker, receivedAt }`，其中 `symbol` 必须回 unified symbol，`receivedAt` 必须在 REST 响应返回后采集。Binance PAPI UM 使用 `GET /papi/v1/um/commissionRate`，返回 `makerCommissionRate` / `takerCommissionRate`，权重 20，必须走 `SINGLE_ATTEMPT_IDEMPOTENT_POLICY` 和 `papiCommissionRate` semantic rate-limit plan。

#### 3.5 `refreshAccount()` 约束

- `refreshAccount()` 是可选 REST 校准接口，适用于私有 WS 不会持续推送账户级 risk / mark-to-market 仓位字段的 venue。
- 新增或修改任何“实时”账户字段前，必须先确认交易所 WS 事件是否会因该字段变化而推送，不能只凭字段出现在某个 WS payload 就假设它会持续更新。价格、PnL、保证金、风险率、实际杠杆等 mark-to-market 字段通常会随行情变化；如果 WS 只在成交/转账/保证金变更等账户事件推送，就必须用 REST polling 或其它明确的行情/账户 refresh 机制校准。
- 返回值必须是 `RawAccountUpdate`，走 manager 现有的增量合并路径；不要在 adapter 层直接构造 `AccountSnapshot`。
- Binance 当前由 coordinator 以 `account.venues.binance.riskPollIntervalMs`（默认 5s）调度，调用 `/papi/v1/account` + `/papi/v1/um/positionRisk`，刷新 `risk.netEquity`、`risk.riskEquity`、`risk.riskRatio`、`risk.riskLeverage`、margin 字段，以及 position 的 `markPrice` / `unrealizedPnl` / `liquidationPrice` 等字段。PAPI `/papi/v1/account` 返回 `accountStatus` 时，adapter 应把它粗化到 `RiskSnapshot.riskLevel`：`NORMAL` → `normal`、`MARGIN_CALL`/`SUPPLY_MARGIN` → `margin_call`、`REDUCE_ONLY` → `reduce_only`、`FORCE_LIQUIDATION`/`ACTIVE_LIQUIDATION`/`BANKRUPTED` → `force_liquidation`；未知 REST 状态不填。
- `refreshAccount()` 不是全量替换语义：如果交易所返回的是部分 position 列表，缺失 position 不会被清空。需要清空 stale positions 时必须走 `bootstrapAccount()` / `onAccountSnapshot` 的全量替换路径，或由 WS 增量明确发送 size=0。
- refresh 成功只代表 REST 校准成功，不代表私有 WS 已恢复。coordinator 调用 manager 时必须保留当前 stream status，不能让 refresh update 把 `reconnecting` / `ws_disconnected` 覆盖成 `healthy`。
- refresh 失败必须 `throw Error`，由 `PrivateSubscriptionCoordinator` 发布 runtime error 并把 account 状态置为 `degraded` / `http_failed`；adapter 不得吞错返回空 update。
- **已知限制（bootstrap vs stream 竞态）**：`onPrivateAccountBootstrap` 是无条件全量替换 `record.snapshot`、不走 watermark。若任何 WS 增量（余额/仓位/risk，含 `riskLevelChange` 风控回填）先于 bootstrap 响应到达，会被较旧的 bootstrap 快照覆盖。当前低危（仅订阅初期窗口、下一轮 `riskPollIntervalMs` reconcile 自愈、对应公开事件已独立发布不丢），暂未修；将来修复须让 bootstrap 对已存在的更新快照走 merge/watermark（见 `todo/improvement-todo.md` P2-13）。

#### 3.6 错误传播

| 场景 | 契约 |
|---|---|
| 同步构造错误（URL 拼装失败、前置参数非法） | `throw`，让调用方立刻失败 |
| `ready` 阶段异步失败（握手超时、close-before-ready） | 让 `ready` promise reject，不要再触发 `onError` |
| 稳态阶段异步错误（消息解析失败） | 走 `onError`，不要 throw 到事件 loop |
| 稳态阶段连接断开 | 走 `onDisconnected`，不要 throw，不要走 `onError` |
| 交易命令 REST 失败（`createOrder` / `cancelOrder` / `cancelAllOrders`） | `throw Error`，让上层 manager 包装成 `ORDER_CREATE_FAILED` / `ORDER_CANCEL_FAILED` / `ORDER_CANCEL_ALL_FAILED` |
| bootstrap 失败 | `throw Error`，manager 包装成 `ACCOUNT_BOOTSTRAP_FAILED` / `ORDER_BOOTSTRAP_FAILED` |
| refresh 失败 | `throw Error`，coordinator 通过 account stream state 标记 `degraded` / `http_failed`，下一轮 polling 继续尝试 |
| refresh 成功但 WS 仍断开 | 更新 snapshot / events，但保留 `reconnecting` / `ws_disconnected` 状态 |

adapter 不得自己构造 `AcexError` 或其他业务错误码——错误码是 public contract 的一部分，归 manager / runtime 定义（参考 `src/errors.ts`）。

#### 3.7 交易所特定类型不得泄漏

- adapter 的所有 public 方法签名只能出现 `src/types/*` 或 `src/adapters/types.ts` 里声明的类型。
- 交易所特定子类型（如 `BinanceMarketDefinition`）可以在 adapter 内部使用，但不得出现在返回值或回调参数签名中。
- Raw 类型（`RawL1BookUpdate` / `RawAccountBootstrap` / ...）是跨 adapter 的统一边界；任何新数据类型必须先在 `src/adapters/types.ts` 加入对应 `Raw*` 形状，再由具体 adapter 实现。

#### 3.8 时间戳约定

- `exchangeTs`：优先使用交易所推送的原始时间。缺失时允许 `undefined`，**不要伪造**（不能退而 `Date.now()`）。
- `receivedAt`：必须是 SDK 本地时间（`Date.now()` 或 ManagedWebSocket 注入的 `now()`），用于超时 / freshness 计算，不信任交易所时钟。
- 两者单位统一为毫秒。
- `exchangeTs` 与 `receivedAt` 属于不同 clock domain。freshness / watermark 优先比较同类时间戳：`exchangeTs` vs `exchangeTs`、`receivedAt` vs `receivedAt`；当一侧缺少 `exchangeTs` 时，允许跨 `exchangeTs` / `receivedAt` 做兜底，但必须带安全余量，默认 `CROSS_CLOCK_WATERMARK_GRACE_MS = 10_000`，并结合请求生命周期边界（如 REST `requestStartedAt`）防止旧 REST 覆盖新 WS。
- **签名 / 请求时间**：私有签名请求的 `timestamp` 由可注入的 `TimeProvider`（`src/types/shared.ts`，public）提供 —— 经 public `CreateClientOptions.clock` 覆盖，venue 层用**独立**选项接收（Binance adapter 的 `signingClock`，`private-adapter.ts`）。优先级：调用方 `accountOptions.timestamp` > `clock.now()` > 本地 `Date.now()`；`recvWindow` 语义不变。默认 runtime 会创建 venue 级 `SyncingTimeProvider`，用 Binance server-time 样本校准签名 timestamp；调用方显式注入 `clock` 时视为完全接管签名时间，并关闭默认自动同步（不创建 sampler / timer）。
- **签名时钟 ⟂ freshness 时钟（硬约束）**：`signingClock` 只决定签名 / 请求时间，**绝不能**复用或驱动 `receivedAt` / freshness 的 `now()`。两者必须独立可覆盖，server-time offset 只能加在签名 timestamp 上，**不污染** §3.8 freshness 契约。`TimeProvider.requestResync?()` 只是 venue adapter 发出的“签名时间被交易所拒绝”信号；Binance private adapter 在归一到 `timestamp_out_of_sync`（如 `-1021` / `-5028`）时调用它，adapter 不持有任何 offset / 采样 / timer 逻辑。共享 HTTP 客户端不公共可替换，`clock` 仍是签名时间的唯一公共覆盖位。

#### 3.9 ManagedWebSocket 复用要求

- 所有 WebSocket 流**必须**通过 `createManagedWebSocket()`（`src/internal/managed-websocket.ts:47`）构造，禁止 `new WebSocket(...)`。
- 原因：
  - 统一的 initial-message timeout / stale watchdog
  - 统一的指数退避重连
  - 统一的消息解析错误包装
- 需要 adapter 提供的回调 / 选项：`parseMessage`、`onMessage`、`onUnexpectedClose`、`readyWhen`、`messageWatchdog`、`reconnect`；adapter 把交易所特定的 URL 拼装和消息解析注入到这些钩子里，不要自己实现心跳 / 重连。
- 连接拓扑：
  - **行情流不再每 symbol 一条物理连接**。行情走 `SubscriptionMultiplexer`（§3.10），同一 `(venue, channel, base URL)` 下的多个 symbol 复用**一条**物理连接，通过 JSON `SUBSCRIBE`/`UNSUBSCRIBE` 控制帧动态增删。复用器内部仍只通过 `createManagedWebSocket()` 建连。
  - **私有流仍按 account 一条** ManagedWebSocket。
  - 每个 logical 订阅的生命周期由其 `StreamHandle` 收口；物理连接在其上最后一个 logical 订阅关闭时才断开。

#### 3.10 行情连接多路复用（SubscriptionMultiplexer）

行情侧的连接复用由 venue-agnostic 的 `src/internal/subscription-multiplexer.ts` 实现，交易所细节通过注入的 `VenueStreamProtocol` 策略收口（参考实现 `src/adapters/binance/stream-protocol.ts`）。

- **职责划分**：
  - 通用核（`SubscriptionMultiplexer`）：按 `connectionKey` 池化物理连接、引用计数、重连后重放订阅、控制帧批量+限速、per-subscription ready / freshness fan-out、连接级 stale watchdog、最后一个订阅关闭时拆连接、单连接订阅数达上限时同 `connectionKey` 开新连接（连接池）。
  - venue 策略（`VenueStreamProtocol`）：`subscriptionKey` / `connectionKey` / `connectionUrl` / `parseMessage` / `encodeSubscribe` / `encodeUnsubscribe` / `routeMessage(→ data|status|ack|ignore)`。所有交易所特定的 base URL、帧格式、消息路由判据都在这里，**不得**泄漏进通用核。
- **logical stream 契约**：
  - `ready`：该订阅的 subscribe ACK / 等价订阅接受信号到达时 resolve；超 `initialMessageTimeoutMs` 未到则 reject 并清理该订阅。若首条 `data` 在 ACK 前到达，且 `routeMessage` 能给出匹配的 `subscriptionKey`，该 data 同时作为等价订阅接受信号、payload 和 freshness 来源。
  - `status` route：只分发给 `callbacks.onStatus`，不清首包 timer、不 resolve `ready`、不把订阅 freshness 切成 `fresh`。只用于真正非数据型 stream 状态；Deribit quote 的 bid-only / ask-only / empty 必须使用 `data` route。
  - `close()`：发出该订阅的 `UNSUBSCRIBE`；物理连接保持，直到其上最后一个订阅 close 才断开。幂等。
  - stale：不做 per-subscription 独立 stale。只要同一物理连接仍有其他订阅收到消息，静默订阅保持 `fresh`；整条连接超过 `staleAfterMs` 无任何有效消息时，由连接级 watchdog 对该连接所有订阅触发 `onFreshnessChange("stale","heartbeat_timeout")`。
  - 断线：对该连接所有订阅 `onDisconnected()`（上层据此置 `ws_disconnected`），并**静默**置内部 freshness=stale（不再额外发 `heartbeat_timeout` freshness 事件）；重连 `open` 后自动重放全部活跃订阅，各订阅在各自首条消息回到 `fresh`。
- **限额（保守口径，依据 Binance 官方）**：
  - 单连接 stream 上限：Binance 现货与 USDⓈ-M 合约**均为 1024**（Options 才是 200，不适用）。本仓库 `maxSubscriptionsPerConnection` 取保守值 **200**，到上限即开新连接。200 不是交易所硬限制，而是运营上限：平衡控制帧开销、per-subscription heartbeat/control 消息、路由与 fan-out 的 CPU/内存成本、高订阅数下的延迟/丢包观测、连接稳定性与重连限额，以及突发订阅的安全余量。后续可依据 `tests/soak/`（尤其 market L1 continuity）与线上 telemetry/packet-loss/latency 指标重新调优。
  - 控制帧速率：现货 **5/秒**、USDⓈ-M 合约 **10/秒**。本仓库 `controlFrameMaxPerSec` 取较严的 **5/秒**，对两者都安全。
  - IP 维度：每 5 分钟最多 300 次连接尝试（连接池化天然降低连接数）。

#### 3.10.1 应用层心跳契约（可选）

`VenueStreamProtocol` 可以声明可选的 `heartbeat`，仅用于交易所要求客户端发送**应用层文本帧**保活的行情连接：

```ts
interface VenueHeartbeat {
  intervalMs: number;
  mode?: "fixed-interval" | "idle-timeout"; // 默认 idle-timeout
  pongTimeoutMs?: number;
  frame(): string;
  isPong(raw: string): boolean;
  countAnyInboundAsActivity?: boolean; // 默认 true
}
```

- 心跳执行点固定在 `createManagedWebSocket()`，不在 adapter 或 multiplexer 外层自行维护 timer。原因是只有 ManagedWebSocket 能看到 raw message、底层 socket、watchdog 和 reconnect 状态。
- `isPong(raw)` 必须在 `parseMessage()` 前判断；命中后消费该 raw 帧，不进入 `routeMessage()`，不作为 data/ack 分发。Bybit linear/inverse 的 pong 示例里 `op` 仍是 `"ping"`，实现必须结合 `ret_msg === "pong"` 等字段精确匹配。
- `mode:"idle-timeout"` 表示距离上次入站活性满 `intervalMs` 才发送 `frame()`；`mode:"fixed-interval"` 表示每 `intervalMs` 检查发送一次。`countAnyInboundAsActivity` 默认 `true`，任意 raw 入站帧都会重置 idle 计时；设为 `false` 时只有 pong 会重置 heartbeat idle。
- 配置 `pongTimeoutMs` 后，发送 ping 到收到 `isPong(raw)` 前视为 pending pong；pending 未结清期间不得重复发送 ping。超时后必须对**底层 raw socket** 调 `close()`，复用 ManagedWebSocket 既有 close → reconnect 路径，不能调用 session 级 `close()`（后者会置 `closed=true` 并禁止重连）。重连后由 `SubscriptionMultiplexer` 自动 replay 活跃订阅。
- heartbeat idle/ping/pong timer 必须纳入 ManagedWebSocket 的 `clearTimers()`：session close、socket close event、重连前都要清理；timer callback 必须校验 `activeSocket === socket`。`readyWhen:"message"` 时，应用层 pong 只能证明连接活性，不能清 initial-message timeout，也不能 resolve `ready`。
- 未声明 `heartbeat` 的 protocol 行为必须保持完全不变。当前 Binance 行情流不配置应用层 heartbeat。
- WebSocket 协议层 ping/pong（opcode 9/10）不通过此接口建模；假设 Bun/WebSocket 客户端会按 RFC6455 自动回复服务端 ping。Gate futures 与 Binance 这类依赖协议层 pong 的 venue 不应为了协议层 pong 配置 `heartbeat`。若未来替换 WebSocket runtime 或发现自动 pong 行为变化，必须先补 Bun client 自动 pong 回归探针，再调整该假设。

#### 3.10.2 observability metric 注入契约

- Public 注入点固定为 `CreateClientOptions.onMetric(name, value, type, tags?)`；`MetricType = "counter" | "gauge" | "timing"`，SDK 自带 metric name 必须从 `METRIC_NAMES` 常量导出并在 `docs/managers.md` 列表说明。
- Runtime 持有 `onMetric`，通过 `ClientContext.emitMetric()` 暴露给 manager / coordinator；`emitMetric()` 第一行必须在无 hook 时直接 return，并用 `try/catch` 吞掉 callback 异常。observability callback 不得打断下单、订阅、reconnect 或事件发布主流程。
- 热路径必须先判 `context.metricsEnabled`，再计算 latency 和构造 tags。当前热路径包括 L1 book `onUpdate`、private account/order update。未配置 `onMetric` 时，不得为这些路径构造 `{ venue, symbol }` / `{ accountId }` tags。
- Adapter 层需要 metric 时，必须经 runtime factory deps 注入 `emitMetric`，与 `publishRuntimeError` 的注入方向一致；adapter 不得直接读取 `CreateClientOptions` 或 import runtime。当前 market reconnect 由 `SubscriptionMultiplexer.onReconnect` 通知 adapter，再由 adapter 发 `METRIC_NAMES.wsReconnect`。
- 当前四类 SDK metric 的位置固定：
  - `order.command.rtt`：`OrderManagerImpl.createOrder()` / `cancelOrder()` / `cancelAllOrders()`，用 `performance.now()` 包住 `await context.*`，tags 为 `venue`、`op`、`accountId`、`outcome`。
  - `ws.message.latency`：L1 tick 在 `MarketManagerImpl` 的 L1 `onUpdate`；private account/order 在 `PrivateSubscriptionCoordinator` 的 `onAccountUpdate` / `onOrderUpdate`。只有 `exchangeTs` 存在时发，value 为 `receivedAt - exchangeTs`。
  - `ws.reconnect`：private 在 coordinator `onReconnected`；market 在 multiplexer 识别已建立连接再次 open 后，经 Binance market adapter 发出。tags 至少包含 `venue` 与 `channel`。
  - `event.buffer.overflow`：所有 `AsyncEventBus` buffer overflow handler 发 counter，tags 为 `stream`。runtime / manager 的 overflow handler 仍必须继续发布 `EVENT_BUFFER_OVERFLOW` runtime error。

### 4. Validation & Error Matrix

| 场景 | 正确做法 | 禁止做法 |
|---|---|---|
| 订阅 ACK / 初始 ready 超时 | `ready` reject 并自动 close | 超时后继续挂着等下一条 |
| `close()` 被外部调用两次 | 第二次 no-op | 抛 `ClosedError` 或重复清 timer |
| 稳态时 WS 被对端关闭 | 触发 `onDisconnected` + 内部触发 ManagedWebSocket 重连 | 让 adapter 自行 `setTimeout` 重连 |
| 整条连接长时间不收消息 | 连接级 watchdog 对该连接所有订阅触发 `onFreshnessChange("stale", "heartbeat_timeout")` | 单个订阅静默时自行标 stale 或主动 close 重连 |
| 交易所要求应用层客户端 ping | 在 `VenueStreamProtocol.heartbeat` 声明文本帧、pong 判定、调度模式；由 ManagedWebSocket 统一调度 | adapter/multiplexer 外层自行 `setInterval` 发 ping |
| 收到应用层 pong raw 帧 | 在 `parseMessage()` 前消费，清 pending pong、刷新连接活性，不路由给订阅 | 让 pong 进入 `routeMessage()` 或误判为 data/ack |
| 应用层 ping 超过 `pongTimeoutMs` 未收到 pong | 对底层 raw socket 调 `close()`，复用 close→reconnect→replay 路径 | 调 session `close()` 禁掉重连，或直接在 adapter 手写重连 |
| `readyWhen:"message"` 期间只收到应用层 pong | 保持 initial-message timeout 未清，`ready` 不 resolve | 把 pong 当首条业务消息导致 ready 提前成功 |
| 未配置 `heartbeat` 的 protocol | 不创建应用层 ping/pong timer，行为与旧版本一致 | 给所有 venue 默认发送应用层 ping |
| 对端推送未知 event 字段 | 跳过，不触发任何回调 | `throw` 或者 `onError` |
| Binance private WS 推送 `listenKeyExpired` | adapter 内部轮换 listenKey + 新 WS，成功后 `onReconnected()` | 当未知事件丢弃，或只等 60s REST reconcile |
| listenKey keepalive 重试耗尽 | 上报错误并轮换 listenKey + 新 WS | 只 `onError` 后继续复用旧 listenKey |
| 交易命令 REST 返回非 2xx | 异步 `throw`，带交易所原始 message | 吞掉返回 `undefined` |
| server-time REST 返回非 2xx | adapter 抛 `TransportError`，manager 包装 `MARKET_SERVER_TIME_FETCH_FAILED` | adapter 构造 `AcexError` 或自动重试 |
| server-time 响应缺 `serverTime` / 非 number | adapter 抛普通 `Error`，manager 包装 `MARKET_SERVER_TIME_FETCH_FAILED` | 返回 `NaN` / `undefined` 或伪造本地时间 |
| funding history REST 返回非 2xx 或响应结构不合法 | adapter 抛 `TransportError` / 普通 `Error`，manager 包装 `MARKET_FUNDING_RATE_HISTORY_FETCH_FAILED` | adapter 构造 `AcexError` 或吞错返回空数组 |
| spot / dated future 查询 funding history | manager 抛 `MARKET_FUNDING_RATE_UNSUPPORTED`，不发远端请求 | 让交易所返回空数组或 venue-specific error |
| COIN-M funding history 缺 `markPrice` | 返回 `markPrice: undefined`，其余字段正常 | 把 `markPrice` 当必填导致 parse failure |
| server-time 限流等待 | 在 `beforeRequest()` 后才采集 RTT 起点 | 把 limiter sleep 计入 `roundTripMs` |
| listenKey 过期前未续期 | adapter 内部重续 | 等待失败后靠 reconnect 恢复 |
| 新数据类型只覆盖一家交易所 | 先在 `adapters/types.ts` 加 `Raw*`，再在具体 adapter 实现 | 只在具体 adapter 加字段 |
| WS 不推送 mark-to-market risk | 实现 `refreshAccount()` 并由 coordinator polling 校准 | 假设 `ACCOUNT_UPDATE` 会定时推送 risk |
| 私有 WS 只提供增量 account/order 事件 | 实现 REST reconcile，校准 balances / positions / orders 并清理 stale 本地状态 | 只依赖增量 WS，假设消息永不丢失 |
| 私有 WS 会定期推权威全量 private snapshot | 可不启用 REST 定时对账，但必须用全量快照清理 stale 本地状态 | 不加 REST reconcile，也不证明 WS 快照能清理 stale 状态 |
| 新增实时账户字段 | 核对交易所 WS 推送触发条件；必要时加 polling/refresh 和 stale 语义 | 看到 WS payload 字段就认为它会随行情实时推送 |
| REST refresh 在 WS 断线期间成功 | 保留 stream status，直到 WS reconnect/reconcile 成功 | 把 account status 改回 `healthy` |
| Binance `ORDER_TRADE_UPDATE` 为 `x=TRADE,l>0` | 在父 `RawOrderUpdate.trade` 填逐笔成交 raw 字段 | 在 adapter 内累计 fee / realizedPnl，或按 truthy 判断丢掉 `"0"` 手续费 |
| Binance `ORDER_TRADE_UPDATE` 非 TRADE 或 `l=0` | 只返回订单状态 update，不填 `trade` | 发布空成交、用累计成交量 `z` 伪造逐笔成交 |
| Binance margin `executionReport` 为 `x=TRADE,l>0` | 走 spot catalog 映射 symbol，在父 `RawOrderUpdate.trade` 填成交价量、tradeId、maker、fee；不填 realizedPnl / positionSide | 用 USDM catalog 映射 spot symbol，或伪造 futures-only 字段 |
| Binance margin `outboundAccountPosition` | 作为 changed-asset balance snapshot 本地应用 | 当成全账户 snapshot 清空其它资产 |
| Binance margin `balanceUpdate` | 解析但默认不写余额、不常规触发 REST | 把 delta `d` 当 `free` / `total` 写入，或每条事件触发 reconcile |
| Binance margin `liabilityChange` | 用 `l` 覆盖当前 borrowed/liability 字段，缺失 lending 字段由 manager 用 previous/default 补齐 | 把 `l` 当 delta 累加，或因 partial lending 字段缺失丢掉 update |
| Binance margin `openOrderLoss` | 进入 delayed private reconcile / risk refresh | 静默丢弃，或 immediate 每条事件 REST 对账 |

### 5. Good / Base / Bad Cases

#### Good

Binance 行情 adapter：`BinanceMarketAdapter` 持有 `definitions: Map<string, BinanceMarketDefinition>` 作为内部路由缓存，对外只返回 `MarketDefinition[]`；`createL1BookStream` / `createFundingRateStream` 把 `(channel, market)` 描述符交给共享的 `SubscriptionMultiplexer`，由 `BinanceStreamProtocol` 决定 base URL、订阅帧与消息路由。同一 base 下多 symbol 复用一条物理连接，这整块完全封装在 `adapters/binance/` + `internal/`，manager 层无感知。

```ts
// src/adapters/binance/adapter.ts（节选）
createL1BookStream(market, callbacks, options): StreamHandle {
  const binanceMarket = this.definitions.get(market.symbol);
  if (!binanceMarket) throw new Error(`Unknown Binance market: ${market.symbol}`);
  const handle = this.getMultiplexer(options).subscribe(
    { channel: "l1book", market: binanceMarket },
    {
      onPayload: (p, receivedAt) =>
        p.channel === "l1book" && callbacks.onUpdate({ ...p, receivedAt }),
      onFreshnessChange: callbacks.onFreshnessChange,
      onDisconnected: callbacks.onDisconnected,
      onError: callbacks.onError,
    },
  );
  return { ready: handle.ready, close: () => handle.close() };
}
```

Binance 私有 adapter：listenKey 续期、账户更新消息路由都在 `BinancePrivateAdapter` 内部，`PrivateSubscriptionCoordinator` 只看到 `onAccountUpdate` / `onOrderUpdate` / `onDisconnected` / `onReconnected`。

#### Base

只实现 `MarketAdapter` 不实现 `PrivateUserDataAdapter` 允许，但需要：

- 在 `.trellis/spec/sdk/venues/<venue>.md` 或 README 明确标注该 venue 仅支持行情
- runtime 注册时不要给该交易所挂账户，否则 `subscribeAccount()` 会因为私有 adapter 缺失直接失败

#### Bad

```ts
// adapter 内部自己维护跨 symbol 状态 + 自己重连
export class BadMarketAdapter implements MarketAdapter {
  private books = new Map<string, L1Book>();
  private ws?: WebSocket;

  createL1BookStream(market, callbacks) {
    this.ws = new WebSocket(url);
    // 自己做重连、自己维护 books
  }
}
```

问题：

- 持有跨 symbol 状态，和 manager 的 `records` Map 出现两份真源
- 直接 `new WebSocket` 绕过 ManagedWebSocket，重连、watchdog、解析错误都没统一
- 如果两条 stream 都回写 `books`，顺序不可预期

```ts
// adapter 吞错误
async bootstrapAccount(credentials) {
  try {
    const res = await fetch(url);
    return normalize(res);
  } catch {
    return { balances: [], positions: [], receivedAt: Date.now() };
  }
}
```

问题：

- Manager 无法区分「账户是空」和「REST 调用失败」
- `ACCOUNT_BOOTSTRAP_FAILED` 错误永远不会被抛出

### 6. Tests Required

每次新增 adapter 或修改接口，至少执行：

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- 类型检查覆盖 `MarketAdapter` / `PrivateUserDataAdapter` 接口的完整实现（缺方法会直接 type error）
- 修改或新增 `fetchServerTime()` 时必须覆盖正常解析、HTTP 失败、无自动重试、缺失 / 非 number `serverTime`、限流顺序、单调时钟 RTT、manager 错误包装与不支持 venue。
- 修改或新增 public market REST query（如 raw trades / funding history）时必须覆盖：endpoint/参数映射、`receivedAt` 采样、raw clone、manager canonical 化、unsupported venue/market、adapter failure error wrapping、rate-limit semantic plan。
- 修改 Binance derivatives catalog 归一化时必须覆盖 `TRADIFI_PERPETUAL` fixture，断言其 symbol 为永续格式（如 `AAPL/USDT:USDT`）、`type:"swap"`、无 `expiry`，并能走 L1 book 与 funding/mark price 订阅。
- `tests/integration/market.test.ts`、`tests/integration/account.test.ts`、`tests/integration/order.test.ts` 针对各 manager 的集成测试仍然过——这些测试通过 fake REST / fake WebSocket 间接验证 adapter contract。
- 修改 `refreshAccount()` 或 account polling 时，必须覆盖 REST refresh 后 `risk.updated` 与 `position.updated` 都通过 public event/getter 可见。
- 新增随行情变化的账户字段时，测试必须覆盖“没有 WS 消息、只有 refresh/polling”时字段仍会更新；同时覆盖 WS 断线期间 refresh 成功不会把 stream status 改成 healthy。
- 必须覆盖 WS disconnected + REST refresh succeeded 的回归：snapshot 可更新，但 account status 仍是 `reconnecting` / `ws_disconnected`。
- 修改 Binance private listenKey / 私有 WS 生命周期时，必须覆盖：`listenKeyExpired` 消息触发新 listenKey URL、keepalive 失败触发新 listenKey URL、message watchdog stale 将状态标记为 `heartbeat_timeout` 并触发新 listenKey URL；同时断言旧 listenKey 会尽力 DELETE。
- 修改应用层 heartbeat contract 时，`tests/unit/subscription-multiplexer.test.ts` 必须覆盖：`idle-timeout` 与 `fixed-interval` 两种调度、`countAnyInboundAsActivity` 重置 idle、`isPong(raw)` 在 parse 前消费、pending pong 期间不重复发 ping、`pongTimeoutMs` 触发 raw socket close→reconnect→replay（含同一 subscription 多 subscriber）、close/reconnect 后 timer 不泄漏、未配置 heartbeat 的连接不发送应用层 ping。`tests/unit/managed-websocket.test.ts` 必须覆盖 `readyWhen:"message"` 下 pong 不清 initial-message timeout。
- 修改 Binance `ORDER_TRADE_UPDATE` 映射时，必须覆盖 `x/t/l/L/n/N/rp/m/ps`：`x=TRADE,l>0` 填 `RawOrderUpdate.trade`；非 TRADE 和 `l=0` 不填；`fee.cost` 为 `"0"` 或负值时不丢；`N` 缺失时省略 `fee`。
- 修改 Binance margin 私有流映射时，必须覆盖 `executionReport`、`outboundAccountPosition`、`balanceUpdate`、`liabilityChange`、`openOrderLoss`：spot symbol 映射、trade 原子发布、delta 事件不误写余额、liability 不累加、open order loss 进入 delayed reconcile。
- 修改 private reconcile reason / debounce 时，必须覆盖 `symbol_mapping_miss` immediate、margin reason delayed、窗口内多 reason 只触发一次 REST reconcile、REST refresh 成功不覆盖 websocket 断线状态。
- `tests/unit/managed-websocket.test.ts` 验证 ManagedWebSocket 行为未被新 adapter 破坏。
- live smoke（`bun run test:live:market:smoke` / `:account:smoke` / `:order:smoke`）至少跑一遍 subscribe → get → unsubscribe 完整路径，断言 adapter 能回到 `activity = inactive` 且无资源泄漏。

对新交易所补充：

- 新交易所 fixture 放在 `tests/support/exchanges/<venue>.ts`，复用 `tests/support/test-utils.ts`，不要复制 `FakeWebSocket` / `nextEvent()` 等通用 helper。
- 至少一份 adapter 单元测试放在 `tests/unit/`，覆盖 catalog 解析、symbol 构造、消息解析边界。
- 至少一份 fake-infra 集成测试放在 `tests/integration/`，覆盖 subscribe → event → getter → unsubscribe 的 public API contract。
- live smoke 脚本新增对应 `test:live:<venue>:*` 入口。

### 7. Wrong vs Correct

#### Wrong — 绕过 ManagedWebSocket

```ts
createSingleMessageStream(callbacks): StreamHandle {
  const ws = new WebSocket(url);
  ws.onmessage = (e) => callbacks.onUpdate(parse(e.data));
  ws.onclose = () => {
    callbacks.onDisconnected();
    setTimeout(() => this.createL1BookStream(market, callbacks), 1000);
  };
  return { ready: Promise.resolve(), close: () => ws.close() };
}
```

问题：

- 没有 initial-message timeout
- 没有 stale watchdog
- 重连延迟硬编码，无指数退避、无上限
- 递归 reconnect 容易泄漏 handler
- 对需要首条消息确认的单条 stream，`ready` 在首条消息前就已 resolve，破坏了 ready-barrier 语义

#### Correct — 基于 ManagedWebSocket

```ts
const session = createManagedWebSocket<BookTickerMessage>({
  url,
  initialMessageTimeoutMs: options.initialMessageTimeoutMs,
  readyWhen: "message",
  parseMessage,
  onMessage: (msg, receivedAt) => callbacks.onUpdate(toRawUpdate(msg, receivedAt)),
  onUnexpectedClose: () => callbacks.onDisconnected(),
  messageWatchdog: {
    staleAfterMs: options.staleAfterMs,
    onStale: () => callbacks.onFreshnessChange("stale", "heartbeat_timeout"),
  },
  reconnect: {
    initialDelayMs: options.reconnectDelayMs,
    maxDelayMs: options.reconnectMaxDelayMs,
  },
});

return { ready: session.ready, close: () => session.close() };
```

效果：

- 所有生命周期由 ManagedWebSocket 统一处理
- 对需要首条消息确认的单条 stream，`ready` 在首条消息到达时才 resolve，ready-barrier 语义一致
- freshness / reconnect / watchdog 行为与其他 adapter 完全一致

> 注：上例是**单条流**的标准写法。**行情流**改走 `SubscriptionMultiplexer`（§3.10）以复用物理连接：复用器内部同样只用 `createManagedWebSocket`，但 ready/stale 改为 per-subscription，ready 由 subscribe ACK / 等价订阅接受信号兑现，订阅/退订走 JSON 控制帧，重连后自动重放。adapter 侧只需实现 `VenueStreamProtocol` 策略，不要自己持有多条 per-symbol 连接。

#### Wrong — 泄漏交易所特定类型

```ts
async loadMarkets(): Promise<BinanceMarketDefinition[]> {
  return await loadBinanceMarkets();
}
```

问题：

- Manager 层会出现 `BinanceMarketDefinition` 类型引用，破坏层级隔离
- 跨 adapter 用同一 manager 时类型冲突

#### Correct — 只暴露标准化类型

```ts
async loadMarkets(): Promise<MarketDefinition[]> {
  const markets = await loadBinanceMarkets();
  this.definitions.clear();
  for (const m of markets) this.definitions.set(m.symbol, m);
  return markets; // BinanceMarketDefinition extends MarketDefinition，协变安全
}
```

效果：

- 对外契约稳定
- adapter 内部仍可用 `this.definitions` 做路由，不丢信息

---

## Scenario: 新增 / 迁移 adapter 的 REST 调用时，必须复用共享 HTTP 传输客户端（`src/internal/http-client.ts`）

### 1. Scope / Trigger

- Trigger: adapter 需要发起任何 REST 请求时——catalog 拉取（`loadBinanceMarkets`）、签名私有请求（账户 / 持仓 / 下单 / 撤单）、listenKey 创建与 keepalive、只读 polling（Juplend 借贷账户）。
- 目标: REST 链路与 WS 链路（§3.9 ManagedWebSocket / §3.10 SubscriptionMultiplexer）对称——交易所细节由 venue 注入，统一的 timeout / 重试 / 错误分类 / **密钥脱敏**收口在一个 venue-agnostic 的 Layer 0 原语里，禁止 adapter 直接用裸 `fetch` 拼请求。
- `httpRequest` 是 REST 侧的 `createManagedWebSocket` 对位物：venue 注入 URL / signing / headers / 文案，client 不含任何交易所特定逻辑。共享 HTTP 客户端负责 timeout / retry / typed `TransportError` / redaction；限流等待由注入的 `RateLimiter.beforeRequest()` 在 adapter 调用 `httpRequest()` 前完成，签名时间由独立 `TimeProvider` 提供。

### 2. Signatures

定义在 `src/internal/http-client.ts`（引用源码，不重复展开）：

```ts
export async function httpRequest<T>(options: HttpRequestOptions): Promise<HttpClientResponse<T>>;

export interface HttpRequestOptions {
  readonly fetchFn?: FetchLike;        // 可注入，测试用 fake fetch
  readonly url: string | URL;          // venue 拼好的完整 URL（含 query / signature）
  readonly method?: string;
  readonly headers?: RequestInit["headers"];
  readonly body?: RequestInit["body"];
  readonly signal?: AbortSignal;       // upstream 取消
  readonly timeoutMs?: number;
  readonly parseAs: "json" | "text" | "none";
  readonly jsonParseMode?: "text" | "response";
  readonly emptyBody?: "empty_object" | "empty_string" | "undefined";
  readonly retryPolicy: HttpRetryPolicy;
  readonly messages?: HttpClientMessages; // venue 注入错误文案
}

export interface HttpRetryPolicy {
  readonly idempotent: boolean;        // false ⇒ 任何 kind 都不重试
  readonly maxAttempts: number;
  readonly initialDelayMs?: number; readonly maxDelayMs?: number;
  readonly jitterRatio?: number; readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class TransportError extends Error {        // 唯一对外错误形状
  readonly isAcexTransportError = true;            // 鸭子类型标记，跨 bundle 安全
  readonly kind: "timeout" | "http" | "network" | "rate_limited" | "parse";
  readonly status?: number; readonly statusText?: string;
  readonly retryAfterMs?: number;                  // 已解析的 Retry-After，供 RateLimiter / 调用方诊断消费
  readonly retryable: boolean; readonly attempts: number;
  readonly headers: Headers; readonly rawBody?: string;  // rawBody 已脱敏
  readonly url: string;                            // 已脱敏（= redactedUrl）
}

export function isTransportError(error: unknown): error is TransportError; // 用它，不要 instanceof
export function redactSecrets(value: string): string;
export function redactUrl(input: string | URL): string;
export function parseRetryAfterMs(value: string | null): number | undefined;
```

venue 侧实际注入的 `HttpRetryPolicy`（`src/adapters/binance/private-adapter.ts`）：

```text
SINGLE_ATTEMPT_IDEMPOTENT_POLICY idempotent:true,  maxAttempts:1   Binance 只读 GET + listenKey keepalive
NO_RETRY_POLICY                  idempotent:false, maxAttempts:1   createOrder / cancelOrder / cancelAllOrders + 签名请求默认
// Binance catalog / server-time：inline { idempotent:true, maxAttempts:1 }
```

### 3. Contracts

#### 3.11 venue 注入，client venue-agnostic

- URL 拼装、签名（`timestamp` / `recvWindow` / `signature` / `X-MBX-APIKEY`）、headers、错误文案全部由 adapter 注入；`http-client.ts` 不得出现任何交易所特定字符串或分支。
- 签名等敏感串只存在于传入的 `url` / `headers` / `body`；client 只负责发送与**脱敏后**透传。

#### 3.12 per-call 幂等 = 调用点显式声明

- 重试性由**调用点**通过 `retryPolicy.idempotent` 显式声明，不由 client 猜 HTTP 方法。`idempotent:false` ⇒ 任何 kind 都不重试（见 `retryableForKind`）。
- 写操作（下单 / 撤单 / 任何 POST·DELETE 副作用请求）**必须** `NO_RETRY_POLICY`。
- Binance REST 请求如果已经走 `RateLimiter.beforeRequest()` admission，则 `httpRequest.retryPolicy.maxAttempts` 必须为 `1`，包括 catalog、server-time、私有只读 GET、listenKey POST/PUT/DELETE、订单命令。原因是交易所按实际 HTTP attempt 计费；在一次 reservation 下内部重试会让本地预算低估真实消耗。需要重试时应重新进入 adapter 调用路径并重新 admission，或未来显式实现 per-attempt reservation。
- 即便 `idempotent:true`，可重试的 kind 也只有 `network` / `timeout` / `http(5xx)`；`rate_limited` / `http(4xx)` / `parse` 一律 `retryable:false`。

#### 3.13 抛 typed `TransportError`，不构造 `AcexError`

- client 与所有 internal/adapter 代码**只抛 `TransportError`**，承接 §3.6「adapter 不得自己构造 `AcexError`」。错误码归 manager / runtime（`src/errors.ts`）。
- 消费方用 `isTransportError(e)` 做 narrowing，**不要 `instanceof`**（跨 bundle 不可靠，故有 `isAcexTransportError` 鸭子标记）。

#### 3.14 错误脱敏契约（安全关键）

- 对外可见的 `TransportError.message` / `TransportError.url` / `TransportError.rawBody`**都不得包含**签名或密钥：`signature`、`api[_-]?key` / `key`、`secret`、`token` / `access_token`、`listen[_-]?key`、`passphrase`。
- 实现保证：
  - URL 含 `signature` ⇒ 整段 query 折叠为 `?query=[REDACTED]`；含其它敏感 query key ⇒ 该值 `[REDACTED]`（`redactUrl`）。
  - 非 2xx 与 parse 失败的 `rawBody` 在抛出点先过 `redactSecrets`（URL / `key=value` / `"key":"value"` 三种形态，并把 `signature` 键名改写为 `redacted` 以免键名本身泄漏语义）。
  - `buildAttemptError` 传给 venue `messages` 回调的 `HttpErrorMessageInput` 中，`url` 已是 redactedUrl、`rawBody` 已脱敏——**venue 自定义文案也无法泄漏**，无需各 adapter 重复脱敏。
- 私有订阅 bootstrap 失败路径（`PrivateSubscriptionCoordinator`）把透传进 public `AcexError` 的 message 再过一次 `redactSecrets`（`bootstrapErrorDetail`）。

#### 3.15 `rate_limited` 分类

- `429` / `418` ⇒ `kind:"rate_limited"`，并用 `parseRetryAfterMs` 解析 `Retry-After`（支持秒数与 HTTP-date）存入 `retryAfterMs`；`retryable:false`，不由 HTTP retry 机制自动重放。
- 主动消费 `retryAfterMs` 做退避 / 全局限流由注入的 `RateLimiter`（§3.17）负责；HTTP retry 逻辑本身不 sleep、不自动重放 `rate_limited` 请求。

#### 3.16 body 解析与 empty body

- `parseAs:"json"` 默认走 text→`JSON.parse`，解析失败 ⇒ `kind:"parse"`、`retryable:false`、`rawBody` 脱敏后保留。
- `emptyBody:"empty_object"` 把空响应体解析成 `{}`（Binance 部分签名端点返回空 body 时保持原语义）；默认 `undefined`。

#### 3.17 限流器 seam（RateLimiter）

REST 限流由可插拔的 `RateLimiter`（`src/types/*`，public）收口，默认实现 `ReactiveRateLimiter`（`src/internal/rate-limiter.ts`，Layer 0、venue-agnostic；当前继承 `BudgetRateLimiter` 兼容旧名字）。经 public `CreateClientOptions.rateLimiter?` 注入（默认 reactive），与 `clock?` 同范式。

- **hook 形**：`beforeRequest(ctx)` / `afterResponse(ctx, response)` / `onTransportError(ctx, error)` / `getSnapshot(scope)`（可同步或返回 `Promise`）。adapter 在每次 REST 调用前后调用这些 hook。`beforeRequest()` 可返回 opaque `RateLimitReservation`，adapter 必须原样传给 `afterResponse()` / `onTransportError()`；返回 `void` 或 `Promise<void>` 的旧 custom limiter 仍是合法实现，**不得把 public 返回类型收窄成只允许 `undefined`**。
- **scope 粒度**：`{ venue, accountId?, endpointKey }`，`endpointKey` 取 `"<METHOD> <path>"`。weight 是 IP 维度、order-count 另算 —— `RateLimitUsage` 分 `weight` / `orderCount` 两轨，按 interval key（如 `"1m"`）存。
- **plan/topology 扩展**：adapter 可以在构造期 feature-detect optional `RateLimitTopologyRegistry.registerRateLimitTopology(topology)` 并注册 venue-owned bucket/plan 表；注册缺失时必须无事发生。相同 descriptor 重复注册必须幂等，冲突 descriptor 必须拒绝覆盖。请求上下文可带 `planId` 和 `priority`，但 `planId` 必须是 adapter 选择的语义 id，不要把它固定等同于 `endpointKey`（同 endpoint 可能有成本变体）。
- **venue-agnostic 核 + venue 层解析/拓扑**：通用核**不得**出现任何交易所 header 常量、endpoint 路径、权重数字或 bucket id。Binance 的 `X-MBX-USED-WEIGHT-*` / `X-MBX-ORDER-COUNT-*` 解析只在 venue 层（`src/adapters/binance/rate-limit.ts`，用 `Headers.get()` 大小写不敏感、保留未知 interval），Binance bucket/plan/cost 表只放在 `src/adapters/binance/`。
- **默认 budget 行为**：注册 topology 且请求带 known `planId` 时，默认 limiter 在 `beforeRequest` 中按 bucket 固定窗口主动 admission：wall-clock 对齐 `windowStart = floor(now / intervalMs) * intervalMs`，多桶 check+reserve 必须 all-or-none，预扣成功返回 opaque reservation。响应 hook 用 venue 解析出的 `RateLimitUsage` 回填 bucket 用量；reservation 的 bucket window 比当前 state 旧、或比当前本地窗口旧时必须忽略，不能复活旧窗口，也不能把旧响应 header 写进新窗口。未注册 topology / unknown plan / 旧 limiter fallback 到 endpoint-scope reactive 行为。known plan 下 `418` block request-weight bucket，`429` 若单桶可判断则 block 单桶，多桶或不可辨时保守 block plan 涉及的桶；`429` 缺 `Retry-After` 时，known bucket fallback 到当前 fixed window end + small jitter，不能退化成 1ms 短 block。`418` 缺 `Retry-After` 时默认 ban fallback 从 2 分钟起，连续 fallback 418 指数延长并封顶到 3 天，重复 block 只能延长不能缩短。
- **reserve headroom**：`RateLimitBucketDescriptor.reserve?: { priority, units }` 是 public topology contract。默认 limiter 对普通请求使用 `floor(limit * utilizationTarget) - reserve.units`，对匹配 `reserve.priority` 的请求允许使用 published `limit`，但仍正常预扣成本，不能无限 bypass。Binance 只在 PAPI request-weight 桶配置 `priority:"cancel"` 的 300 units/min reserve；整个撤单工作流（`cancelOrder`、`cancelAllOrders` prefetch GET + DELETE）必须传 `priority:"cancel"`。
- **退款语义**：transport error 默认不退预扣预算，避免订单已到交易所但本地超时/断网时错误放量；只有 adapter 明确传 `requestNotSent:true` 的 pre-HTTP 本地失败才可按 reservation 精确退款。
- **签名时序**：Binance 签名请求的 `beforeRequest` 退避必须在生成签名 `timestamp` **之前**，避免退避 sleep 导致签名时间过旧。
- **不构造 AcexError**：限流失败仍是 typed transport error（`kind:"rate_limited"`）冒泡；coordinator 经 `transportReason()` 映射到 runtime reason `"rate_limited"`（§3.6）。**非幂等请求遇 429/418 不自动重放**，只暴露状态 + retry metadata。
- **公共面**：`RateLimiter` 接口与 `RateLimit*` 类型为 public 契约；bucket-level snapshot 可以挂在 `RateLimitSnapshot.buckets`，但不挂上 `AcexClient` public API（仅作 seam 类型）。HTTP 客户端本身仍不公共可替换。

### 4. Validation & Error Matrix

| 场景 | `kind` | `retryable`（`idempotent:true` 时） | 备注 |
|---|---|---|---|
| `429` / `418` | `rate_limited` | **false** | 解析 `retryAfterMs`；默认 budget limiter 记录 bucket block，HTTP retry 不自动重放 |
| `5xx` | `http` | **true** | 唯一可重试的 http 状态段 |
| `4xx`（非 429/418） | `http` | false | 业务错误，重试无意义 |
| JSON 解析失败 | `parse` | false | `rawBody` 脱敏后保留 |
| 请求超时（本地 timeout 触发 abort） | `timeout` | **true** | `timedOut` 区分 timeout 与 upstream abort |
| upstream `signal` 取消 | `network`(aborted) | false | 不重试，调用方主动取消 |
| 网络/DNS 等 fetch 抛错 | `network` | **true** | |
| `idempotent:false`（下单/撤单） | 任意 | **false** | NO_RETRY 覆盖一切 kind |
| URL 含 `signature=...` | — | — | `url` / `message` 折叠为 `?query=[REDACTED]` |
| body 含 `"signature":"..."` 等 | — | — | `rawBody` / `message` 脱敏为 `[REDACTED]` |

### 5. Good / Base / Bad Cases

#### Good

下单走 `NO_RETRY_POLICY` + venue 注入签名与文案，错误天然脱敏：

```ts
// src/adapters/binance/private-adapter.ts（节选意图）
const response = await httpRequest<OrderAck>({
  url: signedUrl,                  // 含 signature，client 负责脱敏
  method: "POST",
  headers: { "X-MBX-APIKEY": apiKey },
  parseAs: "json",
  retryPolicy: NO_RETRY_POLICY,    // 写操作绝不重试
  messages: BINANCE_PRIVATE_HTTP_MESSAGES, // 只收到已脱敏的 url/rawBody
});
```

#### Base

受 RateLimiter 保护的 Binance 只读 catalog / polling 用 `{ idempotent:true, maxAttempts:1 }`：5xx / network / timeout 直接以 typed `TransportError` 暴露给上层恢复流程，不在一次 limiter reservation 下自动重放。文案复刻迁移前的原始格式（如 `BINANCE_CATALOG_HTTP_MESSAGES.http` 复刻 `Binance request failed: <status> <statusText>`），保证除重试预算修正外的行为等价。

Binance PAPI request-weight bucket 使用 cancel reserve，普通请求不能动用保留区，撤单请求仍计成本但可使用 published limit：

```ts
{
  id: BINANCE_RATE_LIMIT_BUCKETS.papiRequestWeight1m,
  kind: "request_weight",
  limit: 6_000,
  intervalMs: 60_000,
  scope: ["venue"],
  reserve: { priority: "cancel", units: 300 },
}
```

#### Bad

```ts
// ❌ 绕过 client 直接 fetch：签名进日志、无 timeout、无分类
const res = await fetch(signedUrl);
if (!res.ok) throw new AcexError("ORDER_CREATE_FAILED", await res.text()); // 双重违约

// ❌ 下单用可重试策略：网络抖动下重复下单
retryPolicy: SINGLE_ATTEMPT_IDEMPOTENT_POLICY, // 写操作严禁

// ❌ 受 RateLimiter 保护的 Binance REST 在一次 admission 下多次 attempt：预算会低估
retryPolicy: { idempotent: true, maxAttempts: 3 }

// ❌ 撤单 DELETE 标了 cancel，但 cancelAllOrders 的 prefetch GET 没标：
// prefetch 会被 normal cap 卡住，整个撤单流程仍可能无法启动
this.signedRequest("GET", "/papi/v1/um/openOrders", ..., undefined)
```

问题：泄漏签名、可能重复下单、在 internal/adapter 层构造 `AcexError`（违反 §3.6 / §3.13）。

### 6. Tests Required

- `tests/unit/http-client.test.ts` 必须覆盖的断言点：
  - json / text / empty(`empty_object`→`{}`) 三种 body 解析 + headers 透传。
  - 非 2xx：`isTransportError` 为真、`kind:"rate_limited"`、`status:429`、`retryAfterMs` 解析正确、`retryable:false`；**且 `message`/`url`/`rawBody` 均不含签名密钥、含 `[REDACTED]`**（脱敏是安全关键，必须钉死 rawBody 也被脱敏，而不仅是 url/message）。
  - parse 失败 ⇒ `kind:"parse"`、`retryable:false`。
  - timeout / upstream abort / network 三者区分，且 `idempotent:false` 时不重试。
- adapter 迁移到共享 client 时，必须提供**等价矩阵**：逐 REST 端点列出迁移前后的 method / 重试语义 / 错误 message 文案，标注 intended diff（如脱敏带来的 message 变化），其余必须保持等价。
- 改 Binance REST retry policy 或 RateLimiter admission 时，必须有回归测试证明受 limiter 保护的路径是单 attempt（例如 catalog、private safe read、listenKey keepalive），known bucket 的 `429` 无 `Retry-After` 会阻塞到 fixed window end + jitter，以及 normal 预算耗尽时 cancel priority 能使用 reserve 但仍消耗 bucket usage。新增 PAPI endpoint 必须补 semantic plan 断言；例如 `/papi/v1/um/commissionRate` 权重 20，对应 `BINANCE_RATE_LIMIT_PLANS.papiCommissionRate`。
- 全套 `bun run lint && bun run type-check && bun run test` 绿。

### 7. Wrong vs Correct

#### Wrong — 写操作可重试 + 裸 fetch 泄漏签名

```ts
async createOrder(creds, req) {
  const res = await fetch(`${base}/order?${sign(req)}`); // signature 进 URL
  if (!res.ok) {
    // res.url 含 signature，原样进错误信息 → 泄漏；且自行构造业务错误码
    throw new AcexError("ORDER_CREATE_FAILED", `failed ${res.url}`);
  }
  return parse(await res.json()); // 默认会被底层重试 → 重复下单
}
```

#### Correct — 共享 client + NO_RETRY + typed 错误 + 自动脱敏

```ts
async createOrder(creds, req) {
  const response = await httpRequest<OrderAck>({
    url: this.signedUrl("/papi/v1/um/order", req, creds),
    method: "POST",
    headers: { "X-MBX-APIKEY": creds.apiKey },
    parseAs: "json",
    retryPolicy: NO_RETRY_POLICY,            // 不重试
    messages: BINANCE_PRIVATE_HTTP_MESSAGES, // 只收到脱敏输入
  });
  return toRawOrderUpdate(response.body);    // 失败时抛 TransportError，由 manager 映射 ORDER_CREATE_FAILED
}
```

效果：签名永不进错误信息；写操作零重试；错误码归 manager；消费方用 `isTransportError` narrowing。
