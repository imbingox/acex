# Order Execution

## Scenario: Binance PAPI UM 交易命令第一版 contract 必须稳定

### 1. Scope / Trigger

- Trigger: 新增或修改 `createOrder()` / `cancelOrder()` / `cancelAllOrders()`、调整 Binance private adapter 下单字段、修改订单命令与本地缓存同步语义时。
- 目标: 保持 public contract、runtime 透传、Binance 持仓模式约束和 live smoke 验证路径一致。

### 2. Signatures

当前第一版公开签名：

```ts
// src/types/order.ts
export interface OrderManager {
  createOrder(input: CreateOrderInput): Promise<OrderSnapshot>;
  cancelOrder(input: CancelOrderInput): Promise<OrderSnapshot>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<OrderSnapshot[]>;
}

export type CreateOrderInput = CreateLimitOrderInput | CreateMarketOrderInput;

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
```

跨层内部签名：

```ts
// src/client/context.ts
createOrder(input: CreateOrderInput): Promise<RawOrderUpdate>;
cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate>;
cancelAllOrders(input: CancelAllOrdersInput): Promise<RawOrderUpdate[]>;

// src/adapters/types.ts
createOrder(
  credentials: AccountCredentials,
  request: CreateOrderRequest,
  accountOptions?: Record<string, unknown>,
): Promise<RawOrderUpdate>;
```

Binance 第一版 REST 落点固定为：

```text
POST   /papi/v1/um/order
DELETE /papi/v1/um/order
DELETE /papi/v1/um/allOpenOrders
```

### 3. Contracts

#### 3.1 交易命令范围

- 第一版只支持 **Binance PAPI UM**。
- `createOrder()` 只支持 `limit` / `market`。
- `cancelOrder()` 必须带 `accountId + symbol`，并且 `orderId` / `clientOrderId` 至少一项存在。
- `cancelAllOrders()` 必须带 `accountId + symbol`，不支持账户级全撤。

#### 3.2 `positionSide` 与账户持仓模式

- SDK **不会替调用方自动推断账户是单向还是双向持仓模式**。
- 单向持仓模式：
  - 调用方可以省略 `positionSide`
  - Binance 返回和后续 WS snapshot 应归一成 `positionSide: "net"`
- 双向持仓模式（hedge mode）：
  - 调用方必须显式传 `positionSide: "long" | "short"`
  - 省略或传错方向时，交易所会拒单

#### 3.3 REST 结果与本地状态同步

- `createOrder()` / `cancelOrder()` resolve 的结果来自 **REST 成功响应标准化后的 `OrderSnapshot`**；`cancelAllOrders()` 的结果是 **预取合成**（见 3.5），DELETE 响应本身不含订单。
- Manager 必须在命令成功后，先把 REST 返回更新应用到本地 order cache。
- 命令回包入库必须记录发起命令前的 `requestStartedAt`，并以 `source: "command"` 走 watermark 门控：
  - 若已有本地 snapshot 的 `receivedAt > requestStartedAt`，且 command 回包或已有 snapshot 任一缺少 `exchangeTs`，命令回包不得覆盖本地状态；
  - 若已有本地 snapshot 早于命令请求，且 command 回包缺少 `exchangeTs`（例如 `cancelAllOrders()` 合成 canceled），允许命令回包按 `receivedAt` 入库，不能被通用 REST snapshot 的跨时钟 grace 误拦；
  - 若两边都有 `exchangeTs`，仍按 `exchangeTs` 单调水位判断，较旧命令 ack 不能覆盖较新 WS / reconcile 状态。
- 同一订单生命周期合并必须单调：`filled` 数量不得回退；`filled` 被保留为更大历史值时，`remaining` 必须随之重算或等价 clamp，不能继续信任较旧 incoming 的 `remaining`；`filled` / `canceled` / `expired` / `rejected` / `unknown` 等终态不得被后到的低优先级 `open` / `partially_filled` 回退。`unknown` 是 SDK 合成的保守终态；后续若交易所给出更具体的 filled/canceled/expired/rejected 终态，允许继续收敛到真实终态。
- private WS 后续到来的 `order.updated` / `order.canceled` / `order.filled` 事件，是生命周期变化流，**不是命令 ack 的唯一来源**。
- Binance private REST reconcile 不能把 `/papi/v1/um/openOrders` 当作订单生命周期真源；它只能作为 current open set 检测。某个本地 open order 从 REST open set 消失时，必须用 `/papi/v1/um/order`（或后续 `allOrders` 窗口回补）证明终态后再发布 `order.filled` / `order.canceled` / `order.rejected` / `order.updated`。
- 如果终态回补返回 filled/canceled/expired/rejected，必须应用真实终态。若 `fetchOrder` 明确返回 `undefined`（例如 Binance -2011/-2013，交易所确认不存在），不得伪造成 filled/canceled/expired；由 OrderManager 按 `CreateClientOptions.order.missingOrderEvictionThreshold`（默认 3）记录连续确认缺失次数，达到阈值后将订单置为 `status: "unknown"`、移入 closed、发布终态订单事件和一次明确 runtime error。网络/超时/限流等 transport 错误不计数，继续按 reconcile 错误路径标记 degraded。
- 初始 order bootstrap、周期性 reconcile、WS reconnect reconcile 都必须走同一套 open-set + lifecycle backfill 语义，不能再用 openOrders 全量替换直接丢弃已有终态订单。

#### 3.3.1 symbol-miss 与 catalog 刷新契约

- 命令侧 `toVenueId` miss 必须视为 pre-flight 失败：adapter 抛 typed `SymbolMappingError`，OrderManager 对外失败结果必须保持 `orderState: "not_placed"`。如果本地已登记 pending claim（例如生成 `newClientOrderId` 后才发现 catalog 预热失败），必须在失败路径清掉该 claim，不能让后续 reconcile 误认为存在未知 ack。
- 命令侧 catalog 预热失败同样属于 pre-flight：不得发 REST 下单 / 撤单请求，不得写入订单缓存；错误按命令失败包装，但 `orderState` 仍为 `"not_placed"`，pending claim 必须清理。
- 入站 `toUnified` miss（WS raw 帧 / REST openOrders / fetchOrder / account position）不得把 venue raw symbol 写入主状态。订单存储按 unified `symbol` 建 location key，写 raw id 会分裂 openOrders、pending claim 与 reconcile 身份。
- WS raw 帧的 order / position miss 必须进入有界 raw quarantine，然后触发 catalog refresh（按 family single-flight）。refresh 成功后 replay 原始帧；order replay 必须保留原始 `trade` / `fee` / `realizedPnl` 字段，不能降级为 REST 回查结果。
- WS replay 后仍 miss 时才 drop，并发布去重 runtime error（按 venue/family/raw symbol/reason 去重）。drop 同时触发一次 immediate private reconcile，用 REST account/open orders 把可恢复状态收敛回来；但该 reconcile 不能替代 replay，因为 REST `fetchOrder` 补不回逐笔成交、手续费和 realized PnL。反向约束：replay 全部成功（无 drop）时**不得**触发该 reconcile，也不得把 account/order runtimeStatus 翻成 pending——新上币的正常事件流不应产生状态闪断。
- miss-refresh cooldown 只约束"refresh 成功但 symbol 仍不存在"的重复刷新；catalog refresh 本身失败（网络 / 5xx）不得消耗整个 cooldown，必须按更短的 failure backoff 重试（默认 `min(cooldown, 5s)`），否则一次瞬时 exchangeInfo 故障会把被隔离的成交 replay 拖满 30s。
- symbol-miss runtime error 的去重 key 在该 symbol 重新可映射（出现在新 catalog 快照中）后必须重置：之后再次 miss 要重新上报，不允许进程级永久抑制。
- REST 路径（bootstrap / refresh / reconcileAccount / openOrders / fetchOrder）已持有响应数据，不进入 raw quarantine；catalog refresh 后必须对同一响应 inline 重映射，仍 miss 才 drop 该条记录并 report runtime error，且不得写入 raw symbol。

#### 3.4 精度与最小名义金额

- SDK 第一版只做字段透传，不自动帮调用方修正 `price` / `amount`。
- 调用方或 smoke 脚本在发单前，必须结合 `MarketDefinition` 处理：
  - `priceStep`
  - `amountStep`
  - `minAmount`
  - `minNotional`

#### 3.5 `cancelAllOrders()` venue 响应形状与合成语义

- `DELETE /papi/v1/um/allOpenOrders` 的成功响应是 **`{"code": 200, "msg": "..."}` 对象，不是订单数组**（与 fapi 同形；官方文档已核实）。任何按数组解析该响应的实现都是错误的，live 必抛 `TypeError`。
- adapter 合成流程固定为三步：
  1. `GET /papi/v1/um/openOrders?symbol=...` 预取待撤订单（幂等读，可重试）；
  2. `DELETE /papi/v1/um/allOpenOrders?symbol=...`（不可重试）；响应 `code` 存在且 `${code} !== "200"` 时视为失败；
  3. 把预取订单覆盖为 `status: "canceled"`、`receivedAt` 取 DELETE 成功后的时刻、`exchangeTs: undefined`（合成更新不得伪造交易所时间戳）后返回。
- 预取为空时仍要执行 DELETE（幂等），并返回 `[]`。
- 已知取舍：①、② 之间成交的订单会被短暂合成为 canceled，由 WS 终态事件 / reconcile 纠正。

### 4. Validation & Error Matrix

| 场景 | 约定 |
|---|---|
| 未 `start()` 就调用交易命令 | 直接失败 |
| `accountId` 未注册 | 直接失败 |
| 私有凭证缺失 | 直接失败 |
| `limit` 单缺少 `price` | 本地校验失败，抛 `ORDER_INPUT_INVALID` |
| `cancelOrder()` 缺少 `orderId` 与 `clientOrderId` | 本地校验失败，抛 `ORDER_INPUT_INVALID` |
| Binance 双向持仓模式下省略或传错 `positionSide` | 交易所拒单；SDK 对外包装为 `ORDER_CREATE_FAILED` |
| `price` / `amount` 不满足交易所精度或最小名义金额 | 交易所拒单；SDK 对外包装为对应命令失败 |
| REST 成功但 WS 更新稍后才到 | 命令先返回规范化 snapshot，本地缓存先更新，后续 WS 再收敛 |
| `cancelAllOrders()` 在目标 symbol 没有活跃订单 | 返回 `OrderSnapshot[]`，允许为空 |
| `DELETE um/allOpenOrders` 响应 `code` 存在且非 200/"200" | adapter 抛错，SDK 对外包装为 `ORDER_CANCEL_ALL_FAILED`（HTTP 层失败仍经 `TransportError.rawBody` 透出 `venueError`） |
| REST openOrders 缺少本地 open order 且 `queryOrder` 返回 filled/canceled | 应用终态，`getOpenOrders()` 不再返回该订单，`getOrder()` 仍可读终态 |
| REST openOrders 缺少本地 open order 且单笔查询连续确认 not found/retention miss | 达到阈值后终态化为 `unknown`，移出 open，保留可查询的 closed snapshot，并发布 runtime error；未达阈值时保持 open |
| REST openOrders 缺少本地 open order 但单笔查询发生网络/超时/限流错误 | 不计入缺失阈值；保留原 open snapshot，order status 标记 `degraded` |
| 较旧 REST/WS/order bootstrap 更新到达 | 不能覆盖较新的 command ack / WS / reconcile 状态；terminal status 不被 open 覆盖，filled 数量不倒退 |
| WS `ORDER_TRADE_UPDATE` 先于 REST 下单 ack 到达 | 若 WS 已推进到 filled/canceled 等更新状态，REST ack 不得把缓存或返回 snapshot 回退成 open，也不得发布回退事件 |
| `cancelAllOrders()` 合成更新缺少 `exchangeTs` | 若本地订单状态早于命令请求，合成 canceled 可以入库；若命令期间已有更新到达且时间戳不足以比较，合成更新不得覆盖 |

### 5. Good / Base / Bad Cases

#### Good

单向持仓模式下：

```ts
await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71830.6",
  amount: "0.001",
});
```

双向持仓模式下：

```ts
await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71900.9",
  amount: "0.001",
  positionSide: "long",
});
```

#### Base

可以只用 `clientOrderId` 做撤单定位，前提是调用方自己保证其唯一性：

```ts
await client.order.cancelOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  clientOrderId: "my-order-1",
});
```

REST openOrders 对账可以发布 `order.snapshot_replaced` 表示当前 open set 已校准，但该事件不是终态证明。终态仍必须来自 lifecycle update：

```ts
// Base: open set 缺口触发单笔终态查询，成功后发布 order.filled
await adapter.fetchOpenOrders(credentials);
await adapter.fetchOrder(credentials, {
  symbol: "BTC/USDT:USDT",
  orderId: "1001",
});
```

#### Bad

```ts
await client.order.createOrder({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
  side: "buy",
  type: "limit",
  price: "71900.9",
  amount: "0.001",
  // hedge mode 账户里这里省略了 positionSide
});
```

问题：

- SDK 不知道账户当前是单向还是双向持仓模式
- hedge mode 下这会直接被 Binance 拒单

```ts
// 错误：把 openOrders 缺失直接解释成取消/成交
if (!openOrderIds.has(localOrder.orderId)) {
  localOrder.status = "canceled";
}
```

问题：

- `/papi/v1/um/openOrders` 只说明订单当前不再 open，不说明最终是 filled、canceled、rejected 还是 expired。
- 合成错误终态会污染 `getOrder()` 和下游成交/撤单逻辑。

### 6. Tests Required

每次改交易命令 contract 或 Binance 下单字段，至少执行：

```bash
bun run test
bun run type-check
```

断言重点：

- `tests/integration/order.test.ts`
  - `createOrder()` 成功时返回规范化 snapshot
  - `cancelOrder()` / `cancelAllOrders()` 成功时返回规范化 snapshot
  - `cancelAllOrders()`：预取 GET 与 DELETE 都带 `symbol` query；`{code,msg}` 对象响应被正确解析；返回 snapshot 全部 `canceled` 且仅含目标 symbol；预取为空时返回 `[]` 且 DELETE 仍发出
  - `cancelOrder()` 缺少双标识时本地校验失败
  - 漏 WS 终态时，REST open set 缺口必须触发单笔终态查询，最终 `getOpenOrders()` 清理、`getOrder()` 保留终态。
  - 终态查询连续确认 not found/retention miss 达到 `missingOrderEvictionThreshold` 时，订单终态化为 `unknown`、离开 `getOpenOrders()`、保留在 `getOrder()`，并只发布一次 runtime error；网络错误不推进计数、不驱逐。
  - command ack 后较旧 WS/bootstrap/reconcile 更新不得倒灌；WS filled 先于 REST ack 到达时，REST ack 不得把订单回退为 open，也不得发布 `order.updated(open)` 回退事件。
  - `cancelAllOrders()` 合成的 `exchangeTs: undefined` command 更新在无更新水位冲突时仍能入库；有更新水位冲突时不得覆盖。
  - filled 数量不倒退，remaining 与被保留的 filled 数量一致，terminal / 高优先级状态不被低优先级状态回退。
  - createOrder timeout 保留的 pending claim 超过 `pendingClaimTtlMs` 后会在 reconcile 周期用 `fetchOrder(clientOrderId)` 回查；查到订单则入库并清 claim，确认不存在则清 claim 并发 runtime error，transport 错误保留 claim。
- live smoke
  - 单向持仓模式：不传 `positionSide`，以偏离 L1 5% 的 `LIMIT` 单真实挂单再撤单
  - 双向持仓模式：显式传 `positionSide`，跑同样的真实挂撤单
  - 断言 `order.updated` 和 `order.canceled` 事件都能收到
  - 断言最终 `getOpenOrders()` 中不残留测试单
  - `--cancel-all`（默认关闭）：挂 2 笔远离盘口 postOnly 单 → `cancelAllOrders()` → 断言返回 ≥2 且 `getOpenOrders()` 清空；目标 symbol 已有挂单时必须拒绝执行

> **Warning**: 测试夹具必须按 **venue 官方文档的响应示例** 构造，禁止按现有代码的假设反推。本 scenario 的历史教训：`DELETE um/allOpenOrders` 夹具曾按代码错误假设 mock 成订单数组，186 个测试全绿但 live 必崩。

### 7. Wrong vs Correct

#### Wrong

```ts
// 对所有 Binance 账户都盲目省略或硬编码 positionSide
await client.order.createOrder({
  accountId,
  symbol,
  side: "buy",
  type: "limit",
  price,
  amount,
});
```

问题：

- 单向模式下这可能碰巧可用
- 但一旦账户切到 hedge mode，就会直接变成交易所拒单

#### Correct

```ts
// 调用方先明确账户模式，再决定是否传 positionSide
await client.order.createOrder({
  accountId,
  symbol,
  side: "buy",
  type: "limit",
  price,
  amount,
  positionSide: isHedgeMode ? "long" : undefined,
});
```

效果：

- 单向模式仍保持最小输入
- 双向模式不会因为缺少 `positionSide` 被 Binance 拒单

#### Wrong — openOrders 直接替换订单缓存

```ts
record.snapshots = new Map(openOrders.map((order) => [order.orderId, order]));
```

问题：

- 会清掉已经成交/撤销的终态订单，导致 `getOrder()` 查不到最终状态。
- 不能区分 REST open set 缺口、Binance retention miss 和真实终态。

#### Correct — open set detection + lifecycle backfill

```ts
const disappeared = diffLocalOpenOrders(localOpenOrders, restOpenOrders);
for (const order of disappeared) {
  const terminal = await adapter.fetchOrder(credentials, order);
  if (terminal) {
    orderManager.onPrivateOrderUpdate(accountId, venue, terminal);
  } else {
    orderManager.onPrivateOrderConfirmedMissing(accountId, venue, order);
  }
}
```

效果：

- `getOpenOrders()` 在真实终态或达到 confirmed-missing 阈值后收敛。
- `getOrder()` 仍保留可证明的最终订单状态；无法证明真实终态时只使用 `unknown`。
- transport 错误不推进缺失计数，避免网络故障驱逐真实 open 单。

#### Wrong — 把 `allOpenOrders` 响应当订单数组

```ts
const responses = await this.signedRequest<BinancePapiOpenOrder[]>(
  "DELETE",
  "/papi/v1/um/allOpenOrders",
  ...
);
return responses.flatMap((response) => mapOpenOrder(response, receivedAt));
```

问题：

- 真实响应是 `{code, msg}` 对象，`flatMap` 在 live 上必抛 `TypeError`，被包装成 `ORDER_CANCEL_ALL_FAILED`——而交易所侧已全撤成功，调用方看到"撤单失败"假象。

#### Correct — 对象解析 + 预取合成

```ts
const openOrders = await this.signedRequest<BinancePapiOpenOrder[]>(
  "GET", "/papi/v1/um/openOrders", credentials, accountOptions,
  { symbol }, SAFE_READ_RETRY_POLICY,
);
const response = await this.signedRequest<BinancePapiCancelAllResponse>(
  "DELETE", "/papi/v1/um/allOpenOrders", credentials, accountOptions,
  { symbol }, NO_RETRY_POLICY,
);
if (response.code !== undefined && `${response.code}` !== "200") {
  throw new Error(`... code=${response.code}, msg=${response.msg ?? ""}`);
}
const receivedAt = Date.now();
return openOrders.flatMap((order) => {
  const mapped = mapOpenOrder(order, receivedAt);
  return mapped
    ? [{ ...mapped, status: "canceled", exchangeTs: undefined, receivedAt }]
    : [];
});
```

效果：

- 撤单成功与失败的判定基于真实响应契约；返回的 canceled snapshot 携带 venue identity，可被本地缓存与后续 WS/reconcile 正常收敛。

---

## Scenario: `order.trade` 逐笔成交事件承载手续费与 realized PnL

### 1. Scope / Trigger

- Trigger: 修改 `RawOrderUpdate`、`OrderEventStreams`、Binance `ORDER_TRADE_UPDATE` 映射、OrderManager 私有订单更新路径，或新增成交明细/手续费/realized PnL 字段时。
- 目标: 让策略层按逐笔成交核算 fee、成交价量与 realized PnL，同时保持 `OrderSnapshot` 只表达订单生命周期状态。

### 2. Signatures

```ts
// src/adapters/types.ts
export interface RawOrderTrade {
  tradeId?: string;
  price: string;
  qty: string;
  fee?: { cost: string; asset: string };
  realizedPnl?: string;
  maker?: boolean;
  positionSide?: PositionSide;
}

export interface RawOrderUpdate {
  // existing order lifecycle fields...
  trade?: RawOrderTrade;
}
```

```ts
// src/types/order.ts
export interface OrderTrade {
  tradeId?: string;
  price: string;
  qty: string;
  fee?: { cost: string; asset: string };
  realizedPnl?: string;
  maker?: boolean;
  positionSide?: PositionSide;
  exchangeTs?: number;
  receivedAt: number;
}

export interface OrderTradeEvent extends OrderEventBase {
  type: "order.trade";
  side: OrderSide;
  orderId?: string;
  clientOrderId?: string;
  trade: OrderTrade;
  seq: number;
  orderSeq?: number;
}

export interface OrderEventStreams {
  updates(filter?, options?: BufferedEventStreamOptions): AsyncIterable<OrderEvent>;
  trades(filter?, options?: BufferedEventStreamOptions): AsyncIterable<OrderTradeEvent>;
  status(filter?, options?: BufferedEventStreamOptions): AsyncIterable<OrderStatusChangedEvent>;
}
```

### 3. Contracts

- `OrderSnapshot` 公开字段不挂 fee、realizedPnl、lastFill 或 trades 数组；REST per-order 查询天然不返回这些字段，下游按 `order.trade` 事件用 `orderId` / `clientOrderId` 自行 fold。
- Binance `ORDER_TRADE_UPDATE` 只有在 `x === "TRADE"` 且 `Number(l) > 0` 时生成 `RawOrderUpdate.trade`；非 TRADE 执行类型与 `l=0` 只更新订单状态，不产生成交事件。
- `fee.cost` 允许 `"0"` 和负值；只有 `n` 与 `N` 都存在时填写 `fee`，`N` 缺失时省略整个 `fee`，不能用 truthy 判断丢掉零手续费。
- adapter 不做成交去重、不维护累计 fee / realizedPnl；OrderManager 按每个 `OrderRecord` 的 `(symbol, tradeId)` 组合键有界 seen-set 去重，上限固定 1024，FIFO 淘汰。去重键**必须含 symbol**：Binance 期货 `tradeId` 仅在单个 symbol 内递增、非 account 全局唯一，裸 `tradeId` 会把不同 symbol 的同号成交误判重复而漏发。`tradeId` 缺失时不去重，直接发布。
- `onPrivateOrderUpdate()` 中 trade 发布必须独立于快照 watermark：即使 `applyUpdateToRecord()` 因乱序/旧 update 返回 `undefined`，只要 raw `update.trade` 存在且未被 `tradeId` 去重，仍发布 `order.trade`。
- `OrderTradeEvent.seq` 是该 account+venue record 的单调 trade 序号，用于下游检测 buffer overflow 或消费 gap；`orderSeq` 在同一 raw update 成功写入订单快照时等于 `OrderSnapshot.seq`，快照被 watermark 拒绝时保持 `undefined`。
- `events.order.trades()` 与 order/account/status 一样只暴露 `{ maxBuffer?: number }`，使用 `AsyncEventBus` buffer 语义；慢消费者溢出时 drop oldest，并通过 `EVENT_BUFFER_OVERFLOW` runtime error 上报 `stream: "order.trades"`。

### 4. Validation & Error Matrix

| 场景 | 约定 |
|---|---|
| Binance WS `x=TRADE,l>0,n/N/l/L/rp/m/ps` | 发布一条 `order.trade`，字段 canonical 化，含 `positionSide` / `receivedAt` / `seq` / `orderSeq` |
| Binance WS 非 TRADE（NEW/CANCELED/EXPIRED 等） | 不发布 `order.trade`，`updates()` 行为不变 |
| Binance WS `x=TRADE,l=0` | 不发布 `order.trade` |
| 重复 `tradeId`（同 symbol） | 只发布第一条，后续重复丢弃且不推进 trade `seq` |
| 不同 symbol 的相同 `tradeId` | 各自发布，互不去重（去重键含 symbol） |
| `tradeId` 缺失 | 不去重，每条都发布 |
| 乱序成交 update 被 snapshot watermark 拒绝 | `order.trade` 仍发布，`orderSeq` 为 `undefined`，本地 `OrderSnapshot` 不回退 |
| `fee.cost` 为 `"0"` 或负值 | 保留 fee，不丢字段 |
| REST create/fetch/openOrders 来源 | 不含 `trade`，不发布 `order.trade`，不报错 |
| `events.order.trades({ symbol }, { maxBuffer })` 慢消费溢出 | 丢最旧 trade，发布一次 `EVENT_BUFFER_OVERFLOW`，`seq` 可用于检测缺口 |

### 5. Good / Base / Bad Cases

#### Good

```ts
for await (const event of client.order.events.trades({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
})) {
  console.log(event.orderId, event.trade.qty, event.trade.fee?.cost);
}
```

#### Base

`order.updated` / `order.filled` 继续只表达订单生命周期和累计 `filled` / `remaining`；策略需要手续费成本时订阅 `order.trade` 并按 `orderId` 聚合。

#### Bad

把 `n/N/rp` 塞进 `OrderSnapshot` 的末笔字段或累计字段。这样会在 REST-only 快照缺字段、终态事件不带 fee、手续费资产跨笔变化时产生歧义，并让慢消费者无法恢复丢失的逐笔流水。

### 6. Tests Required

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- Binance 映射覆盖 `x/t/l/L/n/N/rp/m/ps`，且 decimal string canonical 化。
- `events.order.trades()` 端到端发布，支持 accountId / venue / symbol 过滤。
- 非 TRADE、`l=0`、REST-only 路径不发布 trade。
- 重复 `tradeId` 去重，缺失 `tradeId` 不去重。
- 乱序 update 被 watermark 拒绝时仍发布 trade，且 snapshot 不回退。
- `fee.cost` 为 `"0"` 或负值时保留。
- trades 流 buffer overflow 走 `EVENT_BUFFER_OVERFLOW`，`seq` 单调。

### 7. Wrong vs Correct

#### Wrong

```ts
const snapshot = this.applyUpdateToRecord(record, accountId, venue, update);
if (!snapshot) return;
if (update.trade) this.tradesBus.publish(toTradeEvent(update, snapshot.seq));
```

问题：旧成交 update 会被快照 watermark 一起拦掉，策略层丢失真实成交。

#### Correct

```ts
const snapshot = this.applyUpdateToRecord(record, accountId, venue, update);
this.publishOrderTradeEvent(record, update, snapshot);
if (!snapshot) return;
this.publishOrderEvent(accountId, venue, snapshot);
```

效果：快照仍保持单调不回退，逐笔成交作为事实流水独立发布；能写入快照时用 `orderSeq` 关联，不能写入时仍保留 trade。

## Scenario: `client.fee` 账号级 symbol 手续费费率查询

### 1. Scope / Trigger

- Trigger: 新增或修改 `FeeManager`、`client.fee.getSymbolFeeRate()`、`client.fee.fetchSymbolFeeRate()`、adapter fee fetch hook、venue fee capability、或 Binance PAPI UM commission rate 映射时。
- 目标: 下游能按账号和 unified symbol 查询 maker / taker 交易费率，同时不把“费率查询”和“已发生手续费流水”混淆。

### 2. Signatures

```ts
export interface GetSymbolFeeRateInput {
  accountId: string;
  symbol: string;
}

export interface SymbolFeeRate {
  accountId: string;
  venue: Venue;
  symbol: string;
  marketType: MarketType;
  maker: string;
  taker: string;
  source: "default" | "venue";
  receivedAt: number;
}

export interface FeeManager {
  subscribe(input: SubscribeFeeRatesInput): Promise<void>;
  unsubscribe(input: UnsubscribeFeeRatesInput): Promise<void>;
  getSymbolFeeRate(input: GetSymbolFeeRateInput): SymbolFeeRate;
  getSymbolFeeRates(accountId?: string): SymbolFeeRate[];
  fetchSymbolFeeRate(input: GetSymbolFeeRateInput): Promise<SymbolFeeRate>;
}

interface FeeAdapterSurface {
  fetchSymbolFeeRate?(
    credentials: AccountCredentials,
    request: { symbol: string },
    accountOptions?: Record<string, unknown>,
  ): Promise<{ symbol: string; maker: string; taker: string; receivedAt: number }>;
}
```

`VenueOrderCapabilities.fees` 是当前 runtime flag，必须声明该 venue runtime 是否具备账号级 symbol fee rate 真实远端查询能力。它是允许 `client.fee.fetchSymbolFeeRate()` 和后台远端刷新队列的必要条件，不是唯一条件：FeeManager 还必须按 `marketType` 做支持矩阵校验。当前 Binance 真实远端查询只支持 `marketType: "swap"`；即使 `fees === "supported"`，spot / future 也只能由 `getSymbolFeeRate()` 返回默认值，显式 `fetchSymbolFeeRate()` 必须抛 `VENUE_NOT_SUPPORTED`。

### 3. Contracts

- `client.fee.getSymbolFeeRate()` 是同步本地 read API：解析 `accountId`，未维护 symbol 自动加入 FeeManager 维护集合并返回默认费率；它不直接发 REST，不登记 pending claim，不更新订单缓存，不产生 order event。
- `client.fee.fetchSymbolFeeRate()` 是账号级 private remote read API：必须先 `assertStarted()`、解析 `accountId`、校验私有凭证；成功后写回 FeeManager cache，后续 `getSymbolFeeRate()` 返回 `source: "venue"`。
- Public input 使用 unified symbol（例如 `BTC/USDT:USDT`）；adapter 内部负责转换成 venue symbol（例如 Binance PAPI UM `BTCUSDT`）。
- Public output 的 `maker` / `taker` 必须是 canonical decimal string；`receivedAt` 是 SDK 本地收到 REST 响应附近的墙钟时间，必须在 adapter 的 `signedRequest()` resolve 之后采集，不能在 symbol mapping 或 REST 请求前预采样。
- Binance 第一版落点固定为 `GET /papi/v1/um/commissionRate`，query 包含 `symbol`、`timestamp`、`recvWindow`、`signature`，返回 `makerCommissionRate` / `takerCommissionRate`。
- Binance commission rate 权重是 20，必须有独立 `BINANCE_RATE_LIMIT_PLANS.papiCommissionRate`，不能复用 query order / open orders plan。
- 已发生手续费金额仍通过 `events.order.trades()` 的 `OrderTrade.fee` 消费；如果下游要按 symbol 汇总已发生手续费，应该 fold `order.trade`，不要从 `client.fee.getSymbolFeeRate()` 推导。

### 4. Validation & Error Matrix

| 场景 | 约定 |
|---|---|
| `client.fee.getSymbolFeeRate()` 且 client 未 started | 本地返回/创建维护记录；实际刷新等 start 后执行 |
| `client.fee.fetchSymbolFeeRate()` 且 client 未 started | 抛 `CLIENT_NOT_STARTED` |
| `accountId` 未注册 | 抛 `ACCOUNT_NOT_FOUND` |
| 私有凭证缺失 | `get` 返回默认值；`fetch` 抛 `CREDENTIALS_MISSING`；后台发布 `source: "fee"` runtime error |
| venue `fees` unsupported 或 adapter fee fetch hook 未实现 | `get` 返回默认值；`fetch` 抛 `VENUE_NOT_SUPPORTED`，message 指向 symbol fee rate queries |
| Binance symbol mapping miss / catalog 预热失败 | 不发 REST，由 FeeManager 包装为 `FEE_RATE_FETCH_FAILED` |
| Binance REST 4xx/5xx/timeout/network/parse | 由 `httpRequest` 抛脱敏 `TransportError`，FeeManager 包装为 `FEE_RATE_FETCH_FAILED`；不填写 `orderState` |
| Binance 响应缺少 maker/taker rate | adapter 抛普通 `Error`，FeeManager 包装为 `FEE_RATE_FETCH_FAILED` |
| 费率为 `"0.00020000"` | public 输出 canonical 化为 `"0.0002"` |

### 5. Good / Base / Bad Cases

#### Good

```ts
await client.fee.subscribe({
  accountId: "main-binance",
  symbols: ["BTC/USDT:USDT"],
});

const cached = client.fee.getSymbolFeeRate({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});

const feeRate = await client.fee.fetchSymbolFeeRate({
  accountId: "main-binance",
  symbol: "BTC/USDT:USDT",
});
console.log(cached.source, feeRate.maker, feeRate.taker);
```

#### Base

`getVenueCapabilities("binance").order.fees === "supported"` 表示当前 SDK runtime 有 Binance PAPI UM 账号级 symbol 费率远端查询实现。`juplend` 等只读或未实现 venue 应返回 `"unsupported"`。

#### Bad

```ts
const feeRate = client.market.getMarket("binance", symbol)?.feeRate;
```

问题：交易费率依赖账号等级、折扣和权限，不是 public market catalog metadata；把它挂在 market definition 会误导下游认为无需账号凭证。

### 6. Tests Required

```bash
bun run lint
bun run type-check
bun run test
```

断言重点：

- `tests/integration/order.test.ts` 覆盖 `client.fee.fetchSymbolFeeRate()` Binance 成功路径：请求 `GET /papi/v1/um/commissionRate`，query symbol 为 venue id，签名/timestamp/recvWindow 存在，返回 canonical maker/taker。
- 成功路径必须断言 `receivedAt` 取自 commissionRate REST 响应返回后，避免把请求前时间误当成数据接收时间。
- 覆盖 REST 失败包装：错误码 `FEE_RATE_FETCH_FAILED`、`details.venue/accountId/symbol`、`details.venueError`、脱敏 `details.transport.url`，且不含 `details.orderState`。
- 覆盖 unsupported venue：`VENUE_NOT_SUPPORTED` message 使用 symbol fee rate queries，而不是 private order commands。
- `tests/integration/client-lifecycle.test.ts` 覆盖 venue capability `order.fees`。
- `tests/unit/rate-limiter.test.ts` 覆盖 commissionRate semantic plan 和 20 weight。

### 7. Wrong vs Correct

#### Wrong

```ts
async getSymbolFeeRate(input) {
  const order = await this.context.fetchOrder({ ...input });
  return order.feeRate;
}
```

问题：per-order 查询不返回账号费率；即使订单成交，返回的也是订单生命周期，不是 maker/taker fee schedule。

#### Correct

```ts
async fetchSymbolFeeRate(credentials, request, options) {
  const symbol = await this.toUsdmVenueIdForCommand(request.symbol);
  const response = await this.signedRequest(
    "GET",
    "/papi/v1/um/commissionRate",
    credentials,
    options,
    { symbol },
    SINGLE_ATTEMPT_IDEMPOTENT_POLICY,
  );
  return {
    symbol: request.symbol,
    maker: response.makerCommissionRate,
    taker: response.takerCommissionRate,
    receivedAt: Date.now(),
  };
}
```

效果：交易所 symbol 和签名细节留在 adapter；manager 只负责 public error 包装和 decimal canonical 化。

## Scenario: OrderManager 本地订单存储分层、内部 localOrderId 身份与 closed 裁剪

### 1. Scope / Trigger

- Trigger: 修改 `OrderManagerImpl` 内部存储结构、订单身份 / 索引、closed 容量裁剪、`getOrder()` / `getOpenOrders()` 查询路径时。
- 目标: 终态订单不无界累积导致内存膨胀；查询不随历史订单数量退化；内部统一用 SDK 生成的 `localOrderId` 做主键，同时保持 public `orderId` / `clientOrderId` 语义稳定。

### 2. 存储结构与内部身份

- 每个账户的 `OrderRecord` 内部分 **open / closed 两表**，各按 symbol 嵌套：`Map<symbol, Map<localOrderId, OrderSnapshot>>`。`localOrderId` 是 SDK 生成、纯内部、调用方不可指定的代理主键，不出现在任何 public type / event 中。
- Public 字段名保持不变：`OrderSnapshot.orderId` 表示 venue `orderId`，`OrderSnapshot.clientOrderId` 表示 venue `clientOrderId`。Binance `orderId` 仅 per-symbol 唯一，`clientOrderId` 终态后可复用，ADL/系统单还会共享字面量，所以两者都不能直接作为内部全局主键。
- 每个 `OrderRecord` 内维护核心订单表与索引，覆盖 open + closed，经 `insertSnapshot` / `deleteSnapshot` / `moveSnapshot` 三个 helper **严格同步**（任何增删改只走 helper，禁止散落维护）：
  - `localOrderId → location` 主存储定位；
  - `(symbol, venueOrderId) → localOrderId` 精确 1:1 索引，权威路径；
  - `venueOrderId → Set<localOrderId>` 歧义索引（支持不带 symbol 查询；跨 symbol 同 `orderId` 多命中时 open 优先、同类按 `updatedAt` 最新）；
  - `venueClientOrderId → Set<localOrderId>` 1:多索引（应对 ADL 共享 `adl_autoclose`、同 symbol 同 cid 多 orderId、cid 终态后复用）。
  - `pendingClientOrderIdIndex` 只存 createOrder 在途 claim，不是 public snapshot；`missingOrderConfirmations` 只存 open-set 缺失确认计数，必须随订单更新/重现清零。
- `createOrder()` 在发 REST 前生成 `localOrderId`。调用方未传 `clientOrderId` 时，SDK 把该 `localOrderId` 作为 Binance `newClientOrderId` 发送；调用方传了 `clientOrderId` 时，发送调用方的值，但内部仍使用独立的 `localOrderId`。
- 未传 `clientOrderId` 时发送的 `localOrderId` 必须满足 Binance `newClientOrderId` 约束：`acex-` 前缀、长度不超过 32、匹配 `^[\.A-Z\:/a-z0-9_-]{1,32}$`，并且不撞该账户当前 open 的 venue clientOrderId。调用方自带 `clientOrderId` 不满足该约束时，本地 fail-fast 抛 `ORDER_INPUT_INVALID`。
- 外部 / ADL / 其它会话的订单首见时，SDK 会补生成内部 `localOrderId`。带 venue orderId 的更新永远先用 `(symbol, venueOrderId)` 复用既有 local id；无 venue orderId 的 cid-only 更新只能 claim 同 symbol、同 cid、且尚无 venue orderId 的 provisional 订单。系统 cid 字面量（`adl_autoclose`、`autoclose-*`、`settlement_autoclose-*`）的 cid-only 更新不稳定归并，必须发 warning。
- `createOrder()` 发 REST 前会登记内部 pending claim：`venueClientOrderId → { localOrderId, symbol, claimedAt }`。如果 REST 返回前同 cid 的 WS 更新先到，manager 复用同一个 `localOrderId`，避免双建。REST 明确失败 / 拒单时清理 pending；timeout 这类未知 ack 保留 pending，等待后续 WS / reconcile 复用。
- pending claim 由 private reconcile 周期按 `CreateClientOptions.order.pendingClaimTtlMs`（默认 90s）驱动回查。coordinator 必须经 `PrivateOrderDataConsumer.getExpiredPrivateOrderClaims()` 取过期 claim，再用 adapter `fetchOrder({ symbol, clientOrderId })` 查询：查到则走 `onPrivateOrderUpdate()` 入库并自然认领；确认不存在则经 `onPrivateOrderClaimNotFound()` 清理 claim 并发布 runtime error；transport 错误保留 claim 等下一轮。没有 `fetchOrder` 能力的 adapter 不能确认缺失，必须保守保留 claim。
- `OrderSnapshot` 保持**不可变替换**：`createSnapshot` 每次返回新对象，绝不原地 mutate；对外返回的引用因此是某一时刻的冻结视图。

### 3. closed 裁剪与内存有界

- closed 订单（`filled` / `canceled` / `rejected` / `expired` / `unknown`）按 **symbol 子表各留最近 N 个**，`N = CreateClientOptions.order.maxClosedOrdersPerSymbol`，默认 **500**；非正、非整数、`undefined` 一律归一为默认。
- 超限按**插入顺序 FIFO 删最旧**，**批量摊销**：一次删 `max(1, floor(N/10))`，循环到 `size <= N`，以降低高频写入下的删除频率。
- 裁剪删除**必须走 `deleteSnapshot`**（同步四个内部结构、清理空 symbol 子表），禁止只删主表 —— 否则索引悬挂、`getOrder()` 仍能查到已被裁剪的快照。
- **open 表永不因容量裁剪**：open 是实时状态，裁剪会破坏 reconcile 对账与 `getOpenOrders()` 正确性。
- 内存有界靠三条：子表 FIFO 上限 + 清理空 symbol 子表 + 索引随主存储同步删除；并**依赖 venue symbol 集合有限**这一前提（故用 per-symbol 上限，不设全局 cap）。

### 4. 查询语义

- `getOpenOrders(accountId, symbol?)`：只返回 open 表内容，复杂度与历史终态订单数量无关。
- `getOrder(input)`：必须带 `orderId` 或 `clientOrderId`，否则返回 `undefined`。
  - 带 `symbol` + `orderId`：走精确索引 O(1)。
  - 不带 `symbol`、给 `orderId`：经 `orderId` 歧义索引命中（可命中 closed）。
  - 仅 `clientOrderId`：经 cid 索引命中，**覆盖 open + closed**；多命中返回**最新一笔**（**open 候选绝对优先**，同为 open / closed 时按 `updatedAt` 最新，`updatedAt` 相等时取任一；不用 `seq`——它是单订单版本号、跨订单不可比）。要精确定位历史某一笔须用 `orderId`。
  - 同时给 `orderId` 与 `clientOrderId`：**conjunctive**，两者都匹配才命中。

### 5. 终态、事件与迟到更新

- **无 `orderId` 的终态 order update**：若有 `clientOrderId`，以新生成的 `localOrderId` 作 **provisional** closed 订单暂存（拿到 `(symbol, orderId)` 后迁移到同一个 `localOrderId` 下的正式 venue identity）；若 `orderId` 与 `clientOrderId` 都缺，**丢弃并经 `context.publishRuntimeError("order", ...)` 发 warning**。对应 adapter 侧契约见 `adapter-contract.md`「终态更新应带 orderId」。
- `order.snapshot_replaced` 必须发布**全量**（open + 保留的 closed），分表后不得只发 open，否则下游会丢失终态订单视图。
- Reconcile open-set diff 仍基于 venue identity（`(symbol, orderId)` / `(symbol, clientOrderId)` alias），不得改用 `localOrderId` 比较；否则 orderId 后到或 cid-only provisional 迁移时会把同一 venue 订单误判为 disappeared。
- `unknown` 是 confirmed-missing 驱逐终态，不代表交易所真实状态。它必须移入 closed、参与 closed 裁剪、从 `getOpenOrders()` 消失，并沿用现有终态订单事件发布路径；收到任何 WS/REST 更新或 reconcile 快照重现时，必须清零该订单的 confirmed-missing 计数。
- **裁剪后迟到更新**：closed 单被裁剪后，同一旧终态事件若迟到，因其 `previous` 已被删，可能被当作新订单重新插入并重复发事件。这是**已接受的取舍**（不设 tombstone），`maxClosedOrdersPerSymbol` 应配置得足够覆盖正常的迟到 / reconcile 窗口。

### 6. submitting 后续演进边界

- 当前 REST 下单仍**同步返回 `orderId`**，没有 public 可观测的 "submitting" 窗口，故只设 open / closed 两表；`OrderStatus.unknown` 仅表示 confirmed-missing 后 SDK 无法还原真实交易所终态，不是 submitting。
- 已落地的 `localOrderId` + pending claim 只是身份地基，不是 submitting：pending 不出现在 public snapshot / event / status 中，不作为第三张表，不主动恢复查询。
- 后续若落地 **WS / 异步下单**（下单请求在途、ack 与 `orderId` 后到），可在当前内部主键模型上扩展 `submitting + open + closed` 三表；不应再重排 `OrderManager` 主键。

### 7. Tests Required

```bash
bun run lint
bun run type-check
bun run test
```

断言重点（`tests/integration/order.test.ts`）：

- 单 symbol closed 超 N 后 FIFO 批量裁剪，子表稳定 `<= N`，最旧被删。
- 被裁订单经 `orderId` 与 `clientOrderId` 都查不到（索引无悬挂）。
- open 订单数超过 N 时不被裁剪。
- 跨 symbol 各自独立裁剪；非法 N（`0` / 负 / 非整）回退默认、小 N 时批量至少删 1。
- 跨 symbol 同 `orderId`、同 symbol 同 `clientOrderId` 多笔并存可被正确区分。
- 未传 `clientOrderId` 下单时，请求必须带 SDK 生成的合规 `acex-*` cid，且返回 snapshot 的 public `clientOrderId` 等于该值；mock 必须回显请求 cid，避免假绿。
- 下单 REST 返回前早到的同 cid WS 更新必须复用 pending 的同一 `localOrderId`，不能双建；明确拒单清理 pending，timeout 保留。
- timeout 保留的 pending claim 必须带 `claimedAt`；TTL 回查查到订单时入库并清 claim，确认不存在时清 claim 并发 runtime error，adapter 无 `fetchOrder` 能力时保守保留。
- 自带 `clientOrderId` 超长或含非法字符时，本地抛 `ORDER_INPUT_INVALID`，不得发 REST。
- cid-only open 单收到 `orderId` 后在同一 `localOrderId` 下迁移 venue identity、不留旧 provisional 副本 / 索引；open→closed 迁移正确。
- 系统 cid 字面量（如 `adl_autoclose`）cid-only 更新不稳定归并并发 warning；带 `orderId` 的 ADL 单必须由 `(symbol, orderId)` 正确区分，`clientOrderId → Set<localOrderId>` 为 1:多。
- 无 key 终态单被丢弃并发 warning。
- reconcile / backfill 写入终态触发裁剪后，四个内部结构无悬挂，`getOpenOrders()` 不回退、`order.snapshot_replaced` 仍为全量。
- reconcile backfill 连续确认 open 订单不存在达到阈值时，订单变为 `unknown` closed；任何 WS/REST 更新或 reconcile 快照重现都清零 confirmed-missing 计数，transport 错误不计数。
