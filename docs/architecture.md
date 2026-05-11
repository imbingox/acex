# acex 架构文档

本文面向需要深入 SDK 的读者：做二次开发、接入新交易所、或排查复杂问题的工程师。用户手册见 [docs/api.md](./api.md)；规则性约定见 [.trellis/spec/backend/](../.trellis/spec/backend/)。

## 目录

1. [总览](#1-总览)
2. [调用的完整路径](#2-调用的完整路径)
3. [Market 数据通路](#3-market-数据通路)
4. [私有数据通路](#4-私有数据通路)
5. [ManagedWebSocket 状态机](#5-managedwebsocket-状态机)
6. [事件总线](#6-事件总线)
7. [Binance adapter 实现要点](#7-binance-adapter-实现要点)
8. [接入新交易所](#8-接入新交易所)

## 1. 总览

分层沿用 `.trellis/spec/backend/code-organization.md` 的 5 层模型：

```
Layer 4  公开 API       src/index.ts, src/errors.ts
Layer 3  编排层         src/client/{runtime,create-client,context,private-subscription-coordinator}.ts
Layer 2  领域层         src/managers/{market,account,order}-manager.ts
Layer 1  适配层         src/adapters/{types.ts, binance/*}
Layer 0  基础设施       src/internal/{async-event-bus,managed-websocket,filters}.ts
         类型定义       src/types/*（跨层共享）
```

一次 `start()` 后，runtime (`AcexClientImpl`，`src/client/runtime.ts:82`) 持有：

| 对象 | 角色 |
|---|---|
| `MarketManagerImpl` | 行情状态、订阅、事件 |
| `AccountManagerImpl` | 账户快照投影、事件 |
| `OrderManagerImpl` | 订单投影、交易命令、事件 |
| `PrivateSubscriptionCoordinator` | 每账户一条私有 stream 的编排器 |
| `marketAdapters` | `Map<Venue, MarketAdapter>`，当前注册 `BinanceMarketAdapter` |
| `privateAdapters` | `Map<Venue, PrivateUserDataAdapter>`，当前注册 `BinancePrivateAdapter` 与 `JuplendPrivateAdapter` |
| `healthBus` / `errorBus` | 跨域事件总线 |
| `registeredAccounts` | `Map<accountId, RegisteredAccountRecord>` |

**当前结构性边界**：`runtime.ts:105-113` 通过 `marketAdapters` / `privateAdapters` 两张 `Map<Venue, ...>` 注册表分派 adapter；`PrivateSubscriptionCoordinator` 按账户 venue 选择 private adapter，`createOrder` / `cancelOrder` 等命令通过 `getPrivateAdapter(venue)` 路由。Market 侧 registry 已经是 venue-aware，但当前只注册 Binance 一家；新增 market venue 只需把 adapter 加入 `marketAdapters` Map，并确认 manager 在分派时按 `key.venue` 取实例（当前 `MarketManagerImpl` 仍只持有单一 `MarketAdapter` 引用，跨 venue 之前需要切到从 registry 取）。

## 2. 调用的完整路径

### 2.1 `subscribeL1Book()`

```
调用方 ──► client.market.subscribeL1Book(key)
              │
              ▼
  MarketManagerImpl.subscribeL1Book
    ├── context.assertStarted()                  (CLIENT_NOT_STARTED gate)
    ├── ensureMarketsLoaded() (幂等)             adapter.loadMarkets()
    ├── getOrCreateRecord(key)                   MarketRecord (status='inactive' → 'active')
    └── startL1BookStream(record, market)
          │
          ▼
    adapter.createL1BookStream(market, callbacks, options)
          │
          ▼
    subscribeBinanceBookTicker(market, ...)      (src/adapters/binance/book-ticker.ts:74)
          │
          ▼
    createManagedWebSocket<BookTickerMessage>    (src/internal/managed-websocket.ts:47)
          │
   WebSocket open ─► 首条 message 到达
          │
   parseMessage → onMessage → callbacks.onBookTicker
          │                      + callbacks.onFreshnessChange("fresh")
          ▼
    MarketManagerImpl 回调：
      ├── 更新 record.l1Book
      ├── marketBus.publish(L1BookUpdatedEvent)
      └── 若首次 ready：marketStatusBus.publish(MarketStatusChangedEvent)
          │
          ▼
    ready promise resolve → subscribeL1Book() resolve (ready barrier 生效)
```

### 2.2 `subscribeAccount()`

```
调用方 ──► client.account.subscribeAccount({ accountId })
              │
              ▼
  AccountManagerImpl.subscribeAccount
    ├── context.assertStarted()
    ├── context.ensurePrivateCredentials(accountId)
    └── context.subscribePrivateAccountFeed(accountId)
          │
          ▼
    PrivateSubscriptionCoordinator.subscribeAccountFeed (src/client/private-subscription-coordinator.ts:64)
      ├── getOrCreateRecord(account)
      ├── record.accountSubscribed = true
      ├── ensureStream(record, account)          懒启动：若还没流才开
      │     │
      │     ▼
      │   adapter.createPrivateStream(...)       (binance/private-adapter.ts:629)
      │     ├── startUserDataStream → POST /papi/v1/listenKey
      │     ├── setInterval keepAliveUserDataStream（默认 30 分钟）
      │     └── createManagedWebSocket(readyWhen="open")
      │
      └── bootstrapAccount(record, account)
            │
            ▼
          adapter.bootstrapAccount → 并发拉 /papi/v1/balance + /account + /um/positionRisk
            │
            ▼
          consumer.onPrivateAccountBootstrap (AccountManagerImpl)
            │
            └── Binance: scheduleAccountRefreshPoll → refreshAccount(/account + /um/positionRisk)
            ├── 写入 record.balances/positions/risk（转 BigNumber）
            ├── accountBus.publish(AccountSnapshotReplacedEvent)
            └── status.ready=true, runtimeStatus='healthy'
```

### 2.3 `createOrder()`

```
调用方 ──► client.order.createOrder(input)
              │
              ▼
  OrderManagerImpl.createOrder
    ├── context.assertStarted()
    ├── 本地输入校验（type="limit" 必有 price、amount 必填）→ ORDER_INPUT_INVALID
    └── context.createOrder(input)
          │
          ▼
    AcexClientImpl.createOrder (runtime.ts)
      ├── getPrivateCommandAccount(accountId)  (CREDENTIALS_MISSING / VENUE_NOT_SUPPORTED gate)
      └── adapter.createOrder(credentials, request, accountOptions)
            │
            ▼
          BinancePrivateAdapter.createOrder (binance/private-adapter.ts)
            └── POST /papi/v1/um/order (signed)
                  → RawOrderUpdate（标准化）
          │
          ▼ (manager 回来之后)
    OrderManagerImpl.applyCommandResult
      ├── 本地 record.orders 插入 / 更新 snapshot
      ├── orderBus.publish(OrderUpdatedEvent)
      └── return OrderSnapshot（转 BigNumber）
```

后续 `events.updates()` 继续推送 `order.updated` / `order.filled` / `order.canceled`，源头是 private WS 的 `ORDER_TRADE_UPDATE`。命令 resolve 与 WS 事件两条路径都会写本地 cache，manager 做幂等合并。

## 3. Market 数据通路

### 3.1 记录与状态

每个 `(venue, symbol)` 对应一条 `MarketRecord`（`src/managers/market-manager.ts:41`）：

```ts
interface MarketRecord {
  venue: Venue;
  symbol: string;
  market?: MarketDefinition;           // catalog 加载后写入
  l1Book?: L1Book;                     // 最新快照
  fundingRate?: FundingRateSnapshot;   // 最新资金费率快照
  l1BookSubscribed: boolean;
  fundingRateSubscribed: boolean;
  l1Freshness?: "fresh" | "stale";
  l1Reason?: MarketDataStatus["reason"];
  fundingRateFreshness?: "fresh" | "stale";
  fundingRateReason?: MarketDataStatus["reason"];
  status: MarketDataStatus;
  l1BookStream?: StreamHandle;
  fundingRateStream?: StreamHandle;
}
```

每个快照自带一份 stream 级 `status`，例如 `L1Book.status` 只表示 L1 book stream，`FundingRateSnapshot.status` 只表示 funding rate stream。`MarketDataStatus` 是 `(venue, symbol)` 级聚合状态，用于 `events.status()` / `getHealth()` 兼容视图：任意 active stream stale，聚合状态也会 stale。

单条 stream 的状态生命周期：

```
[未订阅]
  │ subscribeL1Book() / subscribeFundingRate()
  ▼
activity="active", ready=false, freshness=undefined
  │ 首条 message
  ▼
activity="active", ready=true, freshness="fresh"
  │
  ├── heartbeat_timeout ─► freshness="stale", reason="heartbeat_timeout"
  │                          │
  │                          │ 新 message
  │                          ▼
  │                       freshness="fresh"
  │
  ├── WS 断开 ───────────► freshness="stale", reason="ws_disconnected"
  │                          │
  │                          │ ManagedWebSocket 重连 + 首条新 message
  │                          ▼
  │                       freshness="fresh"
  │
  └── unsubscribe*() ──► activity="inactive", 最后一份快照仍保留
```

### 3.2 freshness 的来源

freshness 变化完全由 adapter 回调驱动，manager 不会自己算 timeout：

- `callbacks.onFreshnessChange("fresh")` 来自每条 `onMessage`
- `callbacks.onFreshnessChange("stale", "heartbeat_timeout")` 来自 ManagedWebSocket watchdog
- `callbacks.onDisconnected()` 来自 WS close；manager 把它翻译成 `stale + ws_disconnected`

### 3.3 自动重连

调用方不需要手工处理重连。ManagedWebSocket 自带指数退避重连（见 §5），adapter 只在 onDisconnected 时通知 manager 状态变化，下一次成功 message 回到 `fresh`。manager 的 `record.l1Book` / `record.fundingRate` 不会被清空——重连期间旧快照仍可读（但对应快照的 `status.freshness = stale`），符合 "退订后的旧数据不是实时值" 的语义。

## 4. 私有数据通路

### 4.1 为什么 account / order 共享私有订阅协调器

Binance PAPI UM 的 user data stream 通过 `listenKey` 握手，一条 WS 同时推送 `ACCOUNT_UPDATE` 和 `ORDER_TRADE_UPDATE`；账户级 risk 与 mark-to-market 仓位字段另由 5s REST polling 校准。Juplend 不是 WS，而是 HTTP polling，但仍复用同一套 account update / status 通道。共享逻辑收敛在 `PrivateSubscriptionCoordinator`，按 `venue` 从 private adapter registry 选择实现。

如果让 `AccountManager` 和 `OrderManager` 各自开一条 Binance 连接：

- 两个 listenKey 占用配额
- 两份 keepalive 定时器
- 重连时机不同步

所以每个账户只持有一条 `PrivateSubscriptionRecord`，内部 stream 可以是 Binance WebSocket，也可以是 Juplend polling handle。Binance 的 risk polling 也挂在同一条 record 生命周期下，随 account unsubscribe / stop / remove 清理。

### 4.2 Coordinator 状态转换

```
[无 record]
  │ subscribeAccountFeed() 或 subscribeOrderFeed()
  ▼
record.{account,orders}Subscribed=true
  │
  │ ensureStream → adapter.createPrivateStream → stream ready
  ▼
record.stream 就绪
  │
  │ bootstrapAccount / bootstrapOrders（并发）
  ▼
consumer.onPrivateAccountBootstrap / onPrivateOrderBootstrap
  │
  ▼
稳态 (runtimeStatus="healthy")
  │
  ├── credentials 更新 ──► resumeRecord：closeStream → ensureStream → bootstrap
  ├── adapter.onDisconnected ──► ManagedWebSocket 重连 → onReconnected → resumeRecord（Binance）
  ├── adapter.onError ─────────► degraded + http_failed（Juplend polling）
  ├── removeAccount() ────────► closeStream + 删 record
  │
  └── 两端都 unsubscribe ─────► closeIfUnused：closeStream + 删 record
```

关键代码位点：

| 行为 | 位置 |
|---|---|
| 懒启动 | `subscribeAccountFeed` / `subscribeOrderFeed` (`:64` / `:93`) |
| 引用计数 | `isActive` (`:227`)、`closeIfUnused` (`:231`) |
| 凭证更新 | `onCredentialsUpdated` (`:161`) → `resumeRecord` (`:177`) |
| 账户移除 | `onAccountRemoved` (`:151`) |
| 重建流 | `resumeRecord` (`:177`) |

### 4.3 Binance listenKey 生命周期

listenKey 维护由 adapter 负责（`src/adapters/binance/private-adapter.ts:629-691`）：

```
adapter.createPrivateStream()
  │
  ├── POST /papi/v1/listenKey        (startUserDataStream :778)
  │     → listenKey
  │
  ├── setInterval(keepAliveUserDataStream, listenKeyKeepAliveMs)
  │     每次 PUT /papi/v1/listenKey  (默认 30 分钟一次)
  │
  ├── createManagedWebSocket({ url: wss://.../pm/ws/<listenKey>, readyWhen: "open" })
  │
  └── close():
        clearInterval(keepAliveTimer)
        DELETE /papi/v1/listenKey
        session.close()
```

**私有 stream 用 `readyWhen: "open"`**（`:685`）而不是 `"message"`。因为 listenKey 在 open 之前已经握手完成——ready barrier 就是"WS open 时流就可用"，不需要等第一条业务消息。

### 4.4 Bootstrap 与 WS update 的协作

Bootstrap 走 REST，WS update 是增量。两者都会写到 manager 的本地 cache，manager 层做幂等合并：

```
bootstrapAccount ──► onPrivateAccountBootstrap ──► 全量替换 balances/positions/risk
                                                    ↓
                                                AccountSnapshotReplacedEvent

WS ACCOUNT_UPDATE ──► adapter 解析 → onPrivateAccountUpdate → 部分字段覆盖
                                                              ↓
                                                       BalanceUpdatedEvent 等

Binance refreshAccount ──► /papi/v1/account + /papi/v1/um/positionRisk
                         └► onPrivateAccountUpdate → risk + position mark-to-market 覆盖
```

重连后先关流再重建；coordinator 的 `resumeRecord` 会在新流 open 后再跑一次 bootstrap，完成 reconcile（`private-subscription-coordinator.ts:177-192`）。

### 4.5 Juplend polling 生命周期

Juplend adapter 实现同一个 `PrivateUserDataAdapter`，但不创建 WebSocket：

```
registerAccount({
  accountId: "jup-loop-a",          // SDK 自定义账户名
  venue: "juplend",
  credentials: { apiKey },
  options: { walletAddress, positionId? },
})
  │
  ▼
subscribeAccount()
  │
  ├── bootstrapAccount()
  │     ├── GET api.jup.ag/portfolio/v1/positions/{walletAddress}?platforms=jupiter-exchange
  │     ├── GET lite-api.jup.ag/lend/v1/borrow/vaults  (TTL 1h)
  │     ├── data.link 抽取 vaultId / positionId
  │     ├── 可选 options.positionId 过滤单个 NFT position
  │     └── 按 asset 聚合 BalanceSnapshot.lending + 账户级 RiskSnapshot.riskRatio
  │
  └── createPrivateStream()
        └── setTimeout 串行调度：bootstrapAccount → onAccountSnapshot → schedule next
```

Juplend 每次 polling 结果都是全量账户快照，不是增量 update。成功 poll 必须走 `onAccountSnapshot` / `onPrivateAccountBootstrap` 的全量替换路径，确保 position 关闭、`positionId` 不再匹配、或某个 asset 消失时，旧的 balances / risk 会被清空。下一次 poll 只在上一次 poll settle 后调度，避免慢 HTTP 响应乱序覆盖新数据。

Juplend 失败语义：

- 缺 `credentials.apiKey`：订阅前凭证校验失败，抛 `CREDENTIALS_MISSING`
- 缺 `options.walletAddress`：bootstrap 失败，抛 `ACCOUNT_BOOTSTRAP_FAILED`
- HTTP/API 失败：账户状态进入 `runtimeStatus="degraded"`，`reason="http_failed"`
- `OrderManager` 命令不支持 Juplend；runtime 在命令入口拒绝，抛 `VENUE_NOT_SUPPORTED`

## 5. ManagedWebSocket 状态机

`createManagedWebSocket` 是所有 WS 流的统一入口（`src/internal/managed-websocket.ts:47`）。所有 adapter 都必须走这里，不允许直接 `new WebSocket`（见 [adapter-contract.md §3.8](../.trellis/spec/backend/adapter-contract.md#38-managedwebsocket-复用要求)）。

### 5.1 状态图

```
       ┌──────────┐
       │ closed   │◄──── close()
       └──────────┘
             ▲
             │ close()
             │
      ┌──────┴──────┐
      │             │
      │   stable    │
      │ (got first  │
      │  message/   │
      │  open)      │
      │             │
      └─────┬───────┘
            ▲
            │ first message / open
            │ (resolveReady)
            │
      ┌─────┴───────┐
      │ connecting  │
      └─────┬───────┘
            ▲
            │ new WebSocket(url)
            │
      ┌─────┴──────────────────────┐
      │ idle                        │
      │ (构造完成，首次 connect() ) │
      └────────────────────────────┘
```

稳态期间可能的子状态：

```
stable
  │
  ├── message（刷新 watchdog 计时）
  │
  ├── no message for staleAfterMs
  │       → messageWatchdog.onStale()
  │       → 转 "stale"（业务层可见），但 WS 本身不关
  │
  └── close (unexpected)
        → onUnexpectedClose(event)
        → scheduleReconnect()
              │
              ▼
        delay = min(initialDelayMs * multiplier^attempts, maxDelayMs)
              │
              ▼
        connect()（attempts+=1；收到新 message 后 attempts=0）
```

### 5.2 关键参数

| 参数 | 含义 | Market 默认 | Private 默认 |
|---|---|---|---|
| `initialMessageTimeoutMs` | 第一条 message / open 前的等待上限 | 15_000 | 15_000 |
| `staleAfterMs` | 稳态期间无消息触发 stale | 15_000 | —（private 用 WS 心跳） |
| `reconnectDelayMs` | 重连初始延迟 | 1_000 | 1_000 |
| `reconnectMaxDelayMs` | 指数退避上限 | 10_000 | 10_000 |
| `readyWhen` | `"message"` 或 `"open"` | `"message"` | `"open"` |

退避公式：`delay = min(initial * 2^attempts, max)`（`managed-websocket.ts:147-150`）。attempts 在 **每次 reject or close 后** +1；在 **第一条 message 到达时** 重置为 0（`:218`）。

### 5.3 手动 close 的语义

`session.close()`（`:268`）：

1. 设置 `closed=true`，后续所有回调一律 no-op
2. 清掉 initial / stale / reconnect 三种 timer
3. `activeSocket?.close(1000, "manual close")`

手动 close 不触发 `onUnexpectedClose`，也不触发重连——这是区分「业务退订」和「网络断开」的关键。

## 6. 事件总线

### 6.1 AsyncEventBus

`src/internal/async-event-bus.ts:12`。单个 bus 支持多消费者，每个 `stream(filter?)` 返回独立的 `AsyncIterable`：

- 内部 queue 按消费者隔离（每个 stream 一份独立 queue）
- 消息来得比消费快时进 queue；消费在 `next()` 里等 pendingResolve 时直接 bypass queue
- 消费者 `break` / `return` 迭代时，iterator 的 `return()` 会 close 这一份 listener，不影响其他消费者
- `bus.close()` 会同时终止所有消费者

### 6.2 层次关系

```
Market bus  ──► MarketManagerImpl.marketBus        → events.l1BookUpdates / fundingRateUpdates / all
Market status ─► MarketManagerImpl.marketStatusBus → events.status（market 级）
Account bus ──► AccountManagerImpl.accountBus      → events.updates（account 级）
Order bus   ──► OrderManagerImpl.orderBus          → events.updates（order 级）
            ──► AcexClientImpl.healthBus           → client.events.health (带 scope filter)
            ──► AcexClientImpl.errorBus            → client.events.errors
```

`healthBus` 是跨域聚合——manager status 发生变化时，manager 既会 publish 到自己的 status bus，也会经 `context.publishHealthEvent(...)` 转发到 runtime 的 healthBus。

### 6.3 背压

没有显式背压——queue 无上限。如果消费者卡死，内存会持续增长。实践中每个 manager 每秒消息数很少（L1 Book 可能较高，但也是 10-100 Hz 级），消费者只要正常 iterate 就不会堆积。长时间不消费时应该直接 `break` 让 iterator 释放。

## 7. Binance adapter 实现要点

### 7.1 市场家族路由

Binance 三套市场体系（Spot / USDⓈ-M / COIN-M）分别对应不同的 REST 和 WS base URL，在 `loadBinanceMarkets()` 里并发拉取再归一（`src/adapters/binance/market-catalog.ts:234`）：

| Family | REST ExchangeInfo | WS base |
|---|---|---|
| `spot` | `https://api.binance.com/api/v3/exchangeInfo` | `wss://stream.binance.com:9443/ws` |
| `usdm` | `https://fapi.binance.com/fapi/v1/exchangeInfo` | `wss://fstream.binance.com/ws` |
| `coinm` | `https://dapi.binance.com/dapi/v1/exchangeInfo` | `wss://dstream.binance.com/ws` |

每条 `BinanceMarketDefinition` 带 `family` 字段（adapter 内部使用，对外签名仅 `MarketDefinition`）。`createL1BookStream` 根据 `family` 选 WS base URL，URL 是 `<base>/<id>@bookTicker`。`createFundingRateStream` 仅支持 `usdm` / `coinm` 永续市场，URL 是 `<base>/<id>@markPrice@1s`，并把 Binance mark price stream 的 `r/p/i/T/E` 标准化为 `fundingRate/markPrice/indexPrice/nextFundingTime/exchangeTs`。

### 7.1.1 现状与 combined 优化取舍

当前实现对每个 market stream 采用独立 raw websocket：`l1book` 和 `funding rate` 分别建连，不做 combined stream 聚合，也不在一条连接上复用多个 symbol。这样做的好处是实现简单、状态隔离清晰，`subscribe/unsubscribe` 语义也直接；在当前“订阅 symbol 不多”的前提下，连接数和握手开销通常可接受。

后续如果订阅规模明显上涨，再考虑引入 Binance combined stream 或订阅池：

- 把同一 venue / family 下的多个 stream 合并到少量 websocket
- 在单连接内维护订阅表，支持动态 `SUBSCRIBE` / `UNSUBSCRIBE`
- 断线后重放订阅并恢复 ready / freshness 状态
- 兼容 Binance 单连接 stream 数量与连接频率限制

目前这条优化路径属于“有空间，但不是优先项”。

### 7.2 统一 symbol 构造

- 现货：`BASE/QUOTE`
- 永续：`BASE/QUOTE:SETTLE`
- 交割：`BASE/QUOTE:SETTLE-YYYYMMDD`

规则在 `buildFuturesSymbol`（`market-catalog.ts:110`）。Binance 的 `contractType === "PERPETUAL"` 映射到 `swap`；有 `deliveryDate` 映射到 `future`。

### 7.3 PAPI UM 端点

私有链路全部走 `https://papi.binance.com`：

| 用途 | 端点 |
|---|---|
| Balance bootstrap | `GET /papi/v1/balance` |
| Account bootstrap | `GET /papi/v1/account` |
| Position bootstrap | `GET /papi/v1/um/positionRisk` |
| Open orders bootstrap | `GET /papi/v1/um/openOrders` |
| 下单 | `POST /papi/v1/um/order` |
| 撤单 | `DELETE /papi/v1/um/order` |
| 批量撤单 | `DELETE /papi/v1/um/allOpenOrders` |
| listenKey lifecycle | `POST/PUT/DELETE /papi/v1/listenKey` |
| Private WS | `wss://fstream.binance.com/pm/ws/<listenKey>` |

签名：HMAC-SHA256 over `queryString + "timestamp=" + Date.now() + "&recvWindow=" + DEFAULT_RECV_WINDOW`（`private-adapter.ts:170`）。`recvWindow` 默认 5000，可通过 `accountOptions.recvWindow` 覆盖。

### 7.4 USDM 结算币推断

Binance USDⓈ-M 官方结算币是 `marginAsset`，但老版本 exchangeInfo 不带这个字段，fallback 到 `quoteAsset`。当前 adapter 通过 `USDM_QUOTE_ASSETS = ["FDUSD", "USDC", "BUSD", "USDT"]` 白名单兜底，避免把非稳定币当成结算币。

## 8. 接入新交易所

路径（详细规则见 [adapter-contract.md](../.trellis/spec/backend/adapter-contract.md)）：

1. **新建目录** `src/adapters/<venue>/`
2. **实现接口**
   - `<Venue>MarketAdapter implements MarketAdapter`（`adapter.ts` + `market-catalog.ts` + `*-stream.ts`）
   - `<Venue>PrivateAdapter implements PrivateUserDataAdapter`（`private-adapter.ts`）
3. **所有 WS 流必须走 `createManagedWebSocket`**，不允许直接 `new WebSocket`
4. **注册 adapter**：runtime 的 `marketAdapters` / `privateAdapters` 都是 `Map<Venue, ...>`。新增 venue 时把 adapter 加进对应 Map（`runtime.ts:105-113`），只读 venue 的 order 命令需要在 runtime 或 adapter 层显式拒绝（参考 `getPrivateCommandAccount` 对 juplend 的处理）。`MarketManagerImpl` 当前仍只持有单一 `MarketAdapter` 引用，跨 market venue 之前需要让 manager 改为按 `key.venue` 从 `marketAdapters` 取。
5. **测试**
   - 新 adapter 的单元测试放在 `tests/unit/`，覆盖 catalog 解析、symbol 规范化、消息映射等纯逻辑
   - 新交易所 fake infra 放在 `tests/support/exchanges/<venue>.ts`，复用 `tests/support/test-utils.ts` 的 `FakeWebSocket` / `nextEvent()` / response helper
   - 新交易所跨层 contract 放在 `tests/integration/`，参考现有 Binance 测试的 subscribe → event → getter → unsubscribe 模式
   - 长时间稳定性验证放在 `tests/soak/`，不要进入默认 `bun run test`
   - 新 live smoke 脚本 `scripts/live-<venue>-*.ts` + `package.json` script，不进入默认 CI
6. **文档**
   - 在 README「当前限制」更新支持的交易所列表
   - 在 `docs/api.md` §11 更新限制列表
   - 如需补规范（例如新交易所私有链路有特殊约束），加到 `.trellis/spec/backend/`

Manager 层本身不需要改动——Manager 通过 `ClientContext` 与 runtime 交互，不直接持有 adapter。只要 adapter 合约正确、registry 到位，manager 代码零改动即可多交易所工作。
