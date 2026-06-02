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
  readonly marketCapabilities: VenueMarketCapabilities;
  loadMarkets(): Promise<MarketDefinition[]>;
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
  bootstrapAccount(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountBootstrap>;
  refreshAccount?(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawAccountUpdate>;
  bootstrapOpenOrders(
    credentials: AccountCredentials,
    accountOptions?: Record<string, unknown>,
  ): Promise<RawOrderUpdate[]>;
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

回调与标准化类型的完整定义位于同一文件：`RawL1BookUpdate`、`RawAccountBootstrap`、`RawAccountUpdate`、`RawOrderUpdate`、`L1BookStreamCallbacks`、`PrivateStreamCallbacks`、`L1BookStreamOptions`、`PrivateStreamOptions`。

当前参考实现：

```text
src/adapters/binance/adapter.ts            — BinanceMarketAdapter（行情经 SubscriptionMultiplexer 复用物理连接）
src/adapters/binance/stream-protocol.ts    — BinanceStreamProtocol（L1/funding 的 VenueStreamProtocol 策略）
src/adapters/binance/market-catalog.ts     — loadBinanceMarkets
src/adapters/binance/private-adapter.ts    — BinancePrivateAdapter（PAPI UM listenKey + WS）
src/adapters/juplend/private-adapter.ts    — JuplendPrivateAdapter（HTTP polling 只读借贷账户）
src/internal/subscription-multiplexer.ts   — SubscriptionMultiplexer（通用订阅多路复用原语，venue-agnostic）
```

capability 字段只声明该 adapter 的 SDK runtime 实现能力，完整聚合语义见 [Venue Capabilities](./venue-capabilities.md)。

### 3. Contracts

#### 3.1 `StreamHandle` 语义

- **`ready` resolve 时机**：
  - 行情 `createL1BookStream()` / `createFundingRateStream()`：该 **logical 订阅**首条通过 `routeMessage` 的有效 data 消息到达。行情流经 `SubscriptionMultiplexer` 复用物理连接，ready 是 **per-subscription** 的（物理连接本身用 `readyWhen: "open"`，不再把整条连接的首条消息当作某个订阅的 ready）。详见 §3.10。
  - 私有 `createPrivateStream()`：WebSocket `open` 事件后 + 鉴权 / listenKey 就绪（Binance PAPI UM 走 `readyWhen: "open"`，因为 listenKey 握手在 open 前已完成）
- **`ready` reject 时机**：初始连接超时、首条消息超时、WS close 在 ready 前发生。reject 后 adapter 内部必须自行调用 close（参考 `src/internal/managed-websocket.ts:172-175`）。
- **`close()` 必须幂等**：多次调用不抛错、不重复关 socket、不重复清 timer。
- **`close()` 之后不得再触发任何回调**。

#### 3.2 `loadMarkets()` 约束

- 返回顺序必须稳定（当前 `loadBinanceMarkets` 按 `symbol.localeCompare` 排序）。
- 交易所特定字段必须通过 `raw: Record<string, unknown>` 透传，**不能在顶层新增非 `MarketDefinition` 字段**。
- 不允许把 `<Venue>MarketDefinition`（比如 `BinanceMarketDefinition.family`）暴露到 `Promise<MarketDefinition[]>` 返回值里——adapter 内部可以持有子类型用于后续路由（参考 `BinanceMarketAdapter.definitions`），但对外签名仍是 `MarketDefinition[]`。
- 价格 / 数量精度字段：`priceStep`、`amountStep` 必须是 `BigNumber`；`pricePrecision`、`amountPrecision` 必须由 step 反推得到（参考 `market-catalog.ts` 的 `precisionFromStep`）。
- 不活跃市场 `active: false` 仍然要返回，不要在 adapter 里提前过滤。

#### 3.3 `createL1BookStream()` 回调约束

- `onUpdate(update)`：每条标准化后的 L1 推送一次，字段必须用字符串（`bidPrice` / `bidSize` / `askPrice` / `askSize`）。不得在 adapter 层预先转 BigNumber——BigNumber 转换在 manager 层完成。
- `onFreshnessChange("fresh" | "stale", reason?)`：`fresh` ↔ `stale` 必须成对，不允许连续两次 `stale`。`reason` 仅支持 `"heartbeat_timeout"`（其他原因由上层根据 `onDisconnected` 推断为 `"ws_disconnected"`）。
- `onDisconnected()`：每次底层连接关闭触发一次。包括主动 close（手动 unsubscribe）和被动 close（服务器断、网络断），manager 统一视为 `activity` 变化来源。
- `onError(error)`：仅用于不可恢复错误（消息解析失败、签名失败等）。**不要把 close 事件当成 error**。

#### 3.4 `createPrivateStream()` 回调约束

- `onAccountUpdate(update)` / `onOrderUpdate(update)`：消息类型路由由 adapter 负责（Binance 通过事件字段 `e` 分派）；同一条物理消息不得同时触发两个回调。
- `onDisconnected()` / `onReconnected()`：必须成对。`onReconnected` 只表示底层 WS 已重连成功，不代表上层已完成 reconcile——reconcile 由 `PrivateSubscriptionCoordinator` 触发。
- `onError(error)`：鉴权失败、listenKey 请求失败、消息解析失败等不可恢复错误。
- **listenKey keepalive 由 adapter 自己负责**：必须在 stream 内部维护定时 ping/keepalive（Binance PAPI UM 默认 30 分钟），不能让上层代理。`PrivateStreamOptions.listenKeyKeepAliveMs` 是调优参数，不是 on/off 开关。

#### 3.5 `refreshAccount()` 约束

- `refreshAccount()` 是可选 REST 校准接口，适用于私有 WS 不会持续推送账户级 risk / mark-to-market 仓位字段的 venue。
- 新增或修改任何“实时”账户字段前，必须先确认交易所 WS 事件是否会因该字段变化而推送，不能只凭字段出现在某个 WS payload 就假设它会持续更新。价格、PnL、保证金、风险率、实际杠杆等 mark-to-market 字段通常会随行情变化；如果 WS 只在成交/转账/保证金变更等账户事件推送，就必须用 REST polling 或其它明确的行情/账户 refresh 机制校准。
- 返回值必须是 `RawAccountUpdate`，走 manager 现有的增量合并路径；不要在 adapter 层直接构造 `AccountSnapshot`。
- Binance 当前由 coordinator 以 `account.binance.riskPollIntervalMs`（默认 5s）调度，调用 `/papi/v1/account` + `/papi/v1/um/positionRisk`，刷新 `risk.netEquity`、`risk.riskEquity`、`risk.riskRatio`、`risk.riskLeverage`、margin 字段，以及 position 的 `markPrice` / `unrealizedPnl` / `liquidationPrice` 等字段。
- `refreshAccount()` 不是全量替换语义：如果交易所返回的是部分 position 列表，缺失 position 不会被清空。需要清空 stale positions 时必须走 `bootstrapAccount()` / `onAccountSnapshot` 的全量替换路径，或由 WS 增量明确发送 size=0。
- refresh 成功只代表 REST 校准成功，不代表私有 WS 已恢复。coordinator 调用 manager 时必须保留当前 stream status，不能让 refresh update 把 `reconnecting` / `ws_disconnected` 覆盖成 `healthy`。
- refresh 失败必须 `throw Error`，由 `PrivateSubscriptionCoordinator` 发布 runtime error 并把 account 状态置为 `degraded` / `http_failed`；adapter 不得吞错返回空 update。

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
- **签名 / 请求时间**：私有签名请求的 `timestamp` 由可注入的 `TimeProvider`（`src/types/shared.ts`，public）提供 —— 经 public `CreateClientOptions.clock`（默认本地 `Date.now()`）注入，venue 层用**独立**选项接收（Binance adapter 的 `signingClock`，`private-adapter.ts`）。优先级：调用方 `accountOptions.timestamp` > `clock.now()` > 本地 `Date.now()`；`recvWindow` 语义不变。默认即本地时钟，行为与收口前等价。
- **签名时钟 ⟂ freshness 时钟（硬约束）**：`signingClock` 只决定签名 / 请求时间，**绝不能**复用或驱动 `receivedAt` / freshness 的 `now()`（上一类仍要求本地时钟、不信任交易所时钟）。两者必须独立可覆盖，使未来接时钟敏感 venue 的 server-time 校准只作用于签名、**不污染** §3.8 freshness 契约。当前仅抽 `TimeProvider` 接口 + 默认本地时钟，**不含 server-time 校准**（留待 step 5）。共享 HTTP 客户端不公共可替换，`clock` 是签名时间的唯一公共注入位。

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
  - 通用核（`SubscriptionMultiplexer`）：按 `connectionKey` 池化物理连接、引用计数、重连后重放订阅、控制帧批量+限速、per-subscription ready/stale、最后一个订阅关闭时拆连接、单连接订阅数达上限时同 `connectionKey` 开新连接（连接池）。
  - venue 策略（`VenueStreamProtocol`）：`subscriptionKey` / `connectionKey` / `connectionUrl` / `parseMessage` / `encodeSubscribe` / `encodeUnsubscribe` / `routeMessage(→ data|ack|ignore)`。所有交易所特定的 base URL、帧格式、消息路由判据都在这里，**不得**泄漏进通用核。
- **logical stream 契约**：
  - `ready`：该订阅首条 `routeMessage` 判定为 `data` 的消息到达时 resolve；超 `initialMessageTimeoutMs` 未到则 reject 并清理该订阅。ack 帧不算 ready。
  - `close()`：发出该订阅的 `UNSUBSCRIBE`；物理连接保持，直到其上最后一个订阅 close 才断开。幂等。
  - per-subscription stale：单个 symbol 静默超 `staleAfterMs` 即对该订阅 `onFreshnessChange("stale","heartbeat_timeout")`，不依赖连接级 watchdog（连接级 watchdog 仅用于整条连接长时间无任何消息）。
  - 断线：对该连接所有订阅 `onDisconnected()`（上层据此置 `ws_disconnected`），并**静默**置内部 freshness=stale（不再额外发 `heartbeat_timeout` freshness 事件）；重连 `open` 后自动重放全部活跃订阅，各订阅在各自首条消息回到 `fresh`。
- **限额（保守口径，依据 Binance 官方）**：
  - 单连接 stream 上限：Binance 现货与 USDⓈ-M 合约**均为 1024**（Options 才是 200，不适用）。本仓库 `maxSubscriptionsPerConnection` 取保守值 **200**，到上限即开新连接。200 不是交易所硬限制，而是运营上限：平衡控制帧开销、per-subscription heartbeat/control 消息、路由与 fan-out 的 CPU/内存成本、高订阅数下的延迟/丢包观测、连接稳定性与重连限额，以及突发订阅的安全余量。后续可依据 `tests/soak/`（尤其 market L1 continuity）与线上 telemetry/packet-loss/latency 指标重新调优。
  - 控制帧速率：现货 **5/秒**、USDⓈ-M 合约 **10/秒**。本仓库 `controlFrameMaxPerSec` 取较严的 **5/秒**，对两者都安全。
  - IP 维度：每 5 分钟最多 300 次连接尝试（连接池化天然降低连接数）。

### 4. Validation & Error Matrix

| 场景 | 正确做法 | 禁止做法 |
|---|---|---|
| 首条消息超时 | `ready` reject 并自动 close | 超时后继续挂着等下一条 |
| `close()` 被外部调用两次 | 第二次 no-op | 抛 `ClosedError` 或重复清 timer |
| 稳态时 WS 被对端关闭 | 触发 `onDisconnected` + 内部触发 ManagedWebSocket 重连 | 让 adapter 自行 `setTimeout` 重连 |
| 长时间不收消息 | `onFreshnessChange("stale", "heartbeat_timeout")` | 主动 close 重连（让 ManagedWebSocket watchdog 决定） |
| 对端推送未知 event 字段 | 跳过，不触发任何回调 | `throw` 或者 `onError` |
| 交易命令 REST 返回非 2xx | 异步 `throw`，带交易所原始 message | 吞掉返回 `undefined` |
| listenKey 过期前未续期 | adapter 内部重续 | 等待失败后靠 reconnect 恢复 |
| 新数据类型只覆盖一家交易所 | 先在 `adapters/types.ts` 加 `Raw*`，再在具体 adapter 实现 | 只在具体 adapter 加字段 |
| WS 不推送 mark-to-market risk | 实现 `refreshAccount()` 并由 coordinator polling 校准 | 假设 `ACCOUNT_UPDATE` 会定时推送 risk |
| 新增实时账户字段 | 核对交易所 WS 推送触发条件；必要时加 polling/refresh 和 stale 语义 | 看到 WS payload 字段就认为它会随行情实时推送 |
| REST refresh 在 WS 断线期间成功 | 保留 stream status，直到 WS reconnect/reconcile 成功 | 把 account status 改回 `healthy` |

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

- 在 `.trellis/spec/backend/index.md` 或 README 明确标注该交易所仅支持行情
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
- `tests/integration/market.test.ts`、`tests/integration/account.test.ts`、`tests/integration/order.test.ts` 针对各 manager 的集成测试仍然过——这些测试通过 fake REST / fake WebSocket 间接验证 adapter contract。
- 修改 `refreshAccount()` 或 account polling 时，必须覆盖 REST refresh 后 `risk.updated` 与 `position.updated` 都通过 public event/getter 可见。
- 新增随行情变化的账户字段时，测试必须覆盖“没有 WS 消息、只有 refresh/polling”时字段仍会更新；同时覆盖 WS 断线期间 refresh 成功不会把 stream status 改成 healthy。
- 必须覆盖 WS disconnected + REST refresh succeeded 的回归：snapshot 可更新，但 account status 仍是 `reconnecting` / `ws_disconnected`。
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
createL1BookStream(market, callbacks): StreamHandle {
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
- `ready` 在首条消息前就已 resolve，破坏了 ready-barrier 语义

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
- `ready` 在首条消息到达时才 resolve，ready-barrier 语义一致
- freshness / reconnect / watchdog 行为与其他 adapter 完全一致

> 注：上例是**单条流**（如私有 account 流）的标准写法。**行情流**改走 `SubscriptionMultiplexer`（§3.10）以复用物理连接：复用器内部同样只用 `createManagedWebSocket`，但 ready/stale 改为 per-subscription，订阅/退订走 JSON 控制帧，重连后自动重放。adapter 侧只需实现 `VenueStreamProtocol` 策略，不要自己持有多条 per-symbol 连接。

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
- `httpRequest` 是 REST 侧的 `createManagedWebSocket` 对位物：venue 注入 URL / signing / headers / 文案，client 不含任何交易所特定逻辑。**限流（消费 `Retry-After` / `rate_limited` 主动退避）与统一 time provider 不在本契约**——分别留给 PR3 / PR2，本骨架只做分类与透传，不 sleep、不限流。

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
  readonly retryAfterMs?: number;                  // 已解析的 Retry-After（PR3 才消费）
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
SAFE_READ_RETRY_POLICY            idempotent:true,  maxAttempts:3   只读 GET（account / positionRisk / openOrders…）
NO_RETRY_POLICY                   idempotent:false, maxAttempts:1   createOrder / cancelOrder / cancelAllOrders + 签名请求默认
LISTEN_KEY_KEEPALIVE_RETRY_POLICY idempotent:true,  maxAttempts:3   listenKey PUT keepalive
// catalog / juplend 只读 GET：inline { idempotent:true, maxAttempts:3 }
```

### 3. Contracts

#### 3.11 venue 注入，client venue-agnostic

- URL 拼装、签名（`timestamp` / `recvWindow` / `signature` / `X-MBX-APIKEY`）、headers、错误文案全部由 adapter 注入；`http-client.ts` 不得出现任何交易所特定字符串或分支。
- 签名等敏感串只存在于传入的 `url` / `headers` / `body`；client 只负责发送与**脱敏后**透传。

#### 3.12 per-call 幂等 = 调用点显式声明

- 重试性由**调用点**通过 `retryPolicy.idempotent` 显式声明，不由 client 猜 HTTP 方法。`idempotent:false` ⇒ 任何 kind 都不重试（见 `retryableForKind`）。
- 写操作（下单 / 撤单 / 任何 POST·DELETE 副作用请求）**必须** `NO_RETRY_POLICY`；只读 GET 用 `SAFE_READ`；listenKey keepalive 用受限重试策略。
- 即便 `idempotent:true`，可重试的 kind 也只有 `network` / `timeout` / `http(5xx)`；`rate_limited` / `http(4xx)` / `parse` 一律 `retryable:false`。

#### 3.13 抛 typed `TransportError`，不构造 `AcexError`

- client 与所有 internal/adapter 代码**只抛 `TransportError`**，承接 §3.6「adapter 不得自己构造 `AcexError`」。错误码归 manager / runtime（`src/errors.ts`）。
- 消费方用 `isTransportError(e)` 做 narrowing，**不要 `instanceof`**（跨 bundle 不可靠，故有 `isAcexTransportError` 鸭子标记）。

#### 3.14 错误脱敏契约（D5，安全关键）

- 对外可见的 `TransportError.message` / `TransportError.url` / `TransportError.rawBody`**都不得包含**签名或密钥：`signature`、`api[_-]?key` / `key`、`secret`、`token` / `access_token`、`listen[_-]?key`、`passphrase`。
- 实现保证：
  - URL 含 `signature` ⇒ 整段 query 折叠为 `?query=[REDACTED]`；含其它敏感 query key ⇒ 该值 `[REDACTED]`（`redactUrl`）。
  - 非 2xx 与 parse 失败的 `rawBody` 在抛出点先过 `redactSecrets`（URL / `key=value` / `"key":"value"` 三种形态，并把 `signature` 键名改写为 `redacted` 以免键名本身泄漏语义）。
  - `buildAttemptError` 传给 venue `messages` 回调的 `HttpErrorMessageInput` 中，`url` 已是 redactedUrl、`rawBody` 已脱敏——**venue 自定义文案也无法泄漏**，无需各 adapter 重复脱敏。
- 私有订阅 bootstrap 失败路径（`PrivateSubscriptionCoordinator`）把透传进 public `AcexError` 的 message 再过一次 `redactSecrets`（`bootstrapErrorDetail`）。

#### 3.15 rate_limited 分类（PR1 只分类，不退避）

- `429` / `418` ⇒ `kind:"rate_limited"`，并用 `parseRetryAfterMs` 解析 `Retry-After`（支持秒数与 HTTP-date）存入 `retryAfterMs`；但 `retryable:false`，PR1 **不重试、不 sleep**。
- 主动消费 `retryAfterMs` 做退避 / 全局限流是 **PR3** 的范畴，禁止在本骨架里 sleep。

#### 3.16 body 解析与 empty body

- `parseAs:"json"` 默认走 text→`JSON.parse`，解析失败 ⇒ `kind:"parse"`、`retryable:false`、`rawBody` 脱敏后保留。
- `emptyBody:"empty_object"` 把空响应体解析成 `{}`（Binance 部分签名端点返回空 body 时保持原语义）；默认 `undefined`。

### 4. Validation & Error Matrix

| 场景 | `kind` | `retryable`（`idempotent:true` 时） | 备注 |
|---|---|---|---|
| `429` / `418` | `rate_limited` | **false** | 解析 `retryAfterMs`，但不重试不 sleep（PR3） |
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

只读 catalog / polling 用 `{ idempotent:true, maxAttempts:3 }`：网络抖动可重试，但 4xx/限流立即失败，文案复刻迁移前的原始格式（如 `BINANCE_CATALOG_HTTP_MESSAGES.http` 复刻 `Binance request failed: <status> <statusText>`），保证迁移等价。

#### Bad

```ts
// ❌ 绕过 client 直接 fetch：签名进日志、无 timeout、无分类
const res = await fetch(signedUrl);
if (!res.ok) throw new AcexError("ORDER_CREATE_FAILED", await res.text()); // 双重违约

// ❌ 下单用可重试策略：网络抖动下重复下单
retryPolicy: SAFE_READ_RETRY_POLICY, // 写操作严禁
```

问题：泄漏签名、可能重复下单、在 internal/adapter 层构造 `AcexError`（违反 §3.6 / §3.13）。

### 6. Tests Required

- `tests/unit/http-client.test.ts` 必须覆盖的断言点：
  - json / text / empty(`empty_object`→`{}`) 三种 body 解析 + headers 透传。
  - 非 2xx：`isTransportError` 为真、`kind:"rate_limited"`、`status:429`、`retryAfterMs` 解析正确、`retryable:false`；**且 `message`/`url`/`rawBody` 均不含签名密钥、含 `[REDACTED]`**（脱敏是安全关键，必须钉死 rawBody 也被脱敏，而不仅是 url/message）。
  - parse 失败 ⇒ `kind:"parse"`、`retryable:false`。
  - timeout / upstream abort / network 三者区分，且 `idempotent:false` 时不重试。
- adapter 迁移到共享 client 时，必须提供**等价矩阵**：逐 REST 端点列出迁移前后的 method / 重试语义 / 错误 message 文案，标注 intended diff（如脱敏带来的 message 变化），其余必须保持等价。
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
