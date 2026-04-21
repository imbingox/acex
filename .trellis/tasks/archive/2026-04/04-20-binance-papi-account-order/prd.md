# 接入 Binance PAPI 统一账户 Account Read-only

## 目标

接入 Binance Portfolio Margin (`papi`) 的私有账户只读能力，让 `client.account` 的订阅、快照和状态来自真实的 PAPI 认证 REST 与用户数据流，而不是当前的本地空快照占位实现。

## 已确认信息

* 用户确认目标是 Binance `papi`，不是 Portfolio Margin Pro 或其他统一账户变体。
* 用户确认第一步按“私有底座 + account read-only”推进，不做订单流、不做下单撤单。
* 用户确认首版仓位覆盖范围为 **UM only**。
* `market` 和 L1 book 已经验证完成，当前仓库已有可工作的 Binance public market adapter。
* `src/managers/account-manager.ts` 和 `src/managers/order-manager.ts` 已经存在 public API 和事件流。
* 当前 `subscribeAccount()` 会创建空 `AccountSnapshot` 并立刻标记 `ready/healthy`，还没有真实私有数据源。
* 当前 `src/adapters/types.ts` 只定义了 market/L1 adapter contract，没有 private account/order adapter contract。
* 当前 `src/client/runtime.ts` 是薄编排器，只注入 `BinanceMarketAdapter`，没有注入私有交易所 adapter。
* 仓库质量检查命令是 `bun run lint`、`bun run type-check`、`bun test`。

## 临时假设

* 保持当前 5 层架构：public types、runtime、manager、adapter、internal 各自职责不混用。
* Binance PAPI 协议细节应留在 `src/adapters/binance/*` 内部，不泄漏到 manager 或 public types。
* 不把私有账户能力塞进 `MarketAdapter`，优先新增独立的 private/account adapter contract。
* 私有订阅的 `ready/healthy` 必须由真实 bootstrap 和 stream 状态驱动，不能继续使用乐观占位状态。

## 需求

* 首个交付切片只做 Binance PAPI 私有底座和 `account` read-only。
* 实现 PAPI 认证 REST 基础能力，包括 API key header、HMAC SHA256 签名、`timestamp`、`recvWindow`、错误处理和时间戳参数生成。
* 实现 PAPI 用户数据流基础能力，包括 listenKey 创建、保活、关闭、私有 WebSocket 连接、重连和错误上报。
* Account bootstrap 首版覆盖 UM only：
  * 余额：PAPI balance/account 数据中可映射的资产余额。
  * 仓位：`/papi/v1/um/positionRisk` 或等价 PAPI UM 仓位接口。
  * risk：PAPI account 数据中可映射的账户级风险字段。
* 用户数据流首版消费 account 相关事件，至少处理 `ACCOUNT_UPDATE` 对余额、UM 仓位和 risk 的增量更新。
* `client.account.subscribeAccount()` 完成真实 bootstrap 后才能标记 ready。
* `client.account.unsubscribeAccount()`、`client.stop()`、`removeAccount()` 必须清理私有流和保活资源。
* `client.order` 在本切片不接真实数据，行为保持现状或明确不受本任务影响。
* 不实现 `placeOrder`、`cancelOrder`、订单查询、open orders bootstrap、`ORDER_TRADE_UPDATE`。

## 验收标准

* [x] 注册 Binance PAPI 账户并提供凭证后，`client.account.subscribeAccount()` 通过真实 adapter 路径完成 bootstrap。
* [x] bootstrap 后 `client.account.getAccountSnapshot(accountId)` 返回真实 PAPI 映射出的余额、UM 仓位和账户风险字段。
* [x] bootstrap 完成前 account status 不应提前标记为 ready/healthy。
* [x] bootstrap 成功后 account status 标记为 `active`、`ready: true`、`runtimeStatus: "healthy"`。
* [x] 用户数据流收到 `ACCOUNT_UPDATE` 后，SDK 发布标准化的 account event，并更新本地 snapshot。
* [x] 私有 WebSocket 断开、重连、停止时，account status 能表达 `reconnecting`、`stopped` 等状态。
* [x] 缺少凭证或认证失败时，不创建假快照，不标记 ready，并通过现有 error/health 通道暴露失败。
* [x] `client.order` 不新增真实订单行为，本切片测试不依赖 order tracking。
* [x] 覆盖单元/集成测试，且 `bun run lint`、`bun run type-check`、`bun test` 通过。

## 完成定义

* 增加或更新测试覆盖 PAPI 私有认证、account bootstrap、ACCOUNT_UPDATE 增量、资源清理和错误状态。
* `bun run lint`、`bun run type-check`、`bun test` 通过。
* 行为变化和新 adapter contract 记录在本任务 PRD；如实现过程中形成稳定规范，再更新 `.trellis/spec/`。
* 私有流的 bootstrap、reconnect、stop、removeAccount 行为有明确测试或代码断言支撑。

## 暂不包含

* 非 Binance 交易所。
* Portfolio Margin Pro。
* CM 仓位。
* `client.order` 的真实订单追踪。
* 下单、撤单、改单、订单查询等 trading mutation。
* 前端或 demo UI。
* 与 Binance PAPI account read-only 无关的 public API 大改。

## 技术方案

### 推荐并已选择的方向：分阶段私有 adapter rollout

首轮先搭建 PAPI 私有底座，并把 `client.account` 接到真实 account read-only 数据源。订单流和交易指令在后续独立任务中推进。

优点：

* 风险最低，便于验证私有认证、listenKey、bootstrap、stream 状态机。
* 符合当前 5 层架构，adapter 负责交易所细节，manager 负责领域状态。
* 避免第一轮同时处理 account、order、trading mutation 导致状态机和测试复杂度过高。

代价：

* 第一轮不会提供真实订单追踪。
* 第一轮不会提供下单/撤单能力。

## Code-spec 深度检查

本任务触发 code-spec depth 要求，因为它新增 adapter contract、私有认证 REST/WS 基础设施，并修改 adapter -> manager -> runtime 的跨层数据流。

### 目标规范文件

* `.trellis/spec/backend/code-organization.md`：新增 adapter contract、保持 5 层依赖方向。
* `.trellis/spec/backend/type-safety.md`：新增 raw/standard 类型、状态返回类型、事件 union 不能宽化。
* `.trellis/spec/guides/cross-layer-thinking-guide.md`：明确 Adapter 解析协议、Manager 标准化和持有状态、Runtime 薄编排。
* `.trellis/spec/guides/code-reuse-thinking-guide.md`：复用 `ManagedWebSocket`、`AsyncEventBus`、现有 error/health 模式。

### 新增/修改契约

* `PrivateAccountAdapter`：标准私有账户 adapter contract，至少包含 `exchange`、`bootstrapAccount()`、`createAccountStream()`。
* `RawAccountBootstrap`：adapter 返回的标准化 bootstrap 原始数据，包含 balances、UM positions、risk、receivedAt。
* `RawAccountUpdate`：adapter 从 PAPI `ACCOUNT_UPDATE` 解析出的标准化增量，包含变更 balances、UM positions、risk、exchangeTs、receivedAt。
* `PrivateAccountStreamCallbacks`：manager 提供 `onUpdate`、`onDisconnected`、`onReconnected`、`onError` 等回调。
* `PrivateAccountStreamOptions`：包含 `listenKeyKeepAliveMs`、`reconnectDelayMs`、`reconnectMaxDelayMs`、`now`。
* `AccountManagerImpl`：`subscribeAccount()` 必须等待 REST bootstrap 成功后再置 `ready: true`，随后启动 stream 增量。

### 数据流

```text
PAPI REST/WS
  -> Binance private adapter 解析签名、listenKey、ACCOUNT_UPDATE
  -> AccountManager 标准化为 AccountSnapshot/BalanceSnapshot/PositionSnapshot/RiskSnapshot
  -> AccountManager 更新 record Map 并发布 AccountEvent/AccountStatusChangedEvent
  -> Runtime 只聚合 health/error，不持有 account 私有状态
```

### 验证与错误矩阵

| 场景 | 期望行为 |
|---|---|
| 缺少 `apiKey` 或 `secret` | `subscribeAccount()` 抛 `CREDENTIALS_MISSING`，不创建假快照 |
| PAPI bootstrap REST 失败 | `subscribeAccount()` 抛错，发布 adapter/runtime error，状态不标记 ready |
| Bootstrap 成功 | 创建真实快照，发布 `account.snapshot_replaced`，状态为 healthy/ready |
| `ACCOUNT_UPDATE` 包含 balance | 更新对应 asset 的 `BalanceSnapshot`，发布 `balance.updated` |
| `ACCOUNT_UPDATE` 包含 UM position | 更新对应 UM position，发布 `position.updated` |
| 私有 WS 断开 | 保留已有快照，状态变为 `runtimeStatus: "reconnecting"`、`reason: "ws_disconnected"` |
| unsubscribe/stop/removeAccount | 关闭 WS、停止 listenKey keepalive，状态变为 stopped 或删除 record |

### Good / Base / Bad cases

* Good：PAPI 字段解析留在 `src/adapters/binance/*`；manager 只接收标准 raw account update。
* Good：`AccountManagerImpl` 拥有 snapshot、seq、event bus 和 status，不把状态放回 runtime。
* Base：首版仅映射 UM position，CM 字段先忽略并在 PRD 中明确 out of scope。
* Bad：`subscribeAccount()` bootstrap 失败但仍返回空 snapshot 并标记 ready。
* Bad：manager 中出现 Binance 原始 payload 类型名或 PAPI URL 常量。

## 决策记录

### 决策 1：使用 Binance PAPI

背景：Binance 统一账户有多个接口族，需要先确定协议边界。

决策：本任务使用 Portfolio Margin `papi`。

影响：adapter 使用 `https://papi.binance.com` 及 PAPI 用户数据流，不接 Portfolio Margin Pro。

### 决策 2：首版只做 account read-only

背景：当前 account/order manager 都还是占位状态，如果同时接订单流和下单，首轮风险过高。

决策：首版只做私有底座和 `client.account` read-only。

影响：`client.order` 真实数据、下单、撤单放到后续任务。

### 决策 3：首版仓位只覆盖 UM

背景：现有 market catalog 已支持多个 Binance market family，但私有账户首版需要先把一个主路径打通。

决策：首版只映射 UM 仓位和相关风险字段。

影响：CM 仓位后续单独扩展，不阻塞当前 PAPI 私有底座验证。

## 可能修改的文件

* `src/adapters/types.ts`：新增私有 account adapter contract、raw account payload、回调和选项类型。
* `src/adapters/binance/*`：新增 PAPI REST 签名、account bootstrap、listenKey、私有 WS 和 ACCOUNT_UPDATE 解析。
* `src/client/runtime.ts`：注入 Binance 私有 adapter，保持薄编排。
* `src/client/context.ts`：如 manager 需要访问私有 adapter 或凭证合并后的只读视图，扩展内部 contract。
* `src/managers/account-manager.ts`：把占位 subscribe 改成真实 bootstrap + stream 驱动。
* `src/types/account.ts`：如现有标准快照字段不足，补充 public account read-only contract。
* `tests/client.test.ts` 或新增测试文件：覆盖 PAPI account read-only 行为。

## 相关规范

* `.trellis/spec/backend/code-organization.md`
* `.trellis/spec/backend/type-safety.md`
* `.trellis/spec/guides/cross-layer-thinking-guide.md`

## Binance 文档参考

* General info: `https://developers.binance.com/docs/derivatives/portfolio-margin/general-info`
* Account endpoints: `https://developers.binance.com/docs/derivatives/portfolio-margin/account`
* User data streams: `https://developers.binance.com/docs/derivatives/portfolio-margin/user-data-streams`
* Futures Balance and Position Update: `https://developers.binance.com/docs/derivatives/portfolio-margin/user-data-streams/Event-Futures-Balance-and-Position-Update`

## 实现记录

* 新增 `PrivateAccountAdapter` contract 和 Binance PAPI private adapter。
* `AccountManagerImpl` 从占位空快照改为真实 bootstrap + stream update 状态机。
* `ManagedWebSocket` 支持私有流需要的 open-ready 和无消息重连，同时保持 market L1 的默认 message-ready 行为。
* Runtime 注入 Binance private adapter，并新增 account runtime options。
* 测试覆盖 PAPI 签名 REST、listenKey WS、UM balance/position/risk bootstrap、`ACCOUNT_UPDATE` 增量、断线重连状态、bootstrap 失败和 `removeAccount()` 清理。
* 测试已拆分为 `tests/client-lifecycle.test.ts`、`tests/market.test.ts`、`tests/account.test.ts` 和 `tests/support/client-test-utils.ts`，避免单一 `client.test.ts` 继续膨胀。
* 新增 `scripts/live-account-smoke.ts` 和 `test:live:account` / `test:live:account:smoke` / `test:live:account:soak` 手动 live smoke 命令。
* 删除常规 `bun test` 中的 60 秒 L1 soak；长时间稳定性验证迁移到 `test:live:market:soak` / `test:live:account:soak` 这类手动 opt-in 命令。
* 已同步 `.trellis/spec/backend/code-organization.md` 和 `.trellis/spec/backend/type-safety.md`。
* 验证通过：`bun run lint`、`bun run type-check`、`bun test`。
