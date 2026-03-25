# 多交易所 SDK 对外设计文档

## 1. 文档目标

本文档定义一个基于 TypeScript 的多交易所 SDK 的公开接口、事件模型和应用接入方式。

SDK 初期基于 CCXT 构建：

| 能力 | 初期方案 |
|---|---|
| REST 统一接口 | `ccxt` |
| 实时流式能力 | `ccxt-pro` 或后续原生 WS Adapter |
| 多交易所接入 | 通过统一 `ExchangeAdapter` 抽象 |
| 状态维护方式 | SDK 内部组合使用 REST + WS |

本文档关注：

| 范围 | 说明 |
|---|---|
| 对外接口 | 提供给策略应用或上层服务的 SDK API |
| 领域模型 | 行情、账户、订单三类核心数据结构 |
| 事件语义 | 轮询模式与低延迟事件驱动模式如何共存 |
| 应用示例 | 其他应用如何接入和使用 SDK |

不包含：

| 不包含项 | 说明 |
|---|---|
| 具体交易所适配细节 | 例如 Binance / Bybit 的字段映射实现 |
| 完整代码实现 | 本文档是 API 和架构设计，不是最终源码 |
| 分布式部署设计 | 初期先按单进程内存态 SDK 设计 |

## 2. 设计原则

| 原则 | 说明 |
|---|---|
| 统一入口 | 应用只与 SDK 和各类 Manager 交互，不直接依赖交易所 SDK |
| 多交易所 | 同一个应用可同时接入多个交易所、多个账户 |
| 最新状态优先 | `MarketManager` 以“当前最新可交易状态”为核心 |
| 强状态语义 | `AccountManager` 和 `OrderManager` 保留更强的事件顺序语义 |
| 读写分离 | 查询走快照读取，变化感知走事件流 |
| 传输细节内聚 | REST / WS 的选择与组合由 SDK 内部决定，不暴露给使用方 |
| 可替换适配层 | 先用 CCXT，后续可平滑替换成原生 WebSocket 或混合适配 |

## 3. 总体架构

| 层级 | 角色 | 职责 |
|---|---|---|
| `ExchangeAdapter` | 适配层 | 封装 CCXT / CCXT Pro / 原生 WS 的差异，并统一编排 REST/WS |
| `DomainStore` | 状态层 | 保存最新行情、账户、订单状态 |
| `Manager` | 领域层 | 暴露标准接口，协调订阅、更新、查询、命令 |
| `Strategy App` | 应用层 | 读取快照、订阅事件、发起下单或风控逻辑 |

建议 SDK 暴露单一主对象：

```ts
export interface AcexClient {
  readonly market: MarketManager;
  readonly account: AccountManager;
  readonly order: OrderManager;

  registerAccount(input: RegisterAccountInput): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export declare function createClient(options?: {
  logger?: Console;
}): AcexClient;
```

## 4. 核心标识模型

为了支持多交易所和多账户，所有数据都需要显式带 key。

| 类型 | 含义 | 示例 |
|---|---|---|
| `Exchange` | 交易所标识 | `binance`, `okx`, `gate` |
| `AccountId` | 账户实例标识 | `main-binance`, `arb-bybit-01` |
| `Symbol` | 统一交易对标识 | `BTC/USDT` |
| `MarketKey` | 行情唯一键 | `exchange + symbol` |
| `OrderKey` | 订单唯一键 | `accountId + exchange + orderId/clientOrderId` |

建议输入配置如下：

```ts
export const SUPPORTED_EXCHANGES = ['binance', 'okx', 'gate'] as const;

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

这里使用 `Exchange` 联合类型而不是裸 `string`，主要是为了：

| 目的 | 说明 |
|---|---|
| 防止拼写错误 | 例如 `binace` 这类错误可以在类型层直接发现 |
| 提供 IDE 补全 | 上层应用接入时更顺手 |
| 避免 `enum` 运行时代码 | 只保留类型约束，不增加额外运行时负担 |

MVP 不再要求显式 `registerExchange()`。SDK 默认内置支持的一组交易所，并按需初始化：

| 场景 | 初始化方式 |
|---|---|
| 公共行情 | 第一次 `subscribeL1Book()` / `subscribeFundingRate()` 时 lazy init 对应交易所 |
| 私有账户/订单 | `registerAccount()` 时初始化对应交易所私有连接 |

关于 `symbol`，SDK 直接沿用 CCXT 的统一命名。

| 场景 | 建议 |
|---|---|
| 现货 | 例如 `BTC/USDT` |
| 永续 / 交割合约 | 例如 `BTC/USDT:USDT`，具体以 CCXT unified market symbol 为准 |

也就是说，外部应用不需要额外传 `marketType`。同一个交易所实例可以同时覆盖 spot / swap / future，具体市场类型由 adapter 基于 `symbol` 和交易所 market metadata 在内部解析。

MVP 默认不引入额外的“交易所实例 ID”层，公开 API 直接使用 `binance / okx / gate` 这类交易所标识。
如果后续需要支持同一交易所的多实例并存，再额外增加 `instanceId` 即可。

关于传输层，公开 API 不要求调用方声明 `transport`。SDK 默认按下面方式维护状态：

| 内部阶段 | 默认职责 |
|---|---|
| REST bootstrap | 初始化 markets、余额、仓位、订单等基础快照 |
| WS stream | 持续接收行情和私有流增量更新 |
| REST reconcile | 断连恢复、定期校验和状态修正 |

建议补充一组共享过滤器和返回类型：

```ts
export interface MarketEventFilter {
  exchange?: Exchange;
  symbol?: string;
}

export interface AccountEventFilter {
  accountId?: string;
  exchange?: Exchange;
  symbol?: string;
}

export interface OrderEventFilter {
  accountId?: string;
  exchange?: Exchange;
  symbol?: string;
  clientOrderId?: string;
  orderId?: string;
}

export interface PositionKeyInput {
  accountId: string;
  exchange?: Exchange;
  symbol: string;
}

export interface GetOrderInput {
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  symbol?: string;
}

export interface PlaceOrderResult {
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  accepted: boolean;
  submittedAt: number;
}
```

## 5. Manager 职责边界

| Manager | 核心职责 | 不负责 |
|---|---|---|
| `MarketManager` | 公开行情订阅、最新行情缓存、行情变化通知 | 账户风险、订单执行 |
| `AccountManager` | 余额、仓位、保证金、风险快照维护 | 下单路由 |
| `OrderManager` | 下单、撤单、改单、订单状态维护 | 行情聚合 |

## 6. `MarketManager` 设计

### 6.1 语义

`MarketManager` 的核心语义是：

| 能力 | 说明 |
|---|---|
| 最新状态缓存 | 始终提供某个市场的最新 L1、资金费率等 |
| 变化通知 | 当状态变化时通知应用“这个 key 更新了” |
| 非强顺序事件 | 默认不要求应用处理每一个中间行情事件 |

也就是说，`MarketManager` 的事件更像“唤醒信号”，真正数据源是内部最新快照。

这里的关键设计约束是：

| 约束 | 说明 |
|---|---|
| 外部 key | 使用 `exchange + symbol` |
| `symbol` 语义 | 完全遵循 CCXT unified symbol |
| `marketType` | 不作为常规公开 API 字段，由 adapter 内部解析 |

### 6.2 公开接口

```ts
export interface MarketManager {
  subscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;

  getL1Book(key: MarketKeyInput): L1Book | undefined;
  getFundingRate(key: MarketKeyInput): FundingRateSnapshot | undefined;
  getMarketSnapshot(key: MarketKeyInput): MarketSnapshot | undefined;

  watchL1BookUpdates(filter?: MarketEventFilter): AsyncIterable<L1BookUpdatedEvent>;
  watchFundingRateUpdates(filter?: MarketEventFilter): AsyncIterable<FundingRateUpdatedEvent>;
  watchMarketEvents(filter?: MarketEventFilter): AsyncIterable<MarketEvent>;
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
```

### 6.3 核心数据结构

```ts
export interface L1Book {
  exchange: Exchange;
  symbol: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  ts: number;
  version: number;
}

export interface FundingRateSnapshot {
  exchange: Exchange;
  symbol: string;
  fundingRate: string;
  nextFundingTime?: number;
  markPrice?: string;
  indexPrice?: string;
  ts: number;
  version: number;
}

export interface MarketSnapshot {
  l1Book?: L1Book;
  fundingRate?: FundingRateSnapshot;
}
```

### 6.4 行情事件模型

```ts
export interface L1BookUpdatedEvent {
  type: 'l1_book.updated';
  exchange: Exchange;
  symbol: string;
  ts: number;
  version: number;
}

export interface FundingRateUpdatedEvent {
  type: 'funding_rate.updated';
  exchange: Exchange;
  symbol: string;
  ts: number;
  version: number;
}

export type MarketEvent = L1BookUpdatedEvent | FundingRateUpdatedEvent;
```

### 6.5 为什么只发“变化通知”

| 原因 | 说明 |
|---|---|
| 套利策略关注的是当前可成交状态 | 不是每一次中间跳变路径 |
| 降低事件负载 | 避免在事件里重复传完整 L1 数据 |
| 避免使用方处理时序问题 | 应用统一从 `getL1Book()` 读取当前态 |

## 7. `AccountManager` 设计

### 7.1 语义

`AccountManager` 维护账户维度的权威内存投影。

它的事件语义强于 `MarketManager`，因为：

| 领域变化 | 为什么要更强语义 |
|---|---|
| 余额变化 | 会直接影响可下单额度 |
| 仓位变化 | 会影响风控和对冲逻辑 |
| 风险变化 | 会影响强平和减仓决策 |

### 7.2 公开接口

```ts
export interface AccountManager {
  subscribeAccount(input: SubscribeAccountInput): Promise<void>;

  getBalance(accountId: string, asset?: string): BalanceSnapshot | undefined;
  getPosition(input: PositionKeyInput): PositionSnapshot | undefined;
  getAccountSnapshot(accountId: string): AccountSnapshot | undefined;
  getRiskSnapshot(accountId: string): RiskSnapshot | undefined;

  watchAccountEvents(filter?: AccountEventFilter): AsyncIterable<AccountEvent>;
}

export interface SubscribeAccountInput {
  accountId: string;
  syncBalances?: boolean;
  syncPositions?: boolean;
  syncRisk?: boolean;
}
```

### 7.3 核心数据结构

```ts
export interface BalanceSnapshot {
  accountId: string;
  exchange: Exchange;
  asset: string;
  free: string;
  used: string;
  total: string;
  ts: number;
}

export interface PositionSnapshot {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  side: 'long' | 'short' | 'net';
  size: string;
  entryPrice?: string;
  markPrice?: string;
  unrealizedPnl?: string;
  liquidationPrice?: string;
  ts: number;
}

export interface RiskSnapshot {
  accountId: string;
  exchange: Exchange;
  equity?: string;
  marginRatio?: string;
  initialMargin?: string;
  maintenanceMargin?: string;
  ts: number;
}

export interface AccountSnapshot {
  accountId: string;
  exchange: Exchange;
  balances: Record<string, BalanceSnapshot>;
  positions: PositionSnapshot[];
  risk?: RiskSnapshot;
  ts: number;
}
```

### 7.4 账户事件模型

```ts
export interface AccountEventBase {
  seq: number;
  accountId: string;
  exchange: Exchange;
  ts: number;
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

export type AccountEvent =
  | BalanceUpdatedEvent
  | PositionUpdatedEvent
  | RiskUpdatedEvent;
```

## 8. `OrderManager` 设计

### 8.1 语义

订单是执行系统的核心业务流，必须支持更强的顺序性和状态可追踪性。

### 8.2 公开接口

```ts
export interface OrderManager {
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  cancelOrder(input: CancelOrderInput): Promise<void>;
  amendOrder(input: AmendOrderInput): Promise<void>;

  getOrder(input: GetOrderInput): OrderSnapshot | undefined;
  getOpenOrders(accountId: string, exchange?: Exchange): OrderSnapshot[];

  watchOrderEvents(filter?: OrderEventFilter): AsyncIterable<OrderEvent>;
}

export interface PlaceOrderInput {
  accountId: string;
  exchange: Exchange;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop' | 'stop_market';
  price?: string;
  amount: string;
  clientOrderId?: string;
  reduceOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY';
  params?: Record<string, unknown>;
}

export interface CancelOrderInput {
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  symbol?: string;
}

export interface AmendOrderInput extends CancelOrderInput {
  newPrice?: string;
  newAmount?: string;
}
```

### 8.3 订单数据结构

```ts
export interface OrderSnapshot {
  accountId: string;
  exchange: Exchange;
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
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
  amount: string;
  filled: string;
  remaining?: string;
  avgFillPrice?: string;
  ts: number;
  updatedAt: number;
}
```

### 8.4 订单事件模型

```ts
export interface OrderEventBase {
  seq: number;
  accountId: string;
  exchange: Exchange;
  ts: number;
  source: 'command' | 'private-stream' | 'reconcile';
}

export interface OrderUpdatedEvent extends OrderEventBase {
  type: 'order.updated';
  snapshot: OrderSnapshot;
}

export interface OrderFilledEvent extends OrderEventBase {
  type: 'order.filled';
  snapshot: OrderSnapshot;
  fillPrice?: string;
  fillAmount?: string;
}

export interface OrderRejectedEvent extends OrderEventBase {
  type: 'order.rejected';
  reason?: string;
  snapshot: OrderSnapshot;
}

export type OrderEvent =
  | OrderUpdatedEvent
  | OrderFilledEvent
  | OrderRejectedEvent;
```

## 9. 事件语义总表

| Manager | 事件语义 | 是否要求每条必达 | 使用建议 |
|---|---|---|---|
| `MarketManager` | 最新态变化通知 | 否 | 收到事件后立刻读最新快照 |
| `AccountManager` | 有序账户状态事件 | 是，至少在 SDK 内部保证单账户顺序 | 用于风控、仓位驱动逻辑 |
| `OrderManager` | 有序订单生命周期事件 | 是，至少在 SDK 内部保证单账户顺序 | 用于执行和成交联动逻辑 |

## 10. SDK 初始化与生命周期

```ts
import { createClient } from 'acex';

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
```

## 11. 其他应用如何接入 SDK

### 11.1 轮询型策略应用

适合中低频策略，只依赖最新状态。

```ts
import { createClient } from 'acex';

async function main() {
  const client = createClient();

  await client.start();

  await client.market.subscribeL1Book({
    exchange: 'binance',
    symbol: 'BTC/USDT:USDT',
  });

  setInterval(() => {
    const book = client.market.getL1Book({
      exchange: 'binance',
      symbol: 'BTC/USDT:USDT',
    });

    if (!book) return;

    const spread = Number(book.askPrice) - Number(book.bidPrice);
    console.log('latest spread:', spread);
  }, 1000);
}
```

### 11.2 低延迟套利应用

适合你提到的场景。策略并不消费所有中间行情，只在变更时被唤醒，然后读取最新状态。

```ts
async function runArbApp(client: AcexClient) {
  await client.market.subscribeL1Book({
    exchange: 'binance',
    symbol: 'BTC/USDT:USDT',
  });

  await client.market.subscribeL1Book({
    exchange: 'bybit',
    symbol: 'BTC/USDT:USDT',
  });

  for await (const event of client.market.watchL1BookUpdates({
    symbol: 'BTC/USDT:USDT',
  })) {
    const a = client.market.getL1Book({
      exchange: 'binance',
      symbol: 'BTC/USDT:USDT',
    });

    const b = client.market.getL1Book({
      exchange: 'bybit',
      symbol: 'BTC/USDT:USDT',
    });

    if (!a || !b) continue;

    const buyA = Number(a.askPrice);
    const sellB = Number(b.bidPrice);
    const edge = sellB - buyA;

    if (edge > 5) {
      console.log('arb signal', {
        trigger: event.exchange,
        edge,
        buyAt: a.exchange,
        sellAt: b.exchange,
      });
    }
  }
}
```

这个例子体现了推荐语义：

| 步骤 | 说明 |
|---|---|
| `watchL1BookUpdates()` | 只负责通知“有变化了” |
| `getL1Book()` | 读取当前最新状态 |
| 策略逻辑 | 始终基于最新双边状态做判断 |

### 11.3 执行型应用

适合独立的下单服务或策略执行器。

```ts
async function runExecutionApp(client: AcexClient) {
  const result = await client.order.placeOrder({
    accountId: 'main-binance',
    exchange: 'binance',
    symbol: 'BTC/USDT:USDT',
    side: 'buy',
    type: 'limit',
    price: '62000',
    amount: '0.01',
    clientOrderId: 'arb-entry-001',
    timeInForce: 'IOC',
  });

  console.log('placed', result);

  for await (const event of client.order.watchOrderEvents({
    accountId: 'main-binance',
  })) {
    if (event.type === 'order.filled') {
      console.log('filled', event.snapshot);
    }
  }
}
```

### 11.4 风控 / 账户监控应用

适合单独的风险服务或 dashboard 后端。

```ts
async function runRiskApp(client: AcexClient) {
  await client.account.subscribeAccount({
    accountId: 'main-binance',
    syncBalances: true,
    syncPositions: true,
    syncRisk: true,
  });

  for await (const event of client.account.watchAccountEvents({
    accountId: 'main-binance',
  })) {
    const risk = client.account.getRiskSnapshot('main-binance');
    if (!risk) continue;

    if (risk.marginRatio && Number(risk.marginRatio) > 0.8) {
      console.warn('margin ratio too high', risk);
    }
  }
}
```

## 12. 推荐目录结构

当开始实现时，建议源码按下面方式组织：

| 路径 | 用途 |
|---|---|
| `src/sdk/` | SDK 主入口与生命周期 |
| `src/managers/market/` | `MarketManager` 及状态存储 |
| `src/managers/account/` | `AccountManager` 及状态存储 |
| `src/managers/order/` | `OrderManager` 及状态存储 |
| `src/adapters/ccxt/` | CCXT REST 适配 |
| `src/adapters/ccxt-pro/` | CCXT Pro 流式适配 |
| `src/domain/` | 共享领域模型和类型定义 |
| `src/events/` | AsyncIterable / emitter / buffer 抽象 |

## 13. 实现阶段建议

| 阶段 | 目标 |
|---|---|
| Phase 1 | 先实现 `MarketManager` 的订阅、缓存和最新态事件 |
| Phase 2 | 接入 `OrderManager` 的下单与订单状态更新 |
| Phase 3 | 接入 `AccountManager` 的余额、仓位、风险投影 |
| Phase 4 | 增加更多交易所 Adapter 和一致性校验 |

## 14. 当前结论

当前推荐的 MVP 设计是：

| 模块 | 推荐语义 |
|---|---|
| `MarketManager` | 最新状态缓存 + 变化通知，外部按 `exchange + symbol` 访问 |
| `AccountManager` | 有序账户事件 + 最新账户快照 |
| `OrderManager` | 有序订单事件 + 最新订单快照 |

这保证：

| 目标 | 是否满足 |
|---|---|
| 普通策略能简单轮询 | 是 |
| 套利策略能低延迟被唤醒 | 是 |
| 下单与账户状态具备更强业务语义 | 是 |
| 后续可替换底层交易所实现 | 是 |
