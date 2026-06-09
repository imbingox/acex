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

---

## Scenario: OrderManager 本地订单存储分层、复合身份与 closed 裁剪

### 1. Scope / Trigger

- Trigger: 修改 `OrderManagerImpl` 内部存储结构、订单身份 / 索引、closed 容量裁剪、`getOrder()` / `getOpenOrders()` 查询路径时。
- 目标: 终态订单不无界累积导致内存膨胀；查询不随历史订单数量退化；复合身份正确处理 `orderId` / `clientOrderId` 两条线。

### 2. 存储结构与复合身份

- 每个账户的 `OrderRecord` 内部分 **open / closed 两表**，各按 symbol 嵌套：`Map<symbol, Map<orderKey, OrderSnapshot>>`。`orderKey` = `order:{orderId}` 优先，否则 `client:{clientOrderId}`。
- 主身份 = **`(symbol, orderId)`**；closed 表强制 `orderId` 主键。原因：Binance `orderId` 仅 **per-symbol** 唯一（非全局），而 `clientOrderId` 只是 "unique among open orders"、终态后可被复用，ADL 单还共享 `adl_autoclose` 字面量——`clientOrderId` 不能作为终态订单的稳定主键。
- 每个 `OrderRecord` 内维护**三索引**，覆盖 open + closed，经 `insertSnapshot` / `deleteSnapshot` / `moveSnapshot` 三个 helper **严格同步**（任何增删改只走 helper，禁止散落维护）：
  - `(symbol, orderId)` 精确索引；
  - `orderId → Set<location>` 歧义索引（支持不带 symbol 查询；跨 symbol 同 `orderId` 多命中时 open 优先、同类按 `updatedAt` 最新）；
  - `clientOrderId → Set<location>` 索引（一对多，应对同 symbol 同 cid、不同 orderId 的多笔并存）。
- `OrderSnapshot` 保持**不可变替换**：`createSnapshot` 每次返回新对象，绝不原地 mutate；对外返回的引用因此是某一时刻的冻结视图。

### 3. closed 裁剪与内存有界

- closed 订单按 **symbol 子表各留最近 N 个**，`N = CreateClientOptions.order.maxClosedOrdersPerSymbol`，默认 **500**；非正、非整数、`undefined` 一律归一为默认。
- 超限按**插入顺序 FIFO 删最旧**，**批量摊销**：一次删 `max(1, floor(N/10))`，循环到 `size <= N`，以降低高频写入下的删除频率。
- 裁剪删除**必须走 `deleteSnapshot`**（同步三索引、清理空 symbol 子表），禁止只删主表 —— 否则索引悬挂、`getOrder()` 仍能查到已被裁剪的快照。
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

- **无 `orderId` 的终态 order update**：若有 `clientOrderId`，用 `client:{cid}` 作 **provisional** closed key 暂存（拿到 `orderId` 后迁移到正式 `order:{orderId}` key）；若 `orderId` 与 `clientOrderId` 都缺，**丢弃并经 `context.publishRuntimeError("order", ...)` 发 warning**。对应 adapter 侧契约见 `adapter-contract.md`「终态更新应带 orderId」。
- `order.snapshot_replaced` 必须发布**全量**（open + 保留的 closed），分表后不得只发 open，否则下游会丢失终态订单视图。
- **裁剪后迟到更新**：closed 单被裁剪后，同一旧终态事件若迟到，因其 `previous` 已被删，可能被当作新订单重新插入并重复发事件。这是**已接受的取舍**（不设 tombstone），`maxClosedOrdersPerSymbol` 应配置得足够覆盖正常的迟到 / reconcile 窗口。

### 6. 演进:submitting 三表与本地 cid 身份

- 当前 REST 下单**同步返回 `orderId`**，没有"提交中"可观测窗口，故只设 open / closed 两表、复合身份以 `orderId` 为主键。
- 后续若落地 **WS / 异步下单**（下单请求在途、ack 与 `orderId` 后到）：应扩展为 `submitting + open + closed` 三表并扩 `OrderStatus`；身份模型可演进为**本地生成 `clientOrderId` 主键 + `venueOrderId → localClientOrderId` 反向索引**（NautilusTrader 式），契合 acex 发起型 OMS 定位。现有分表 + helper 结构已为此预留扩展点。

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
- cid-only open 单收到 `orderId` 后迁移 key、不留旧 key / 索引；open→closed 迁移正确。
- 无 key 终态单被丢弃并发 warning。
- reconcile / backfill 写入终态触发裁剪后，`getOpenOrders()` 不回退、`order.snapshot_replaced` 仍为全量。
