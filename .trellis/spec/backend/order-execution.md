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

### 6. Tests Required

每次改交易命令 contract 或 Binance 下单字段，至少执行：

```bash
bun test
bun run type-check
```

断言重点：

- `tests/order.test.ts`
  - `createOrder()` 成功时返回规范化 snapshot
  - `cancelOrder()` / `cancelAllOrders()` 成功时返回规范化 snapshot
  - `cancelOrder()` 缺少双标识时本地校验失败
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
