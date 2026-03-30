# 多交易所 SDK 内部实现与扩展设计

> 本文档承接 [sdk-public-api.md](./sdk-public-api.md) 中未展开的内部实现细节。
> 它服务于 SDK 实现者，而不是 SDK 使用方。

## 1. 文档定位

本文件回答这些内部问题：

1. public API 背后如何用 REST + WS 维护状态。
2. `ExchangeAdapter` 需要提供什么能力面。
3. market / account / order 的恢复编排如何完成。
4. 当交易所能力不齐时，SDK Core 应如何降级。
5. adapter 接入前应该满足哪些一致性要求。

## 2. 分层原则

| 层级 | 职责 | 不负责 |
|---|---|---|
| `ExchangeAdapter` | 对接交易所、维护连接、做字段标准化、暴露能力差异 | 对外 public API 语义定义 |
| `SDK Core` | 编排 bootstrap、freshness、reconcile、降级与恢复 | 交易所字段映射细节 |
| `DomainStore` | 保存 latest snapshot 与控制面状态 | 直接操作网络连接 |
| `Manager` | 对外提供稳定 API 与事件语义 | 底层连接生命周期 |

核心原则：

| 原则 | 说明 |
|---|---|
| 对外统一，对内可分化 | CCXT Pro 与 native adapter 内部实现可完全不同，但对 Core 的合同必须一致 |
| Core 决定正确性 | freshness、`degraded`、`reconciling`、reconcile 完成判定由 Core 负责 |
| adapter 报告事实 | adapter 报告事件、快照、连接状态和能力，不直接定义对外语义 |

## 3. REST + WS 协同策略

SDK 默认采用“WS 为主，REST 校准”的状态维护策略：

| 阶段 | 主通道 | 目标 |
|---|---|---|
| bootstrap | REST | 建立 baseline 和 metadata |
| steady state | WS | 低延迟更新本地投影 |
| reconcile | REST | 在断线、gap、校验失败后重建可信状态 |
| recovery | WS + REST | 先恢复会话，再恢复可信状态 |

强约束：

| 约束 | 说明 |
|---|---|
| 先失效，后恢复 | 一旦无法证明增量连续，必须先降级，再执行恢复 |
| WS 恢复不等于状态恢复 | 重新连上 socket 后，仍需完成 baseline 校准 |
| reconcile 结果更权威 | reconcile 可以覆盖本地旧投影，并对外发出 `source: 'reconcile'` 事件 |

## 4. `ExchangeAdapter` 合同

### 4.1 能力面

```ts
export interface ExchangeCapabilities {
  publicWs: boolean;
  privateWs: boolean;
  l1BookStream: boolean;
  fundingRateStream: boolean;
  accountStream: boolean;
  orderStream: boolean;
  stopOrder: boolean;
  cancelAllOrders: boolean;
  amendOrder: boolean;
  nativeClientOrderId: boolean;
  fetchMarketBaseline: boolean;
  fetchMarketInfo: boolean;
  fetchBalances: boolean;
  fetchPositions: boolean;
  fetchRisk: boolean;
  fetchOpenOrders: boolean;
  fetchOrderById: boolean;
  fetchMyTrades: boolean;
  sequenceAware: boolean;
}
```

能力设计原则：

| 主题 | 说明 |
|---|---|
| 先声明，再调用 | SDK Core 不能假设所有交易所都支持同一套恢复路径 |
| 不隐式补全能力 | 缺能力时，要么显式降级，要么显式报错 |
| 能力声明服务于恢复 | `fetchOpenOrders`、`fetchMyTrades`、`fetchOrderById` 等主要用于恢复闭环 |

### 4.2 接口草案

```ts
export type AdapterL1Book = Omit<L1Book, 'updatedAt' | 'version'>;
export type AdapterFundingRateSnapshot = Omit<FundingRateSnapshot, 'updatedAt' | 'version'>;

export interface AdapterMarketSnapshot {
  l1Book?: AdapterL1Book;
  fundingRate?: AdapterFundingRateSnapshot;
}

export type AdapterBalanceSnapshot = Omit<BalanceSnapshot, 'seq' | 'updatedAt'>;
export type AdapterPositionSnapshot = Omit<PositionSnapshot, 'seq' | 'updatedAt'>;
export type AdapterRiskSnapshot = Omit<RiskSnapshot, 'seq' | 'updatedAt'>;

export interface AdapterAccountSnapshot {
  accountId: string;
  exchange: Exchange;
  balances: Record<string, AdapterBalanceSnapshot>;
  positions: AdapterPositionSnapshot[];
  risk: AdapterRiskSnapshot;
  exchangeTs?: number;
  receivedAt: number;
}

export type AdapterOrderSnapshot = Omit<OrderSnapshot, 'seq' | 'updatedAt'>;
export type AdapterFillDetail = FillDetail;

export type NormalizedMarketEvent =
  | {
      type: 'l1_book.updated';
      exchange: Exchange;
      symbol: string;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterL1Book;
    }
  | {
      type: 'funding_rate.updated';
      exchange: Exchange;
      symbol: string;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterFundingRateSnapshot;
    };

export type NormalizedAccountEvent =
  | {
      type: 'balance.updated';
      accountId: string;
      exchange: Exchange;
      asset: string;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterBalanceSnapshot;
    }
  | {
      type: 'position.updated';
      accountId: string;
      exchange: Exchange;
      symbol: string;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterPositionSnapshot;
    }
  | {
      type: 'risk.updated';
      accountId: string;
      exchange: Exchange;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterRiskSnapshot;
    };

export type NormalizedOrderEvent =
  | {
      type: 'order.updated';
      accountId: string;
      exchange: Exchange;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterOrderSnapshot;
    }
  | {
      type: 'order.filled';
      accountId: string;
      exchange: Exchange;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterOrderSnapshot;
      fill: AdapterFillDetail;
    }
  | {
      type: 'order.canceled';
      accountId: string;
      exchange: Exchange;
      exchangeTs?: number;
      receivedAt: number;
      reason?: string;
      snapshot: AdapterOrderSnapshot;
    }
  | {
      type: 'order.expired';
      accountId: string;
      exchange: Exchange;
      exchangeTs?: number;
      receivedAt: number;
      snapshot: AdapterOrderSnapshot;
    }
  | {
      type: 'order.rejected';
      accountId: string;
      exchange: Exchange;
      exchangeTs?: number;
      receivedAt: number;
      reason?: string;
      snapshot: AdapterOrderSnapshot;
    };

export interface AdapterPlaceOrderResult {
  orderId?: string;
  clientOrderId?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface AdapterAmendOrderResult {
  orderId?: string;
  clientOrderId?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface AdapterCancelOrderResult {
  orderId?: string;
  clientOrderId?: string;
  exchangeTs?: number;
  receivedAt: number;
}

export interface AdapterCancelAllOrdersResult {
  canceledCount?: number;
  exchangeTs?: number;
  receivedAt: number;
}

export interface ExchangeAdapter {
  readonly exchange: Exchange;
  readonly capabilities: ExchangeCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;

  subscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  unsubscribeL1Book(input: SubscribeL1BookInput): Promise<void>;
  subscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;
  unsubscribeFundingRate(input: SubscribeFundingRateInput): Promise<void>;

  ensurePrivateAccount(accountId: string): Promise<void>;
  releasePrivateAccount(accountId: string): Promise<void>;

  watchMarketEvents(): AsyncIterable<NormalizedMarketEvent>;
  watchAccountEvents(): AsyncIterable<NormalizedAccountEvent>;
  watchOrderEvents(): AsyncIterable<NormalizedOrderEvent>;

  fetchMarketBaseline(input: MarketKeyInput): Promise<AdapterMarketSnapshot>;
  fetchMarketInfo(): Promise<MarketInfo[]>;
  fetchAccountBaseline(accountId: string): Promise<AdapterAccountSnapshot>;
  fetchOpenOrdersBaseline(accountId: string): Promise<AdapterOrderSnapshot[]>;
  fetchRecentTradesForRecovery(input: {
    accountId: string;
    sinceExchangeTs?: number;
  }): Promise<AdapterFillDetail[]>;
  fetchOrder(input: GetOrderInput): Promise<AdapterOrderSnapshot | undefined>;

  placeOrder(input: PlaceOrderInput): Promise<AdapterPlaceOrderResult>;
  cancelOrder(input: CancelOrderInput): Promise<AdapterCancelOrderResult>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<AdapterCancelAllOrdersResult>;
  amendOrder(input: AmendOrderInput): Promise<AdapterAmendOrderResult>;

  getHealth(): AdapterHealth;
}
```

补充约束：

| 主题 | 约定 |
|---|---|
| credentials | 由 SDK Core 在构造 adapter 时注入，不出现在 adapter public contract 中 |
| ready barrier | `subscribeAccount()` / `subscribeOrders()` 的 barrier 由 Core 编排，不由 adapter 自己定义 |
| MVP 订阅粒度 | Core 按 `accountId` 维护整域 runtime；`subscribeAccount()` 代表完整账户投影，`subscribeOrders()` 代表完整订单投影 |
| market MVP 能力要求 | 当前 MVP 目标 adapter 必须满足 `publicWs = true`、`l1BookStream = true`、`fundingRateStream = true`、`fetchMarketInfo = true`；`fetchMarketBaseline` 属于恢复增强能力 |
| private stream MVP 能力要求 | 当前 MVP 目标 adapter 必须满足 `privateWs = true`、`accountStream = true`、`orderStream = true`；缺任一能力都不满足 MVP |
| account baseline 形状 | `fetchAccountBaseline()` 返回完整 account baseline，包含 balances / positions / risk |
| account baseline 能力要求 | 当前 MVP 目标 adapter 必须满足 `fetchBalances = true`、`fetchPositions = true`、`fetchRisk = true`；缺任一能力都不满足 MVP |
| open orders baseline 形状 | `fetchOpenOrdersBaseline()` 只返回当前仍活跃的订单快照集合，不混入 recent trades |
| order MVP 能力要求 | 当前 MVP 目标 adapter 必须满足 `fetchOpenOrders = true`；缺失时不满足 MVP |
| 订单恢复增强能力 | `fetchRecentTradesForRecovery()` 由 adapter 基于交易所 `fetchMyTrades` 能力实现；`fetchOrder()` 用于逐单确认终态 |
| 订阅生命周期 | MVP 不提供 partial scope 或细粒度退订 contract；调用方按 `accountId` 管理整域订阅生命周期 |
| 业务字段归属 | adapter 只负责产出交易所标准化后的业务字段、`exchangeTs`、`receivedAt` 和交易所原始终态事实 |
| Core 字段归属 | `version`、`seq`、`updatedAt`、`source`、`requestId`、`submittedAt`、控制面状态事件都由 Core 负责补齐或生成 |
| 标准化输出 | adapter 输出使用前置业务模型；public snapshot / event / health event 由 Core 基于这些前置模型生成 |

时间字段标准化：

| 场景 | 字段约定 |
|---|---|
| adapter 前置业务快照 | 只使用 `exchangeTs?`、`receivedAt`；不产出 `updatedAt` |
| adapter 前置业务事件 | 只使用 `exchangeTs?`、`receivedAt`；若事件携带 snapshot，则 snapshot 同样不带 `updatedAt` |
| public 业务快照 | 由 Core 在写入 store 或完成投影切换时补齐 `updatedAt` |
| public 业务事件 | 若事件携带 public snapshot，则 snapshot 中的 `updatedAt` 同样由 Core 补齐 |
| 控制面事件 | 继续使用单字段 `ts`，表示 SDK 产出该控制事件的时间 |

其中：

| 字段 | 说明 |
|---|---|
| `exchangeTs?` | 上游 payload 或快照中可提取的交易所时间；缺失时不强行伪造 |
| `receivedAt` | adapter 在本地接收到该事件/响应的时间 |
| `updatedAt` | SDK Core 将数据写入 store 或完成投影切换的时间 |
| `lastBaselineSyncAt` | 最近一次可信 baseline 同步完成时间，覆盖 bootstrap 与 reconcile，不表示任意 REST 请求 |

## 5. 控制面状态模型

### 5.1 adapter 状态

```ts
export type AdapterHealthStatus =
  | 'idle'
  | 'healthy'
  | 'degraded'
  | 'reconnecting'
  | 'reconciling'
  | 'stopped';
```

状态语义：

| 状态 | 含义 |
|---|---|
| `idle` | adapter 已创建但尚未建立有效连接 |
| `healthy` | 流式连接连续，允许向 Core 提供连续事件 |
| `degraded` | 已确认链路异常，不能继续宣称增量连续 |
| `reconnecting` | 正在重建 WS 会话 |
| `reconciling` | WS 会话已恢复，但 baseline 仍在校准 |
| `stopped` | adapter 已关闭，不再产出事件 |

### 5.2 private data 状态

| 状态 | 适用对象 | 说明 |
|---|---|---|
| `bootstrap_pending` | account / order | 首次 baseline 尚未建立 |
| `healthy` | account / order | 当前投影可视为可信最新状态 |
| `degraded` | account / order | 仍可读最后投影，但不再承诺正确连续 |
| `reconnecting` | account / order | 正在等待底层流恢复 |
| `reconciling` | account / order | 已连上，但投影尚未重新校准 |
| `stopped` | account / order | 对应 runtime 已关闭 |

## 6. 按领域的恢复编排

### 6.1 Market

| 阶段 | 处理 |
|---|---|
| 检测断线、超时、gap | 将 `MarketDataStatus` 切到 `stale` |
| 重建 WS 会话 | 切到 `reconciling` |
| 拉取最新 baseline | 用 REST 最新 L1 / funding 覆盖旧快照 |
| 接收新会话事件 | 至少接收一条新会话内有效 market update |
| 恢复完成 | 切回 `fresh`，发出 `market.status_changed` |

约束：

| 约束 | 说明 |
|---|---|
| `stale` 仍可读 | 供展示和日志使用，但不建议继续用于主动交易 |
| 无可靠 REST baseline 时 | 至少要等新会话第一条可信 WS 更新后才能回到 `fresh` |

### 6.2 Account

| 阶段 | 处理 |
|---|---|
| 私有流失效 | 停止宣称余额 / 仓位 / 风险事件连续 |
| 恢复期 baseline | 重新拉取 balances / positions / risk |
| 原子切换 | 尽量以单账户维度一次切换投影 |
| 对外通知 | 使用 `source: 'reconcile'` 事件修正消费方状态 |

约束：

| 约束 | 说明 |
|---|---|
| MVP baseline 必需集 | balances / positions / risk 三者缺一不可 |
| account ready barrier | `subscribeAccount()` 只有在 balances / positions / risk 全部 baseline 完成后才能 resolve |
| 当前 MVP 目标 | 面向合约账户；若某 adapter 无法提供统一 risk snapshot，则不满足当前 MVP |

### 6.3 Order

订单恢复优先级：

1. `fetchOpenOrdersBaseline(accountId)` 对齐当前活跃订单集合。
2. 若支持 `fetchMyTrades`，则调用 `fetchRecentTradesForRecovery({ accountId, sinceExchangeTs: max(0, lastTradeExchangeTs - tradeRecoveryLookbackMs) })` 回补可能丢失的成交。
3. 必要时对 unresolved order 逐个 `fetchOrder()` 确认终态。
4. 仍无法确认时，保留订单并标记为待确认。

建议维护的内部恢复上下文：

| 内部字段 | 用途 |
|---|---|
| `lastStreamReceivedAt` | 用于健康状态、超时判定和观测；不直接作为交易所 trades 查询游标 |
| `lastTradeExchangeTs` | 最近一次已确认成交对应的交易所侧时间，用于恢复期 trades 查询游标 |
| `tradeRecoveryLookbackMs` | 恢复查询的安全回看窗口；避免因时钟偏差、网络抖动或上游延迟而漏单 |
| `openOrderIds` / `clientOrderId` 索引 | 对比本地投影与 REST 返回结果 |
| 最近成交缓存 | 在订单终态缺失时回补 filled 结果 |
| `reconcileVersion` | 防止旧恢复结果覆盖新恢复结果 |
| `wsSessionId` | 防止旧会话延迟消息污染新会话 |

强约束：

| 规则 | 说明 |
|---|---|
| trades 查询游标 | 必须使用交易所侧时间游标，而不是本地接收时间 |
| 安全回看窗口 | 即使维护了 `lastTradeExchangeTs`，恢复查询也应保留固定 lookback，再依赖 `fillId` 去重 |
| baseline 与 recovery 分离 | `fetchOpenOrdersBaseline()` 只负责当前 open orders 权威集合；recent trades 回补由独立恢复函数承担 |
| 无 trade 时间时 | 若拿不到稳定的 trade exchange timestamp，则应扩大回看窗口或退化到更保守的逐单确认策略 |

## 7. `degraded` 下的命令行为

私有流降级不等于交易所 REST 不可用，因此命令策略如下：

| 命令 | 行为 |
|---|---|
| `placeOrder()` | 允许提交 |
| `cancelOrder()` / `cancelAllOrders()` | 允许提交 |
| `amendOrder()` | 允许提交，但调用方需自行评估旧投影风险 |
| `getOrder()` / `getOpenOrders()` | 返回本地快照，但快照可能滞后 |

强约束：

| 规则 | 说明 |
|---|---|
| ack 不等于投影已正确 | 降级期命令成功，只代表交易所已接受，不代表本地投影已完成收敛 |
| SDK 不替应用决策 | 是否在 `degraded` 时暂停策略，由应用基于 status 自行决定 |

## 8. 安全、限速与可观测性

### 8.1 credentials 生命周期

| 原则 | 说明 |
|---|---|
| 只在 `registerAccount()` 传入 | 之后不通过 public API 再暴露 |
| 不持久化 | 不写磁盘，不写日志，不出现在事件 payload 中 |
| `removeAccount()` 后清除 | adapter 必须清除内存中的 credentials 引用 |
| 日志脱敏 | `apiKey`、`secret`、`password` 不得明文输出 |

### 8.2 限速

| 主题 | 约定 |
|---|---|
| 默认行为 | 按交易所维度排队限速 |
| 订单命令限速 | 超出 `maxOrdersPerMinute` 时直接 reject `RATE_LIMITED` |
| 交易所返回 429 | 幂等请求可自动退避；非幂等命令直接 reject |

### 8.3 可观测性

| 主题 | 约定 |
|---|---|
| `Logger` | 支持结构化 context |
| `watchErrors()` | 捕获后台 reconcile、reconnect、adapter 异常 |
| `watchHealth()` | 暴露 exchange / account / order 三层状态切换 |
| `requestId` | 贯穿命令日志、异常与事件排障 |

## 9. 降级原则

不同交易所能力不足时，Core 应采用显式降级，而不是伪装成完整支持：

| 能力不足场景 | 处理策略 |
|---|---|
| 不支持 `publicWs` | 不满足当前 MVP market adapter 要求 |
| 不支持 `l1BookStream` / `fundingRateStream` | 不满足当前 MVP market adapter 要求 |
| 不支持 `fetchMarketInfo` | 不满足当前 MVP market adapter 要求 |
| 不支持 `fetchRisk` | 不满足当前 MVP 合约账户 adapter 要求；未来扩展到非合约账户时再重新评估 |
| 不支持 `fetchMarketBaseline` | market 在恢复期保持 `stale` / `reconciling`，直到新会话提供可信基线 |
| 不支持 `privateWs` / `accountStream` / `orderStream` | 不满足当前 MVP private data adapter 要求 |
| 不支持 `fetchOpenOrders` | 不满足当前 MVP 订单 adapter 要求 |
| 不支持 `fetchMyTrades` | 跳过 recent trades 回补，订单恢复退化为 open orders baseline + `fetchOrderById` |
| 不支持 `fetchOrderById` | unresolved order 更保守地维持待确认状态 |
| 不支持 `sequenceAware` | 不能依赖严格 gap 判定，只能结合 heartbeat / idle timeout 降级 |
| 不支持 `nativeClientOrderId` | 遇到 `REQUEST_OUTCOME_UNKNOWN` 时不能安全盲重试 |

## 10. 一致性验收清单

每个 adapter 接入 SDK Core 之前，至少需要通过这组最小验收：

| 验收项 | 通过标准 |
|---|---|
| 健康状态切换 | 能稳定产出 `healthy -> degraded -> reconnecting -> reconciling -> healthy` |
| 会话隔离 | 旧 `wsSessionId` 消息不会污染新会话 |
| order ready barrier | `subscribeOrders()` resolve 前，不伪装 open orders 已完成初始化 |
| 成交去重 | 同一成交从 private stream 与 reconcile 同时进入时，只对外交付一次 |
| 结果未知语义 | 提交后失联时明确抛出 `REQUEST_OUTCOME_UNKNOWN` |
| 严格参数校验 | `price`、`amount`、`positionSide`、`triggerPrice` 等前置校验不通过时直接返回 `VALIDATION_ERROR` |

## 11. 实现阶段建议

| 阶段 | 目标 |
|---|---|
| Phase 1 | 跑通 `MarketManager` 的订阅、缓存与 freshness |
| Phase 2 | 跑通 `OrderManager` 的命令、事件与恢复 |
| Phase 3 | 跑通 `AccountManager` 的快照、事件与状态 |
| Phase 4 | 增加更多 adapter 和一致性校验 |

建议优先策略：

| 优先级 | 建议 |
|---|---|
| 1 | 先用 CCXT Pro 跑通完整主流程 |
| 2 | 选择 1 个目标交易所实现 native adapter，验证统一合同 |
| 3 | native adapter 稳定后，再逐步替换高价值链路 |
