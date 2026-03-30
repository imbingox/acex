# 多交易所 SDK MVP 对外 API 文档

> 本文档只定义 MVP 阶段对外承诺的公开接口、关键语义和开发边界。
> `ExchangeAdapter`、恢复编排、能力矩阵、验收清单等内部实现细节已迁移到 [sdk-internal-design.md](./sdk-internal-design.md)。

## 1. 文档定位

本文档回答 4 个问题：

1. SDK 对外暴露哪些对象和方法。
2. 这些方法在 MVP 中承诺什么语义。
3. 调用方如何判断数据是否可用、请求是否成功、状态是否降级。
4. MVP 明确支持什么，不支持什么。

不在本文档展开的内容：

| 主题 | 去向 |
|---|---|
| REST + WS 的内部编排细节 | [sdk-internal-design.md](./sdk-internal-design.md) |
| `ExchangeAdapter` 合同与 `capabilities` | [sdk-internal-design.md](./sdk-internal-design.md) |
| reconnect / reconcile 时序与状态机 | [sdk-internal-design.md](./sdk-internal-design.md) |
| adapter 验收标准与扩展路线 | [sdk-internal-design.md](./sdk-internal-design.md) |

## 2. MVP 范围

MVP 聚焦于“能被策略应用稳定接入”的最小闭环：

| 模块 | MVP 承诺 |
|---|---|
| `AcexClient` | 创建、启动、停止、账户注册、聚合健康状态、全局错误通道 |
| `MarketManager` | L1 / funding 订阅、最新快照读取、market freshness 查询与事件 |
| `AccountManager` | 余额、仓位、风险快照读取；账户状态事件；ready barrier |
| `OrderManager` | 下单、撤单、批量撤单、改单、订单快照、订单事件、ready barrier |
| 错误模型 | 统一 `AcexError`、结果未知语义、能力不足语义 |
| 恢复语义 | market `stale`、private `degraded`、恢复后以最新可信投影为准 |

MVP 不承诺：

| 非目标 | 说明 |
|---|---|
| 分布式状态同步 | 初期按单进程内存态 SDK 设计 |
| 跨进程幂等与去重持久化 | 首版只保证单个 client 生命周期内语义 |
| 所有交易所能力完全一致 | 通过错误码和健康状态显式暴露差异 |
| 细粒度内部调度策略 | 如多账户并发恢复、底层退避细节等，属于内部实现 |

## 3. 设计原则

| 原则 | 说明 |
|---|---|
| 统一入口 | 应用只与 `AcexClient` 和三类 manager 交互 |
| 最新状态优先 | 查询返回当前最新快照；变化感知通过事件流完成 |
| 读写分离 | 查询走快照，命令走显式方法，状态变化走事件 |
| 显式降级 | `stale` / `degraded` / `reconciling` 必须通过状态接口暴露 |
| 对外稳定，对内可替换 | public API 尽量稳定，底层接入可从 CCXT 演进到 native adapter |

## 4. Client 与核心标识

### 4.1 核心对象

```ts
export type ClientStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

export interface MarketFreshnessPolicy {
  heartbeatTimeoutMs: number;
  staleAfterMs: number;
  reconcileTimeoutMs: number;
}

export interface ReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  maxRetries?: number;
}

export interface RateLimitPolicy {
  maxRequestsPerSecond: number;
  maxOrdersPerMinute?: number;
}

export interface CreateClientOptions {
  logger?: Logger;
  logLevel?: LogLevel;
  sandbox?: boolean;
  marketFreshness?: Partial<Record<Exchange, MarketFreshnessPolicy>>;
  reconnect?: Partial<ReconnectPolicy>;
  rateLimiting?: Partial<Record<Exchange, RateLimitPolicy>>;
}

export interface RegisterAccountResult {
  accountId: string;
  exchange: Exchange;
}

export interface StopOptions {
  graceful?: boolean;
  timeoutMs?: number;
}

export interface AcexInternalError {
  source: 'adapter' | 'manager' | 'reconcile' | 'runtime';
  exchange?: Exchange;
  accountId?: string;
  error: Error;
  ts: number;
}

export interface AcexClient {
  readonly market: MarketManager;
  readonly account: AccountManager;
  readonly order: OrderManager;

  getStatus(): ClientStatus;
  getHealth(): ClientHealthSnapshot;
  registerAccount(input: RegisterAccountInput): Promise<RegisterAccountResult>;
  removeAccount(accountId: string): Promise<void>;
  start(): Promise<void>;
  stop(options?: StopOptions): Promise<void>;
  watchHealth(filter?: HealthEventFilter): AsyncIterable<HealthEvent>;
  watchErrors(): AsyncIterable<AcexInternalError>;
}

export declare function createClient(options?: CreateClientOptions): AcexClient;
```

### 4.2 标识约束

```ts
export const SUPPORTED_EXCHANGES = ['binance', 'okx', 'bybit', 'gate'] as const;

export type Exchange = (typeof SUPPORTED_EXCHANGES)[number];

export interface RegisterAccountInput {
  accountId: string;
  exchange: Exchange;
  credentials: {
    apiKey: string;
    secret: string;
    password?: string;
  };
  options?: Record<string, unknown>;
}
```

约束：

| 主题 | 约定 |
|---|---|
| `accountId` | 在单个 `AcexClient` 实例内全局唯一 |
| 账户查询 | 基于 `accountId` 的账户查询默认不再要求重复传 `exchange` |
| `exchange` | `OrderManager` 命令中保留，用于显式交叉校验和审计 |
| `symbol` | 直接沿用 CCXT unified symbol，例如 `BTC/USDT`、`BTC/USDT:USDT` |
| 交易所实例 | MVP 不额外引入 `instanceId` 层 |

如果调用方传入的 `exchange` 与 `accountId` 绑定的交易所不一致，SDK 必须直接返回 `VALIDATION_ERROR`。

## 5. 共享契约

### 5.1 数值、时间与状态

```ts
export type MarketFreshness = 'fresh' | 'stale' | 'reconciling';

export type PrivateDataStatus =
  | 'bootstrap_pending'
  | 'healthy'
  | 'degraded'
  | 'reconnecting'
  | 'reconciling'
  | 'stopped';

export interface MarketDataStatus {
  exchange: Exchange;
  symbol: string;
  freshness: MarketFreshness;
  lastStreamReceivedAt?: number;
  lastBaselineSyncAt?: number;
  staleSince?: number;
  reason?:
    | 'bootstrap_pending'
    | 'ws_disconnected'
    | 'heartbeat_timeout'
    | 'sequence_gap'
    | 'reconciling';
}

export interface AccountDataStatus {
  accountId: string;
  exchange: Exchange;
  status: PrivateDataStatus;
  bootstrapCompleted: boolean;
  lastStreamReceivedAt?: number;
  lastBaselineSyncAt?: number;
  degradedSince?: number;
  reason?:
    | 'bootstrap_pending'
    | 'ws_disconnected'
    | 'heartbeat_timeout'
    | 'sequence_gap'
    | 'auth_failed'
    | 'reconciling';
}

export interface OrderDataStatus {
  accountId: string;
  exchange: Exchange;
  status: PrivateDataStatus;
  bootstrapCompleted: boolean;
  lastStreamReceivedAt?: number;
  lastBaselineSyncAt?: number;
  unresolvedOrdersCount?: number;
  degradedSince?: number;
  reason?:
    | 'bootstrap_pending'
    | 'ws_disconnected'
    | 'heartbeat_timeout'
    | 'sequence_gap'
    | 'auth_failed'
    | 'reconciling';
}
```

共享字段语义：

| 字段 | 约定 |
|---|---|
| 金额、价格、数量 | 统一使用 decimal string，不在 public API 中暴露 JS `number` |
| `exchangeTs` | 交易所原始事件时间或快照时间；若上游未提供稳定时间，允许缺省 |
| `receivedAt` | adapter 在本地接收到该事件或快照的时间 |
| `updatedAt` | SDK 本地最后一次写入该快照的时间 |
| status 中的 `lastStreamReceivedAt` | 最近一次流式事件被 SDK 收到的本地时间 |
| status 中的 `lastBaselineSyncAt` | 最近一次可信基线同步完成时间，包含首次 bootstrap 和后续 reconcile；不表示任意 REST 请求时间 |
| 控制面事件的 `ts` | SDK 产出该状态、健康或内部错误事件的时间 |
| `version` | 仅在单个 market key 内单调递增 |
| `seq` | 仅在单个 `accountId` 内单调递增；账户事件和订单事件分别维护 |

### 5.2 健康状态与控制面事件

```ts
export type AdapterHealthStatus =
  | 'idle'
  | 'healthy'
  | 'degraded'
  | 'reconnecting'
  | 'reconciling'
  | 'stopped';

export interface AdapterHealth {
  exchange: Exchange;
  status: AdapterHealthStatus;
  wsConnected: boolean;
  lastHeartbeatAt?: number;
  lastDisconnectAt?: number;
  reason?: string;
}

export interface AdapterHealthChangedEvent {
  type: 'adapter.health_changed';
  exchange: Exchange;
  health: AdapterHealth;
  ts: number;
}

export interface AccountStatusChangedEvent {
  type: 'account.status_changed';
  accountId: string;
  exchange: Exchange;
  status: AccountDataStatus;
  ts: number;
}

export interface OrderStatusChangedEvent {
  type: 'order.status_changed';
  accountId: string;
  exchange: Exchange;
  status: OrderDataStatus;
  ts: number;
}

export type HealthEvent =
  | AdapterHealthChangedEvent
  | AccountStatusChangedEvent
  | OrderStatusChangedEvent;

export interface HealthEventFilter {
  exchange?: Exchange;
  accountId?: string;
  scope?: 'exchange' | 'account' | 'order';
}

export interface ClientHealthSnapshot {
  clientStatus: ClientStatus;
  exchanges: Partial<Record<Exchange, AdapterHealth>>;
  accounts: Record<string, AccountDataStatus>;
  orders: Record<string, OrderDataStatus>;
  updatedAt: number;
}
```

### 5.3 调用约定

| 调用 | MVP 约定 |
|---|---|
| `createClient()` | 只创建对象，不主动建立网络连接 |
| `start()` | 幂等；启动 runtime 和已注册账户的私有同步 |
| `registerAccount()` | 校验 credentials 格式并登记账户；运行态下立即触发该账户初始化 |
| `removeAccount()` | 释放账户相关私有链路、订阅和内存中 credentials 引用 |
| `subscribeL1Book()` / `subscribeFundingRate()` | 幂等；`Promise` resolve 表示订阅关系已建立，不保证首个快照已到达 |
| `subscribeAccount()` | 幂等；`Promise` resolve 表示该账户完整账户投影的首次 bootstrap 已完成 |
| `subscribeOrders()` | 幂等；`Promise` resolve 表示当前 open orders baseline 已完成首次 bootstrap |
| `watch*()` | 每次调用返回独立 `AsyncIterable` consumer；退出循环即释放 consumer |
| `stop()` | 幂等；默认 graceful 停止，结束底层连接与事件迭代器 |

补充约束：

| 主题 | 约定 |
|---|---|
| `start()` 之前调用 `subscribe*()` 或命令方法 | reject `TRANSPORT_UNAVAILABLE` |
| `watchHealth()` | 只承载控制面状态切换，不承载业务快照 |
| `watchErrors()` | 暴露后台 reconcile、reconnect、adapter 异常等内部错误 |
| `stop()` 之后读取快照 | 允许读取最后一次成功同步的快照，但不再保证 freshness |

## 6. `MarketManager`

### 6.1 语义

`MarketManager` 提供 market 最新态缓存和变化通知。事件主要用于“唤醒调用方去读取最新快照”，而不是承诺消费方收到每一个中间市场变化。

### 6.2 接口

```ts
export interface MarketEventFilter {
  exchange?: Exchange;
  symbol?: string;
}

export interface SubscribeL1BookInput {
  exchange: Exchange;
  symbol: string;
}

export interface SubscribeFundingRateInput {
  exchange: Exchange;
  symbol: string;
}

export interface MarketKeyInput {
  exchange: Exchange;
  symbol: string;
}

export interface MarketManager {
  subscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  unsubscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;
  unsubscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;

  getL1Book(key: MarketKeyInput): L1Book | undefined;
  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined;
  getMarketSnapshot(key: MarketKeyInput): MarketSnapshot | undefined;
  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined;
  getMarketInfo(key: MarketKeyInput): MarketInfo | undefined;
  getAvailableMarkets(exchange: Exchange): MarketInfo[];

  watchL1BookUpdates(filter?: MarketEventFilter): AsyncIterable<L1BookUpdatedEvent>;
  watchFundingRateUpdates(filter?: MarketEventFilter): AsyncIterable<FundingRateUpdatedEvent>;
  watchMarketEvents(filter?: MarketEventFilter): AsyncIterable<MarketEvent>;
  watchMarketStatus(filter?: MarketEventFilter): AsyncIterable<MarketStatusChangedEvent>;
}
```

### 6.3 数据结构

```ts
export interface L1Book {
  exchange: Exchange;
  symbol: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
}

export interface FundingRateSnapshot {
  exchange: Exchange;
  symbol: string;
  fundingRate: string;
  nextFundingTime?: number;
  markPrice?: string;
  indexPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  version: number;
}

export interface MarketSnapshot {
  l1Book?: L1Book;
  fundingRate?: FundingRateSnapshot;
}

export interface MarketInfo {
  exchange: Exchange;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  marketType: 'spot' | 'swap' | 'future' | 'option';
  pricePrecision: number;
  amountPrecision: number;
  minAmount?: string;
  maxAmount?: string;
  minPrice?: string;
  maxPrice?: string;
  minNotional?: string;
  contractSize?: string;
  active: boolean;
}
```

### 6.4 事件

```ts
export interface L1BookUpdatedEvent {
  type: 'l1_book.updated';
  exchange: Exchange;
  symbol: string;
  exchangeTs?: number;
  receivedAt: number;
  version: number;
}

export interface FundingRateUpdatedEvent {
  type: 'funding_rate.updated';
  exchange: Exchange;
  symbol: string;
  exchangeTs?: number;
  receivedAt: number;
  version: number;
}

export interface MarketStatusChangedEvent {
  type: 'market.status_changed';
  exchange: Exchange;
  symbol: string;
  status: MarketDataStatus;
  ts: number;
}

export type MarketEvent =
  | L1BookUpdatedEvent
  | FundingRateUpdatedEvent
  | MarketStatusChangedEvent;
```

### 6.5 公开语义

| 主题 | 约定 |
|---|---|
| 最新态读取 | `getL1Book()` / `getFundingRate()` 返回当前最后快照 |
| freshness 判断 | 以 `getMarketStatus()` 为准，不要求应用自己比较时间戳 |
| `fresh` | 可以作为交易用最新状态 |
| `stale` | 仍可读取最后快照，但不建议继续用于主动交易决策 |
| `reconciling` | SDK 正在恢复 market 可信状态 |
| 事件合并 | 允许；`version` 跳号是合法行为 |

## 7. `AccountManager`

### 7.1 接口

```ts
export interface AccountEventFilter {
  accountId?: string;
  exchange?: Exchange;
  symbol?: string;
}

export interface PositionKeyInput {
  accountId: string;
  symbol: string;
}

export interface SubscribeAccountInput {
  accountId: string;
}

export interface AccountManager {
  subscribeAccount(input: SubscribeAccountInput): Promise<void>;
  unsubscribeAccount(accountId: string): Promise<void>;

  getBalance(accountId: string, asset: string): BalanceSnapshot | undefined;
  getBalances(accountId: string): BalanceSnapshot[];
  getPosition(input: PositionKeyInput): PositionSnapshot | undefined;
  getPositions(accountId: string): PositionSnapshot[];
  getAccountSnapshot(accountId: string): AccountSnapshot | undefined;
  getAccountStatus(accountId: string): AccountDataStatus | undefined;
  getRiskSnapshot(accountId: string): RiskSnapshot | undefined;

  watchAccountEvents(filter?: AccountEventFilter): AsyncIterable<AccountEvent>;
  watchAccountStatus(filter?: AccountEventFilter): AsyncIterable<AccountStatusChangedEvent>;
}
```

### 7.2 数据结构

```ts
export type PositionSide = 'long' | 'short' | 'net';

export interface BalanceSnapshot {
  accountId: string;
  exchange: Exchange;
  asset: string;
  free: string;
  used: string;
  total: string;
  seq: number;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}

export interface PositionSnapshot {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  side: PositionSide;
  size: string;
  leverage?: string;
  entryPrice?: string;
  markPrice?: string;
  unrealizedPnl?: string;
  liquidationPrice?: string;
  seq: number;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}

export interface RiskSnapshot {
  accountId: string;
  exchange: Exchange;
  equity?: string;
  marginRatio?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  seq: number;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}

export interface AccountSnapshot {
  accountId: string;
  exchange: Exchange;
  balances: Record<string, BalanceSnapshot>;
  positions: PositionSnapshot[];
  risk?: RiskSnapshot;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}
```

### 7.3 事件

```ts
export interface AccountEventBase {
  seq: number;
  accountId: string;
  exchange: Exchange;
  exchangeTs?: number;
  receivedAt: number;
  source: 'rest-bootstrap' | 'private-stream' | 'reconcile';
}

export interface BalanceUpdatedEvent extends AccountEventBase {
  type: 'balance.updated';
  asset: string;
  snapshot: BalanceSnapshot;
}

export interface PositionUpdatedEvent extends AccountEventBase {
  type: 'position.updated';
  symbol: string;
  snapshot: PositionSnapshot;
}

export interface RiskUpdatedEvent extends AccountEventBase {
  type: 'risk.updated';
  snapshot: RiskSnapshot;
}

export interface AccountSnapshotReplacedEvent extends AccountEventBase {
  type: 'account.snapshot_replaced';
  snapshot: AccountSnapshot;
}

export type AccountEvent =
  | BalanceUpdatedEvent
  | PositionUpdatedEvent
  | RiskUpdatedEvent
  | AccountSnapshotReplacedEvent;
```

### 7.4 公开语义

| 主题 | 约定 |
|---|---|
| MVP 订阅粒度 | `subscribeAccount()` 按 `accountId` 维护完整账户投影，包含 balances / positions / risk，不支持 partial scope |
| 顺序范围 | 只保证单个 `accountId` 内有序 |
| MVP 风控能力 | 当前 MVP 目标交易所必须提供 risk snapshot；`balances` / `positions` / `risk` 三者都完成 baseline 后，`subscribeAccount()` 才能 resolve |
| ready barrier | `subscribeAccount()` resolve 后，可把 `getAccountSnapshot()` 视为已初始化投影 |
| 权威判断 | `getAccountStatus()` 是账户快照是否仍可驱动风控的权威判断 |
| `getRiskSnapshot()` | 对于已完成 bootstrap 且 `healthy` 的当前 MVP 合约账户，不应返回 `undefined` |
| `source: 'reconcile'` | 表示 SDK 在恢复或校验后修正了本地账户投影 |

## 8. `OrderManager`

### 8.1 接口

```ts
export interface OrderEventFilter {
  accountId?: string;
  exchange?: Exchange;
  symbol?: string;
  clientOrderId?: string;
  orderId?: string;
}

export type OrderLocator =
  | { orderId: string; clientOrderId?: string }
  | { orderId?: string; clientOrderId: string };

export type OrderIdentifier = {
  accountId: string;
  exchange: Exchange;
  symbol?: string;
} & OrderLocator;

export type GetOrderInput = {
  accountId: string;
  exchange: Exchange;
  symbol?: string;
} & OrderLocator;

export interface SubscribeOrdersInput {
  accountId: string;
}

export type OrderType = 'limit' | 'market' | 'stop' | 'stop_market';
export type TriggerPriceSource = 'last_price' | 'mark_price' | 'index_price';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY';

export interface OrderCommandBase {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  side: 'buy' | 'sell';
  amount: string;
  clientOrderId: string;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
  params?: Record<string, unknown>;
}

export interface LimitOrderInput extends OrderCommandBase {
  type: 'limit';
  price: string;
  timeInForce?: TimeInForce;
}

export interface MarketOrderInput extends OrderCommandBase {
  type: 'market';
  timeInForce?: Extract<TimeInForce, 'IOC' | 'FOK'>;
}

export interface StopLimitOrderInput extends OrderCommandBase {
  type: 'stop';
  price: string;
  triggerPrice: string;
  triggerBy?: TriggerPriceSource;
  timeInForce?: TimeInForce;
}

export interface StopMarketOrderInput extends OrderCommandBase {
  type: 'stop_market';
  triggerPrice: string;
  triggerBy?: TriggerPriceSource;
}

export type PlaceOrderInput =
  | LimitOrderInput
  | MarketOrderInput
  | StopLimitOrderInput
  | StopMarketOrderInput;

export interface CancelOrderInput extends OrderIdentifier {}

export interface CancelAllOrdersInput {
  accountId: string;
  exchange: Exchange;
  symbol?: string;
}

export interface AmendOrderInput extends OrderIdentifier {
  newPrice?: string;
  newAmount?: string;
  newTriggerPrice?: string;
  params?: Record<string, unknown>;
}

export interface PlaceOrderAck {
  requestId: string;
  accountId: string;
  exchange: Exchange;
  symbol: string;
  orderId?: string;
  clientOrderId: string;
  submittedAt: number;
}

export interface AmendOrderAck {
  requestId: string;
  accountId: string;
  exchange: Exchange;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
  submittedAt: number;
}

export interface CancelOrderAck {
  requestId: string;
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  submittedAt: number;
}

export interface CancelAllOrdersResult {
  accountId: string;
  exchange: Exchange;
  symbol?: string;
  canceledCount?: number;
}

export interface OrderManager {
  subscribeOrders(input: SubscribeOrdersInput): Promise<void>;
  unsubscribeOrders(accountId: string): Promise<void>;

  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderAck>;
  cancelOrder(input: CancelOrderInput): Promise<CancelOrderAck>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<CancelAllOrdersResult>;
  amendOrder(input: AmendOrderInput): Promise<AmendOrderAck>;

  getOrder(input: GetOrderInput): OrderSnapshot | undefined;
  getOpenOrders(accountId: string, symbol?: string): OrderSnapshot[];
  getOrderStatus(accountId: string): OrderDataStatus | undefined;

  watchOrderEvents(filter?: OrderEventFilter): AsyncIterable<OrderEvent>;
  watchOrderStatus(filter?: OrderEventFilter): AsyncIterable<OrderStatusChangedEvent>;
}
```

### 8.2 数据结构

```ts
export interface FillDetail {
  fillId: string;
  tradeId?: string;
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  fee?: string;
  feeCurrency?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface OrderSnapshot {
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: OrderType;
  status:
    | 'created'
    | 'submitted'
    | 'open'
    | 'partially_filled'
    | 'filled'
    | 'canceled'
    | 'rejected'
    | 'expired';
  price?: string;
  triggerPrice?: string;
  triggerBy?: TriggerPriceSource;
  amount: string;
  filled: string;
  remaining?: string;
  positionSide?: PositionSide;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
  avgFillPrice?: string;
  totalFee?: string;
  feeCurrency?: string;
  seq: number;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
}
```

### 8.3 事件

```ts
export interface OrderEventBase {
  seq: number;
  accountId: string;
  exchange: Exchange;
  exchangeTs?: number;
  receivedAt: number;
  source: 'command' | 'rest-bootstrap' | 'private-stream' | 'reconcile';
}

export interface OrderUpdatedEvent extends OrderEventBase {
  type: 'order.updated';
  snapshot: OrderSnapshot;
}

export interface OrderFilledEvent extends OrderEventBase {
  type: 'order.filled';
  snapshot: OrderSnapshot;
  fill: FillDetail;
}

export interface OrderCanceledEvent extends OrderEventBase {
  type: 'order.canceled';
  reason?: string;
  snapshot: OrderSnapshot;
}

export interface OrderExpiredEvent extends OrderEventBase {
  type: 'order.expired';
  snapshot: OrderSnapshot;
}

export interface OrderRejectedEvent extends OrderEventBase {
  type: 'order.rejected';
  reason?: string;
  snapshot: OrderSnapshot;
}

export type OrderEvent =
  | OrderUpdatedEvent
  | OrderFilledEvent
  | OrderCanceledEvent
  | OrderExpiredEvent
  | OrderRejectedEvent;
```

### 8.4 公开语义

| 主题 | 约定 |
|---|---|
| MVP 订阅粒度 | `subscribeOrders()` 按 `accountId` 维护完整订单投影；恢复期所需 recent trades 由 SDK 内部处理，不通过订阅参数暴露 |
| ready barrier | `subscribeOrders()` resolve 后，可把 `getOpenOrders()` 视为已初始化的 open orders 权威基线 |
| 恢复游标 | 订单恢复使用 SDK 内部维护的交易所侧成交时间游标和安全回看窗口；不使用本地接收时间直接查询交易所 trades |
| 恢复职责划分 | 当前 open orders 基线与断线期间 recent trades 回补是两步独立内部流程，不混成单一 baseline contract |
| 命令 ack | 只表示请求已被 SDK / 交易所初步接受，不代表最终成交或最终终态 |
| 最终状态来源 | 以 `watchOrderEvents()` 或 `getOrder()` 读取的最新 `OrderSnapshot` 为准 |
| `getOrderStatus()` | 判断订单投影是否仍可作为执行决策输入 |
| `clientOrderId` | 建议业务方稳定生成，并在 `accountId + exchange` 维度内保持唯一 |
| 结果未知 | 请求已发出但无法确认交易所是否受理时，reject `REQUEST_OUTCOME_UNKNOWN` |
| `degraded` 下命令 | 允许提交，但本地订单投影可能需要等待恢复后才重新可信 |
| 成交去重 | `order.filled` 在单个 client 生命周期内按 `fillId` 去重 |

## 9. 错误模型

```ts
export type AcexErrorCode =
  | 'VALIDATION_ERROR'
  | 'EXCHANGE_NOT_SUPPORTED'
  | 'ACCOUNT_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'TRANSPORT_UNAVAILABLE'
  | 'ORDER_REJECTED'
  | 'INSUFFICIENT_BALANCE'
  | 'REQUEST_OUTCOME_UNKNOWN'
  | 'ORDER_STATE_UNKNOWN'
  | 'EVENT_CONSUMER_OVERFLOW'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'INTERNAL_ERROR';

export interface AcexError extends Error {
  readonly code: AcexErrorCode;
  readonly retryable: boolean;
  readonly exchange?: Exchange;
  readonly accountId?: string;
  readonly requestId?: string;
  readonly clientOrderId?: string;
  readonly orderId?: string;
  readonly cause?: unknown;
}
```

关键失败语义：

| 场景 | 对外语义 |
|---|---|
| 参数非法、账户不存在、交易所不支持 | 直接 reject `AcexError` |
| 鉴权失败、限速、短时网络不可用 | reject `AcexError`，由 `retryable` 提示是否建议重试 |
| 下单/撤单/改单结果未知 | reject `REQUEST_OUTCOME_UNKNOWN`，调用方不得盲重试 |
| 恢复后仍无法确认某订单终态 | 通过 `ORDER_STATE_UNKNOWN` 或 `OrderDataStatus.unresolvedOrdersCount` 暴露 |
| 调用不支持的能力 | reject `CAPABILITY_NOT_SUPPORTED` |
| 消费方过慢导致缓冲区溢出 | 对应 iterator 抛出 `EVENT_CONSUMER_OVERFLOW` |

## 10. 生命周期与接入方式

### 10.1 生命周期

| API | 语义 |
|---|---|
| `createClient()` | 纯内存初始化，不触发 I/O |
| `registerAccount()` | 校验并登记账户；重复 `accountId` 返回 `VALIDATION_ERROR` |
| `start()` | 启动 runtime；不等于所有 private baseline 已完成 |
| `subscribeAccount()` / `subscribeOrders()` | 是 private data 的 ready barrier |
| `removeAccount()` | 释放账户私有状态与链路 |
| `stop()` | 关闭底层连接、后台任务与所有事件迭代器 |

### 10.2 最小接入示例

```ts
import { createClient } from 'acex';

async function main() {
  const client = createClient({
    logger: console,
  });

  await client.registerAccount({
    accountId: 'main-binance',
    exchange: 'binance',
    credentials: {
      apiKey: process.env.BINANCE_API_KEY!,
      secret: process.env.BINANCE_API_SECRET!,
    },
  });

  await client.start();

  await client.market.subscribeL1Book({
    exchange: 'binance',
    symbol: 'BTC/USDT:USDT',
  });

  await client.order.subscribeOrders({
    accountId: 'main-binance',
  });

  const book = client.market.getL1Book({
    exchange: 'binance',
    symbol: 'BTC/USDT:USDT',
  });

  const orderStatus = client.order.getOrderStatus('main-binance');

  console.log({ book, orderStatus });
}
```

## 11. MVP 实现边界

当前推荐的 MVP 边界如下：

| 模块 | MVP 必做 | 可延后 |
|---|---|---|
| `AcexClient` | `start` / `stop` / `registerAccount` / `removeAccount` / `getHealth` / `watchHealth` / `watchErrors` | 更细粒度历史指标 |
| `MarketManager` | L1 / funding 订阅、最新快照、market status、market info | 更多行情类型与更细 freshness |
| `AccountManager` | 余额 / 仓位 / 风险快照、账户事件、账户状态查询 | 更复杂风险指标 |
| `OrderManager` | 命令、open orders、订单状态、订单事件、`fillId` 去重、结果未知语义 | 更高级订单类型 |
| 恢复机制 | 断线后恢复到“最新可信投影” | 多账户并发调度优化 |
| 安全与限速 | credentials 生命周期管理、日志脱敏、基础请求限速 | 按 endpoint 粒度的差异化限速 |

补充边界：

| 主题 | 当前 MVP 约定 |
|---|---|
| market 基础能力 | 目标交易所默认具备 public WS、L1 / funding stream 和 market info 能力 |
| private 基础能力 | 目标交易所默认具备 private WS、account stream 和 order stream 能力 |
| 非当前 MVP | 缺失上述基础流式能力的交易所，不属于当前 MVP 接入范围 |

需要内部实现细节时，请继续阅读 [sdk-internal-design.md](./sdk-internal-design.md)。
