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

- `createOrder()` / `cancelOrder()` / `cancelAllOrders()` resolve 的结果来自 **REST 成功响应标准化后的 `OrderSnapshot`**。
- Manager 必须在命令成功后，先把 REST 返回更新应用到本地 order cache。
- private WS 后续到来的 `order.updated` / `order.canceled` / `order.filled` 事件，是生命周期变化流，**不是命令 ack 的唯一来源**。
- Binance private REST reconcile 不能把 `/papi/v1/um/openOrders` 当作订单生命周期真源；它只能作为 current open set 检测。某个本地 open order 从 REST open set 消失时，必须用 `/papi/v1/um/order`（或后续 `allOrders` 窗口回补）证明终态后再发布 `order.filled` / `order.canceled` / `order.rejected` / `order.updated`。
- 如果终态回补因 not found / retention miss / HTTP 失败无法证明订单状态，首版不得合成 filled/canceled/expired。保持原 snapshot，order domain 进入 `degraded`，下一轮 reconcile 继续尝试。
- 初始 order bootstrap、周期性 reconcile、WS reconnect reconcile 都必须走同一套 open-set + lifecycle backfill 语义，不能再用 openOrders 全量替换直接丢弃已有终态订单。

#### 3.4 精度与最小名义金额

- SDK 第一版只做字段透传，不自动帮调用方修正 `price` / `amount`。
- 调用方或 smoke 脚本在发单前，必须结合 `MarketDefinition` 处理：
  - `priceStep`
  - `amountStep`
  - `minAmount`
  - `minNotional`

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
| REST openOrders 缺少本地 open order 且 `queryOrder` 返回 filled/canceled | 应用终态，`getOpenOrders()` 不再返回该订单，`getOrder()` 仍可读终态 |
| REST openOrders 缺少本地 open order 但终态查询 not found/retention miss | 不合成终态；保留原 snapshot，order status 标记 `degraded` |
| 较旧 REST/WS/order bootstrap 更新到达 | 不能覆盖较新的 command ack / WS / reconcile 状态；相同 `exchangeTs` 下 terminal status 不被 open 覆盖，filled 数量不倒退 |

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
  - `cancelOrder()` 缺少双标识时本地校验失败
  - 漏 WS 终态时，REST open set 缺口必须触发单笔终态查询，最终 `getOpenOrders()` 清理、`getOrder()` 保留终态。
  - 终态查询 not found/retention miss 时，不合成终态，order status 进入 `degraded`。
  - command ack 后较旧 WS/bootstrap/reconcile 更新不得倒灌；相同 `exchangeTs` 下 filled 数量不倒退。
- live smoke
  - 单向持仓模式：不传 `positionSide`，以偏离 L1 5% 的 `LIMIT` 单真实挂单再撤单
  - 双向持仓模式：显式传 `positionSide`，跑同样的真实挂撤单
  - 断言 `order.updated` 和 `order.canceled` 事件都能收到
  - 断言最终 `getOpenOrders()` 中不残留测试单

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
    orderManager.onPrivateOrderStreamState(accountId, venue, {
      runtimeStatus: "degraded",
      ready: true,
      reason: "http_failed",
    });
  }
}
```

效果：

- `getOpenOrders()` 收敛到交易所当前 open set。
- `getOrder()` 仍保留可证明的最终订单状态。
- 无法证明终态时不伪造生命周期事件。
