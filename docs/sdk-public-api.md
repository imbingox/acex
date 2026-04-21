# 多交易所 SDK MVP 对外 API 设计

> 本文档定义当前 MVP 阶段公开接口、关键语义和设计边界。
> 当前已包含 market/account/order 数据面能力，以及第一版 Binance PAPI UM 交易命令接口。

## 1. 文档定位

本文档回答 4 个问题：

1. SDK 对外暴露哪些对象和方法。
2. `subscribe*()`、`get*()`、`events.*()` 各自承担什么职责。
3. 调用方如何判断数据是否 ready、是否仍在被持续维护。
4. 当前 MVP 明确支持什么，不支持什么。

不在本文档展开的内容：

| 主题 | 说明 |
|---|---|
| 交易所 adapter 合同 | 属于内部实现设计 |
| reconnect / reconcile 状态机 | 属于内部实现设计 |
| 完整错误码体系 | 本文档只定义关键失败语义，不穷举所有错误码 |

## 2. MVP 范围

当前 MVP 只聚焦“数据面”最小闭环：

| 模块 | MVP 承诺 |
|---|---|
| `AcexClient` | 创建、启动、停止、注册账户、更新凭证、移除账户、聚合状态与健康信息 |
| `MarketManager` | Market catalog、L1 Book / Funding Rate 订阅、退订、最新快照读取、状态读取、事件流 |
| `AccountManager` | 账户快照、余额、持仓、风险读取；账户订阅、退订、状态与事件 |
| `OrderManager` | 订单数据订阅、退订、最新订单快照与状态读取、事件流，以及第一版交易命令 |
| 生命周期语义 | `subscribe*()` 是 ready barrier；`unsubscribe*()` 后保留最后快照但标记为非活跃 |
| 事件模型 | 事件接口统一放在 `events` 子命名空间下，以 `AsyncIterable` 为主 |

当前 MVP 不承诺：

| 非目标 | 说明 |
|---|---|
| Spot 与 Derivatives 的完整统一抽象 | 第一版按 derivatives-first 设计 |
| 分布式状态同步 | 当前按单进程、内存态 client 设计 |
| 跨进程幂等与持久化去重 | 当前不做 |
| 完整市场数据品类 | 只先覆盖 L1 Book 和 Funding Rate |
| 所有交易所能力完全一致 | 差异通过订阅失败、状态和健康信息暴露 |

## 3. 设计原则

| 原则 | 说明 |
|---|---|
| 统一入口 | 调用方只与一个 `AcexClient` 和三个 manager 交互 |
| 状态型 SDK | SDK 内部持续维护最新状态，调用方优先通过 `get*()` 读快照 |
| 订阅与事件分离 | `subscribe*()` 负责让 SDK 开始维护数据；`events.*()` 只负责下游消费增量变化 |
| Ready Barrier | `await subscribe*()` 返回后，对应 `get*()` 必须已经可用 |
| 显式生命周期 | `subscribe*()` / `unsubscribe*()` / `removeAccount()` 都有明确资源语义 |
| Derivatives First | 第一版优先围绕永续/合约账户、持仓、风险、funding 设计 |
| 非活跃缓存保留 | 退订后保留最后快照，但必须显式标记为非活跃，避免误判仍在持续维护 |

## 4. 最小接入示例

```ts
import { createClient } from "@imbingox/acex";

async function main() {
  const client = createClient({
    sandbox: true,
  });

  await client.registerAccount({
    accountId: "main-binance",
    exchange: "binance",
    credentials: {
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
    },
  });

  await client.start();

  await client.market.subscribeL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  await client.market.subscribeFundingRate({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  await client.account.subscribeAccount({
    accountId: "main-binance",
  });

  await client.order.subscribeOrders({
    accountId: "main-binance",
  });

  const created = await client.order.createOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    side: "buy",
    type: "limit",
    price: "100000.0",
    amount: "0.001",
  });

  const canceled = await client.order.cancelOrder({
    accountId: "main-binance",
    symbol: "BTC/USDT:USDT",
    orderId: created.orderId,
  });

  const book = client.market.getL1Book({
    exchange: "binance",
    symbol: "BTC/USDT:USDT",
  });

  const account = client.account.getAccountSnapshot("main-binance");
  const orderStatus = client.order.getOrderStatus("main-binance");

  console.log({
    status: client.getStatus(),
    health: client.getHealth(),
    book,
    account,
    orderStatus,
    created,
    canceled,
  });

  await client.stop();
}

void main();
```

事件消费是按需能力，不替代 `subscribe*()`：

```ts
const l1BookEvents = client.market.events.l1BookUpdates({
  exchange: "binance",
  symbol: "BTC/USDT:USDT",
});

void (async () => {
  for await (const event of l1BookEvents) {
    console.log(event.snapshot);
  }
})();
```

## 5. Client 与核心对象

### 5.1 核心类型

```ts
export const SUPPORTED_EXCHANGES = ["binance", "okx", "bybit", "gate"] as const;

export type Exchange = (typeof SUPPORTED_EXCHANGES)[number];

export type ClientStatus = "idle" | "starting" | "running" | "stopping" | "stopped";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

export interface MarketRuntimeOptions {
  l1InitialMessageTimeoutMs?: number;
  l1StaleAfterMs?: number;
  l1ReconnectDelayMs?: number;
  l1ReconnectMaxDelayMs?: number;
}

export interface CreateClientOptions {
  sandbox?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  market?: MarketRuntimeOptions;
}

export interface AccountCredentials {
  apiKey?: string;
  secret?: string;
  password?: string;
  extra?: Record<string, string>;
}

export interface RegisterAccountInput {
  accountId: string;
  exchange: Exchange;
  credentials?: AccountCredentials;
  options?: Record<string, unknown>;
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
  source: "client" | "market" | "account" | "order" | "adapter" | "runtime";
  exchange?: Exchange;
  accountId?: string;
  symbol?: string;
  error: Error;
  ts: number;
}
```

### 5.2 Client 接口

```ts
export interface ClientEventStreams {
  health(filter?: HealthEventFilter): AsyncIterable<HealthEvent>;
  errors(): AsyncIterable<AcexInternalError>;
}

export interface AcexClient {
  readonly market: MarketManager;
  readonly account: AccountManager;
  readonly order: OrderManager;
  readonly events: ClientEventStreams;

  getStatus(): ClientStatus;
  getHealth(): ClientHealthSnapshot;

  registerAccount(input: RegisterAccountInput): Promise<RegisterAccountResult>;
  updateAccountCredentials(
    accountId: string,
    credentials: AccountCredentials,
  ): Promise<void>;
  removeAccount(accountId: string): Promise<void>;

  start(): Promise<void>;
  stop(options?: StopOptions): Promise<void>;
}

export declare function createClient(options?: CreateClientOptions): AcexClient;
```

### 5.3 调用约定

| 调用 | MVP 约定 |
|---|---|
| `createClient()` | 只创建对象，不主动建立网络连接 |
| `start()` | 幂等；启动 runtime，本身不等于自动开始维护全部数据 |
| `registerAccount()` | 允许运行时调用；只登记账户身份、交易所和可选 credentials |
| `updateAccountCredentials()` | 用于后补或更新账户凭证，不和 `registerAccount()` 混用 |
| `removeAccount()` | 自动退订并清理该账户相关私有资源、凭证引用和缓存 |
| `stop()` | 幂等；结束连接和后台任务；默认允许读取最后一次成功同步的快照 |

补充约束：

| 主题 | 约定 |
|---|---|
| `accountId` | 在单个 `AcexClient` 实例内全局唯一 |
| 交易对 symbol | 直接使用统一 symbol，例如 `BTC/USDT:USDT` |
| 运行态注册账户 | 允许；新账户后续可直接参与私有订阅 |
| 私有凭证校验 | 在 `account.subscribeAccount()` / `order.subscribeOrders()` 时执行，而不是在注册时一律前置 |
| 活跃私有订阅下更新 credentials | SDK 可以按需重建私有链路；调用方不需要先手工退订 |
| `subscribe*()` 之前未 `start()` | 应直接失败，不做隐式自动启动 |

## 6. 共享契约

### 6.1 数值与时间

| 字段 | 约定 |
|---|---|
| 金额、价格、数量 | 统一使用 decimal string |
| `exchangeTs` | 交易所原始时间；若上游未稳定提供，可缺省 |
| `receivedAt` | SDK 在本地收到该事件或快照的时间 |
| `updatedAt` | SDK 将该快照写入本地状态的时间 |
| `ts` | 控制面事件产出的时间 |

### 6.2 状态模型

```ts
export type SubscriptionActivity = "active" | "inactive";

export type MarketFreshness = "fresh" | "stale" | "reconciling";

export type PrivateRuntimeStatus =
  | "bootstrap_pending"
  | "healthy"
  | "degraded"
  | "reconnecting"
  | "reconciling"
  | "stopped";

export interface MarketDataStatus {
  exchange: Exchange;
  symbol: string;
  activity: SubscriptionActivity;
  ready: boolean;
  freshness?: MarketFreshness;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?: "ws_disconnected" | "heartbeat_timeout" | "reconciling";
}

export interface AccountDataStatus {
  accountId: string;
  exchange: Exchange;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?:
    | "credentials_missing"
    | "auth_failed"
    | "ws_disconnected"
    | "heartbeat_timeout"
    | "reconciling";
}

export interface OrderDataStatus {
  accountId: string;
  exchange: Exchange;
  activity: SubscriptionActivity;
  ready: boolean;
  runtimeStatus?: PrivateRuntimeStatus;
  lastReceivedAt?: number;
  lastReadyAt?: number;
  inactiveSince?: number;
  reason?:
    | "credentials_missing"
    | "auth_failed"
    | "ws_disconnected"
    | "heartbeat_timeout"
    | "reconciling";
}

export interface ClientHealthSnapshot {
  clientStatus: ClientStatus;
  markets: MarketDataStatus[];
  accounts: AccountDataStatus[];
  orders: OrderDataStatus[];
  updatedAt: number;
}
```

状态语义：

| 主题 | 约定 |
|---|---|
| `activity = active` | SDK 当前仍在持续维护这份数据 |
| `activity = inactive` | SDK 不再继续维护，但最后快照可能仍可读取 |
| `ready = true` | 对应 `subscribe*()` 已完成首个可用快照准备 |
| 市场 freshness | 只描述市场数据的新鲜度，不等同于订阅是否仍活跃 |
| 私有 runtime status | 只描述私有运行时状态，不等同于订阅是否仍活跃 |

### 6.3 事件与健康

```ts
export interface ClientStatusChangedEvent {
  type: "client.status_changed";
  status: ClientStatus;
  ts: number;
}

export interface MarketStatusChangedEvent {
  type: "market.status_changed";
  exchange: Exchange;
  symbol: string;
  status: MarketDataStatus;
  ts: number;
}

export interface AccountStatusChangedEvent {
  type: "account.status_changed";
  accountId: string;
  exchange: Exchange;
  status: AccountDataStatus;
  ts: number;
}

export interface OrderStatusChangedEvent {
  type: "order.status_changed";
  accountId: string;
  exchange: Exchange;
  status: OrderDataStatus;
  ts: number;
}

export type HealthEvent =
  | ClientStatusChangedEvent
  | MarketStatusChangedEvent
  | AccountStatusChangedEvent
  | OrderStatusChangedEvent;

export interface HealthEventFilter {
  scope?: "client" | "market" | "account" | "order";
  exchange?: Exchange;
  accountId?: string;
  symbol?: string;
}
```

## 7. `MarketManager`

### 7.1 接口

```ts
export interface MarketKeyInput {
  exchange: Exchange;
  symbol: string;
}

export interface SubscribeL1BookInput extends MarketKeyInput {}

export interface SubscribeFundingRateInput extends MarketKeyInput {}

export interface MarketEventFilter {
  exchange?: Exchange;
  symbol?: string;
}

export type MarketType = "spot" | "swap" | "future";

export interface MarketDefinition {
  exchange: Exchange;
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

export interface MarketEventStreams {
  l1BookUpdates(filter?: MarketEventFilter): AsyncIterable<L1BookUpdatedEvent>;
  fundingRateUpdates(
    filter?: MarketEventFilter,
  ): AsyncIterable<FundingRateUpdatedEvent>;
  status(filter?: MarketEventFilter): AsyncIterable<MarketStatusChangedEvent>;
  all(filter?: MarketEventFilter): AsyncIterable<MarketEvent>;
}

export interface MarketManager {
  readonly events: MarketEventStreams;

  loadMarkets(): Promise<void>;
  subscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  unsubscribeL1Book(input: SubscribeL1BookInput): Promise<void>;

  subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;
  unsubscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;

  getMarket(exchange: Exchange, symbol: string): MarketDefinition | undefined;
  findMarkets(symbol: string): MarketDefinition[];
  listMarkets(exchange?: Exchange): MarketDefinition[];
  getL1Book(key: MarketKeyInput): L1Book | undefined;
  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined;
  getMarketStatus(key: MarketKeyInput): MarketDataStatus | undefined;
}
```

### 7.2 数据结构

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
```

### 7.3 事件

```ts
export interface L1BookUpdatedEvent {
  type: "l1_book.updated";
  exchange: Exchange;
  symbol: string;
  snapshot: L1Book;
  ts: number;
}

export interface FundingRateUpdatedEvent {
  type: "funding_rate.updated";
  exchange: Exchange;
  symbol: string;
  snapshot: FundingRateSnapshot;
  ts: number;
}

export type MarketEvent =
  | L1BookUpdatedEvent
  | FundingRateUpdatedEvent
  | MarketStatusChangedEvent;
```

### 7.4 公开语义

| 主题 | 约定 |
|---|---|
| `loadMarkets()` | 显式加载并缓存标准化 market catalog；当前实现聚焦 `binance` 的 `Spot + USDⓈ-M + COIN-M` |
| `getMarket(exchange, symbol)` / `findMarkets(symbol)` / `listMarkets(exchange?)` | 读取已缓存的标准化 market metadata；getter 本身不隐式发起网络请求 |
| `subscribeL1Book()` / `subscribeFundingRate()` | 幂等；resolve 时对应首个快照必须已经 ready |
| `subscribeL1Book()` | 内部会确保 market catalog 已加载，然后再按统一 `symbol` 路由到对应 market family 的真实 WS stream |
| `unsubscribe*()` | 幂等；退订后保留最后快照，但状态改为 `activity = inactive` |
| `getL1Book()` / `getFundingRate()` | 返回当前最后快照；若从未订阅或未 ready，则返回 `undefined` |
| `getMarketStatus()` | 调用方判断市场数据是否仍可用于决策的主要入口 |
| `events.*()` | 每次调用返回独立 `AsyncIterable` consumer；退出循环即释放该 consumer |
| 事件与快照关系 | 事件 payload 携带本次写入后的最新快照；调用方也可以再调用 `get*()` 获取当前状态 |
| freshness 语义 | 当前实现区分 “连接仍在但长时间无消息” 的 `heartbeat_timeout` 和 “连接已断开” 的 `ws_disconnected` |
| 自动重连 | SDK 内部负责 market websocket 的自动重连与重订阅；调用方不需要手工处理重连 |

## 8. `AccountManager`

### 8.1 接口

```ts
export type PositionSide = "long" | "short" | "net";

export interface SubscribeAccountInput {
  accountId: string;
}

export interface UnsubscribeAccountInput {
  accountId: string;
}

export interface PositionKeyInput {
  accountId: string;
  symbol: string;
  side?: PositionSide;
}

export interface AccountEventFilter {
  accountId?: string;
  exchange?: Exchange;
  symbol?: string;
}

export interface AccountEventStreams {
  updates(filter?: AccountEventFilter): AsyncIterable<AccountEvent>;
  status(filter?: AccountEventFilter): AsyncIterable<AccountStatusChangedEvent>;
}

export interface AccountManager {
  readonly events: AccountEventStreams;

  subscribeAccount(input: SubscribeAccountInput): Promise<void>;
  unsubscribeAccount(input: UnsubscribeAccountInput): Promise<void>;

  getAccountSnapshot(accountId: string): AccountSnapshot | undefined;
  getBalances(accountId: string): BalanceSnapshot[];
  getBalance(accountId: string, asset: string): BalanceSnapshot | undefined;
  getPositions(accountId: string, symbol?: string): PositionSnapshot[];
  getPosition(input: PositionKeyInput): PositionSnapshot | undefined;
  getRiskSnapshot(accountId: string): RiskSnapshot | undefined;
  getAccountStatus(accountId: string): AccountDataStatus | undefined;
}
```

### 8.2 数据结构

```ts
export interface BalanceSnapshot {
  accountId: string;
  exchange: Exchange;
  asset: string;
  free: string;
  used: string;
  total: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface PositionSnapshot {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  side: PositionSide;
  size: string;
  entryPrice?: string;
  markPrice?: string;
  unrealizedPnl?: string;
  leverage?: string;
  liquidationPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}

export interface RiskSnapshot {
  accountId: string;
  exchange: Exchange;
  equity?: string;
  marginRatio?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
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

### 8.3 事件

```ts
export interface AccountEventBase {
  accountId: string;
  exchange: Exchange;
  ts: number;
}

export interface BalanceUpdatedEvent extends AccountEventBase {
  type: "balance.updated";
  asset: string;
  snapshot: BalanceSnapshot;
}

export interface PositionUpdatedEvent extends AccountEventBase {
  type: "position.updated";
  symbol: string;
  snapshot: PositionSnapshot;
}

export interface RiskUpdatedEvent extends AccountEventBase {
  type: "risk.updated";
  snapshot: RiskSnapshot;
}

export interface AccountSnapshotReplacedEvent extends AccountEventBase {
  type: "account.snapshot_replaced";
  snapshot: AccountSnapshot;
}

export type AccountEvent =
  | BalanceUpdatedEvent
  | PositionUpdatedEvent
  | RiskUpdatedEvent
  | AccountSnapshotReplacedEvent;
```

### 8.4 公开语义

| 主题 | 约定 |
|---|---|
| `subscribeAccount()` | 幂等；resolve 时 `getAccountSnapshot()` 与 `getAccountStatus()` 必须可用 |
| credentials 校验 | 在 `subscribeAccount()` 时执行；若凭证不足，应直接失败 |
| `unsubscribeAccount()` | 幂等；退订后保留最后快照，但状态改为 `activity = inactive` |
| `getAccountSnapshot()` | 返回账户视角的最新聚合快照 |
| `getBalances()` / `getPositions()` / `getRiskSnapshot()` | 从当前最新账户投影中读取，不触发网络请求 |
| `events.updates()` | 用于消费余额、持仓、风险和账户整体替换事件 |
| `removeAccount()` | 比 `unsubscribeAccount()` 更彻底；账户配置、凭证和账户相关缓存都应被移除 |

## 9. `OrderManager`

### 9.1 接口

```ts
export type OrderSide = "buy" | "sell";

export type OrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired";

export interface SubscribeOrdersInput {
  accountId: string;
}

export interface UnsubscribeOrdersInput {
  accountId: string;
}

export interface GetOrderInput {
  accountId: string;
  orderId?: string;
  clientOrderId?: string;
}

export interface OrderEventFilter {
  accountId?: string;
  exchange?: Exchange;
  symbol?: string;
}

export interface OrderEventStreams {
  updates(filter?: OrderEventFilter): AsyncIterable<OrderEvent>;
  status(filter?: OrderEventFilter): AsyncIterable<OrderStatusChangedEvent>;
}

export interface OrderManager {
  readonly events: OrderEventStreams;

  subscribeOrders(input: SubscribeOrdersInput): Promise<void>;
  unsubscribeOrders(input: UnsubscribeOrdersInput): Promise<void>;
  createOrder(input: CreateOrderInput): Promise<OrderSnapshot>;
  cancelOrder(input: CancelOrderInput): Promise<OrderSnapshot>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<OrderSnapshot[]>;

  getOrder(input: GetOrderInput): OrderSnapshot | undefined;
  getOpenOrders(accountId: string, symbol?: string): OrderSnapshot[];
  getOrderStatus(accountId: string): OrderDataStatus | undefined;
}
```

### 9.2 数据结构

```ts
export type CreateOrderType = "limit" | "market";

export type CreateOrderInput =
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "limit";
      price: string;
      amount: string;
      clientOrderId?: string;
      reduceOnly?: boolean;
      positionSide?: PositionSide;
    }
  | {
      accountId: string;
      symbol: string;
      side: OrderSide;
      type: "market";
      amount: string;
      clientOrderId?: string;
      reduceOnly?: boolean;
      positionSide?: PositionSide;
    };

export interface CancelOrderInput {
  accountId: string;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
}

export interface CancelAllOrdersInput {
  accountId: string;
  symbol: string;
}

export interface OrderSnapshot {
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: string;
  status: OrderStatus;
  price?: string;
  triggerPrice?: string;
  amount: string;
  filled: string;
  remaining?: string;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
  avgFillPrice?: string;
  exchangeTs?: number;
  receivedAt: number;
  updatedAt: number;
  seq: number;
}
```

### 9.3 事件

```ts
export interface OrderEventBase {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  ts: number;
}

export interface OrderUpdatedEvent extends OrderEventBase {
  type: "order.updated";
  snapshot: OrderSnapshot;
}

export interface OrderFilledEvent extends OrderEventBase {
  type: "order.filled";
  snapshot: OrderSnapshot;
}

export interface OrderCanceledEvent extends OrderEventBase {
  type: "order.canceled";
  snapshot: OrderSnapshot;
}

export interface OrderRejectedEvent extends OrderEventBase {
  type: "order.rejected";
  snapshot: OrderSnapshot;
}

export interface OrderSnapshotReplacedEvent {
  type: "order.snapshot_replaced";
  accountId: string;
  exchange: Exchange;
  snapshot: OrderSnapshot[];
  ts: number;
}

export type OrderEvent =
  | OrderUpdatedEvent
  | OrderFilledEvent
  | OrderCanceledEvent
  | OrderRejectedEvent
  | OrderSnapshotReplacedEvent;
```

### 9.4 公开语义

| 主题 | 约定 |
|---|---|
| `subscribeOrders()` | 幂等；resolve 时订单投影必须 ready，`getOrderStatus()` 应立即可用 |
| credentials 校验 | 在 `subscribeOrders()` 时执行；若凭证不足，应直接失败 |
| `unsubscribeOrders()` | 幂等；退订后保留最后订单快照，但状态改为 `activity = inactive` |
| `createOrder()` | 第一版仅支持 Binance PAPI UM 的 `LIMIT` / `MARKET`；返回规范化后的 `OrderSnapshot` |
| `cancelOrder()` | 需要 `accountId + symbol`，并要求 `orderId` / `clientOrderId` 至少一个；返回被撤销后的 `OrderSnapshot` |
| `cancelAllOrders()` | 第一版需要 `accountId + symbol`，不支持账户级全撤；返回被撤销订单的 `OrderSnapshot[]` |
| `getOrder()` | 根据 `orderId` 或 `clientOrderId` 读取当前最新订单快照 |
| `getOpenOrders()` | 返回当前仍视为活跃的订单集合 |
| `events.updates()` | 用于消费订单状态变化事件；不是交易命令 ack 流 |
| 当前范围 | 条件单、改单、账户级全撤不在第一版范围内 |

### 9.5 Binance 第一版落地约束

| 主题 | 约定 |
|---|---|
| `positionSide` 与持仓模式 | 单向持仓模式可以省略 `positionSide`，返回 snapshot 通常归一成 `net`；双向持仓模式必须显式传 `long` / `short` |
| 精度与最小名义金额 | `price` / `amount` 由调用方按 `MarketDefinition.priceStep`、`amountStep`、`minAmount`、`minNotional` 处理；SDK 第一版不自动纠偏 |
| 命令结果与事件 | `createOrder()` / `cancelOrder()` resolve 的是 REST 成功后标准化的 snapshot；`events.updates()` 是后续生命周期变化流，不是唯一 ack 来源 |

## 10. 关键失败语义

本轮不穷举完整错误码，但以下语义必须稳定：

| 场景 | 对外语义 |
|---|---|
| 重复 `accountId` 注册 | 直接失败 |
| 未注册账户就订阅私有数据 | 直接失败 |
| 未 `start()` 就调用 `subscribe*()` | 直接失败 |
| 私有订阅缺少必需 credentials | 直接失败 |
| `cancelOrder()` 未提供 `orderId` 与 `clientOrderId` | 本地输入校验直接失败 |
| Binance 双向持仓模式下未传或传错 `positionSide` | 交易所拒单；SDK 对外表现为 `ORDER_CREATE_FAILED` |
| `price` / `amount` 不满足交易所精度或最小名义金额 | 交易所拒单；SDK 对外表现为对应命令失败 |
| `updateAccountCredentials()` 指向不存在的账户 | 直接失败 |
| `removeAccount()` 指向不存在的账户 | 直接失败 |
| 重复 `subscribe*()` / `unsubscribe*()` | 应视为幂等 |

补充说明：

* `registerAccount()` 成功，不等于后续私有订阅一定能成功。
* `unsubscribe*()` 后仍能读到最后快照，不等于这份数据仍然新鲜或仍被持续维护。
* `removeAccount()` 比 `unsubscribe*()` 更彻底；它会清理账户配置、凭证引用和账户级缓存。

## 11. MVP 边界

当前推荐的落地边界如下：

| 模块 | 本轮必做 | 可后延 |
|---|---|---|
| `AcexClient` | `create/start/stop/registerAccount/updateAccountCredentials/removeAccount/getStatus/getHealth/events` | 更细粒度配置项 |
| `MarketManager` | L1 Book、Funding Rate、状态、事件 | 更多 market 数据类型 |
| `AccountManager` | 账户快照、余额、持仓、风险、状态、事件 | 更复杂风险指标 |
| `OrderManager` | 订单快照、open orders、状态、事件、`createOrder/cancelOrder/cancelAllOrders` | 条件单、改单、更宽撤单范围 |

明确保留空间：

| 主题 | 当前约定 |
|---|---|
| Spot 扩展 | 后续支持，但不要求当前 public API 先把所有字段做成 spot / derivatives 完整统一抽象 |
| 事件封装 | 未来可以在 `AsyncIterable` 之上再包装 callback / emitter，但第一层 public API 暂不提供 |
| 内部接入层 | 可先用 CCXT / CCXT Pro 跑通，再演进到 native adapter；对外 API 不应受其直接影响 |
