# design: private data REST reconciliation for incremental WS streams

## Goal

建立一套通用的 private data reconciliation 机制：当某个 venue 的私有 WS 只提供增量事件、且消息可能丢失或乱序时，SDK 默认每 60s 用 REST 对账账户余额、仓位信息、订单状态等 private 数据，让 SDK getter 读到的 account / balances / positions / orders 持续收敛到交易所真实状态。Binance PAPI UM 是本任务首个落地场景；原始 bug 是 `getOpenOrders()` 读到实际已成交但本地仍残留的挂单。对于会通过 WS 定期推送权威全量 private snapshot 的 venue，不要求额外启用 REST 定时对账。

## What I Already Know

* 用户在实际使用中观察到 Binance client 会读到不存在的挂单；该订单实际应该已经成交，但一直残留。
* 这个问题不应只修成“openOrders 定时全量替换”。更通用的模式是：WS 只有增量时，必须有 REST 定时对账，并按时间戳 / watermark 只应用最新状态。
* 当前 Binance account 已有 `refreshAccount()` polling：`/papi/v1/account` + `/papi/v1/um/positionRisk` 定时刷新 risk 和 mark-to-market position 字段；该路径是 incremental refresh，不会全量校准 balances，也不会因 REST 缺失项清理本地 stale positions。
* 当前 Binance account 初始 `bootstrapAccount()` 会拉 `/papi/v1/balance` + `/papi/v1/account` + `/papi/v1/um/positionRisk` 并全量替换账户快照，但连接正常时没有周期性 authoritative account reconcile。
* 当前 Binance orders 只有初始 `bootstrapOpenOrders()` 和 WS reconnect 后 `reconcileRecord() -> bootstrapOrders()`，没有连接正常时的周期性订单对账。
* 当前 `OrderManagerImpl.onPrivateOrderBootstrap()` 会用 open orders 全量替换内部 `snapshots` Map；这能清理 `getOpenOrders()`，但会丢掉旧订单终态，导致 `getOrder()` 可能查不到 filled/canceled 的最终状态。
* Binance PAPI REST 端点可支持更完整的订单 reconcile：
  * `GET /papi/v1/um/openOrders`：当前 open orders；不带 symbol 返回全账户，权重高。
  * `GET /papi/v1/um/order`：按 `symbol + orderId/origClientOrderId` 查询单个订单状态；Binance 对无成交且已 canceled/expired 超过保留期的订单可能返回查不到。
  * `GET /papi/v1/um/allOrders`：按 `symbol`、`orderId` 或 `startTime/endTime` 查询订单列表，可用于时间窗口回补；该接口是 symbol-scoped，时间窗口有上限。
* Binance PAPI account / position 对账端点：
  * `GET /papi/v1/balance`
  * `GET /papi/v1/account`
  * `GET /papi/v1/um/positionRisk`
* 当前 public manager 已经有状态事件和 runtime error 通道；reconcile 失败应复用这些状态语义，而不是静默吞错。

## Assumptions

* 原始残留挂单的根因大概率是 `ORDER_TRADE_UPDATE` 丢失或未处理，且 WS 没有进入 reconnect，因此现有 reconnect reconcile 没有触发。
* REST 查询返回的数据应视为该 facet 的权威校准来源，但不同 facet 的“权威语义”不同：
  * balances / positions 可以通过全量 REST 快照校准当前集合。
  * risk 和 mark-to-market 字段也可以通过 REST 定时刷新校准。
  * orders 是生命周期对象，不能只用“当前 open 集合里不存在”来代表终态；需要查询终态或时间窗口历史。
* `exchangeTs/updateTime` 可作为优先 watermark；但部分 venue 的 REST 或 WS 可能缺失 `exchangeTs`，此时需要用 SDK `receivedAt` 兜底，避免本地状态永远无法更新。跨 `exchangeTs` / `receivedAt` 比较只能在带安全余量时使用，默认余量为 `10_000ms`。

## Requirements

* 第一版范围只覆盖 private account / balances / positions / orders；market data 不纳入 REST reconcile，继续使用现有 WS freshness / reconnect 机制。
* 默认行为：对需要 REST reconcile 的 venue 启用 private REST 定时对账，默认 interval 为 `60_000ms`，一次 reconcile 覆盖账户余额、仓位和订单状态等 private 信息；用户可通过显式 `0` 关闭 private reconcile。
* 如果 venue 的私有 WS 会定期推送权威全量 private snapshot，并且能自行清理 stale balances / positions / orders，则该 venue 不需要额外启用 REST 定时对账；实现应通过 adapter capability / reconcile 方法是否存在来决定，而不是硬编码所有 venue 都轮询 REST。
* 设计并落地通用 private reconcile 调度能力，至少支持 per-account / per-venue 的统一 interval、in-flight guard、generation cancellation、unsubscribe/stop/remove credentials cleanup。
* Reconcile 必须有 watermark / freshness 规则：应用更新前比较 `exchangeTs` 或等价更新时间，避免旧 REST 响应覆盖新 WS 消息。
* Account / balance / position / risk reconcile：
  * 新增 Binance full account reconcile，周期性拉取 `/papi/v1/balance` + `/papi/v1/account` + `/papi/v1/um/positionRisk` 的无 asset / 无 symbol 全量结果。
  * Full account reconcile 对 balances 和 UM positions 采用 current authoritative snapshot 语义：REST 响应成功且通过 watermark 后，本地不存在于完整 REST 集合中的 balance / position 视为 stale，应从 public getter 中清理；position 明确 `positionAmt = 0` 也应清理。
  * Full account reconcile 对 risk 字段采用当前快照校准语义；只更新 REST 明确返回的 risk 字段，不凭缺失字段清空已有字段。
  * 现有 `refreshAccount()` fast polling 继续覆盖 Binance risk / mark-to-market 刷新，并保持 incremental refresh 语义；full account reconcile 和 fast refresh 必须共用 scheduler 生命周期 / generation / in-flight / watermark 防倒灌规则。
  * `account.binance.privateReconcileIntervalMs: 0` 只关闭 full account reconcile 和 order reconcile，不关闭现有 `riskPollIntervalMs` / `refreshAccount()` fast polling。
  * Account full reconcile 成功不得把当前 WS reconnecting/degraded 状态强行改成 healthy；应与现有 refresh 一样支持 preserve stream status。
* Order reconcile：
  * openOrders 只能作为当前 open set 校验和缺口发现。
  * 本地 open order 如果从 REST open set 中消失，必须优先通过低权重的 `queryOrder(symbol + orderId/origClientOrderId)` 回补终态；只有缺少标识、需要窗口批量回补或单笔查询不可用时，才使用 `allOrders`。
  * 终态回补成功后，再对外发布 `order.filled` / `order.canceled` / `order.rejected` / `order.updated`。
  * 如果 current open set 已确认本地订单不再 open，但 `queryOrder` / `allOrders` 因 Binance 保留期、404/not found 或响应缺失而无法证明具体终态，首版不得伪造 `filled` / `canceled` / `expired` 状态；应发布 runtime error、将 order domain 标记为 `degraded`，并保留原 snapshot，后续轮次继续尝试。该长期保留期边界另开任务处理。
  * 成功回补终态后，`getOpenOrders()` 不再返回该订单，同时 `getOrder()` 仍能查到最终订单状态。
  * 对消失订单做终态查询时必须有 bounded concurrency / batch 上限，避免一次 reconcile 因大量本地残留订单触发无界 REST fan-out；MVP 默认每轮最多回补 `20` 个 disappeared local open orders，并发最多 `4` 个 query，超出上限的订单留到后续轮次继续处理。
  * 对账应能处理外部系统下单/撤单造成的订单变化，而不仅是本 SDK 发出的命令；首版覆盖“对账时仍 open 的外部订单”和“曾进入本地 open set 后消失的订单终态”，不承诺发现两轮对账之间创建并已终态结束、且从未进入本地缓存的外部订单。
* Reconcile 失败不能停止 WS；应发布 runtime error，并把对应 domain status 标记为 `degraded`，reason 映射为 `http_failed` / `rate_limited`，下一轮继续尝试。
* 不能改变下单/撤单命令 ack 语义；REST 命令成功仍要立即写入本地缓存，后续 reconcile 只负责收敛。
* 配置放在 `CreateClientOptions.account` 下，允许按 venue 配置统一 private reconcile interval；默认值必须考虑 Binance request weight。

## Architecture Direction

### Generic Model

新增或抽取一个通用 private reconcile 调度层，建议落点仍在 Layer 3 编排层，可能是 `src/client/private-reconciliation-coordinator.ts` 或 `PrivateSubscriptionCoordinator` 内部 helper。它不持有领域快照，只负责：

* 根据 subscription 状态启动/停止 facet reconcile job。
* 管理 timer、in-flight promise、generation token。
* 调用 adapter 的 REST reconcile 方法。
* 把标准化结果分发给 account/order manager。
* 统一错误发布和状态降级。

Manager 仍持有领域状态，并负责按 watermark 判断是否应用更新。Adapter 只封装交易所 REST/WS 细节。

### Data Semantics

需要区分三类 REST reconcile 结果：

* Current snapshot：可整体替换某个集合，例如明确全量的 balances / positions / current open orders。
* Incremental refresh：只更新部分字段，例如 mark price、risk、PnL，缺失项不代表删除。
* Lifecycle backfill：按 id 或时间窗口拉生命周期对象，例如 orders；必须生成终态 update，不能只删除本地对象。

Binance 首版语义：

* `/papi/v1/balance` + `/papi/v1/account` + `/papi/v1/um/positionRisk` 在 full account reconcile 中是 authoritative current snapshot：balances / positions 缺失项可以清理，risk 按返回字段校准。
* `/papi/v1/account` + `/papi/v1/um/positionRisk` 在 fast `refreshAccount()` 中仍按 incremental refresh 处理，用于高频校准 mark-to-market 字段；缺失项不触发删除。
* `/papi/v1/um/openOrders` 是 current-open-set detection，不是 order lifecycle snapshot；不能直接作为 `OrderManager` 的最终全量替换来源。
* `/papi/v1/um/order` 或 `/papi/v1/um/allOrders` 返回的是 order lifecycle backfill，可用于生成终态 order update。

### Watermark Rules

* 每个 account/order/position/balance/risk snapshot 应保留 `exchangeTs` 和 `receivedAt`；REST reconcile / refresh update 还必须带上该请求的 `requestStartedAt`。
* `exchangeTs` 和 `receivedAt` 属于不同 clock domain；优先只比较同类时间戳：`exchangeTs` vs `exchangeTs`、`receivedAt` vs `receivedAt`。当一侧缺少 `exchangeTs` 时，允许使用跨时钟兜底，但必须带安全余量，默认 `CROSS_CLOCK_WATERMARK_GRACE_MS = 10_000`。
* 应用更新时优先比较同源交易所时间 `exchangeTs`；若两侧都有 `exchangeTs`：
  * incoming `<` current：丢弃 incoming，不发布事件，不更新 snapshot/status timestamp。
  * incoming `>` current：应用 incoming。
  * incoming `===` current：订单状态按生命周期优先级合并，terminal status（`filled` / `canceled` / `rejected` / `expired`）不得被 `open` / `partially_filled` 覆盖；同级状态下可应用字段补全但不得降低 filled 数量。
* 若只有一侧有 `exchangeTs`，按以下兜底规则处理，避免缺少 `exchangeTs` 的 venue 永远无法更新：
  * 若 incoming 来自 REST，且 current `receivedAt > requestStartedAt`，说明 REST 请求飞行期间已有更新，本轮丢弃或延后 incoming。
  * 如果 incoming 没有 `exchangeTs`、current 有 `exchangeTs`：只有当 `incoming.receivedAt >= current.exchangeTs + CROSS_CLOCK_WATERMARK_GRACE_MS` 时才允许应用；否则丢弃或延后。
  * 如果 incoming 有 `exchangeTs`、current 没有 `exchangeTs`：只有当 `incoming.exchangeTs >= current.receivedAt - CROSS_CLOCK_WATERMARK_GRACE_MS` 时才允许应用；否则认为 incoming 可能旧于本地状态，丢弃。
  * 通过跨时钟兜底后，再用 `receivedAt` 做本地新鲜度比较；相等时优先保留带 `exchangeTs` 的一侧，但订单仍必须遵守 lifecycle / filled monotonic 合并规则。
* 若两侧都没有 `exchangeTs`：使用同样的 local freshness guard 和 `receivedAt` 比较；旧的丢弃，相等时按订单 lifecycle 优先级合并。
* REST response started earlier but resolved later 的情况要通过 generation 和 timestamp comparison 防止倒灌。
* order cache 的 merge 规则必须覆盖 command ack、WS update、初始 bootstrap、周期性 reconcile、reconnect reconcile 和 lifecycle backfill；可以保留 command ack 不额外发布 public event 的现有语义，但不能让 command ack 绕过 watermark 后被较旧 REST/WS 覆盖。
* Full snapshot deletion / open-set diff 没有 per-object incoming update 时，必须使用 snapshot-level watermark：
  * 每次 REST reconcile job 记录 `requestStartedAt` 和 `responseReceivedAt`，adapter 返回的 full snapshot / open set 必须携带 `snapshotReceivedAt`，若有 endpoint-level `updateTime` 则同时携带 `snapshotExchangeTs`。
  * 清理 stale balance / position 或判定 local open order disappeared 前，必须确认本地对象自 `requestStartedAt` 之后没有被 WS / command ack / newer REST update 更新过；如果本地对象 `receivedAt > requestStartedAt`，本轮不得删除或判定 disappeared，留到下一轮。
  * 如果本地对象和 full snapshot 都有 `exchangeTs`，且本地 `exchangeTs > snapshotExchangeTs`，本轮不得删除；如果 snapshot 缺少 `snapshotExchangeTs`，以 `requestStartedAt` 作为删除安全边界。
  * 对 REST open set 中存在的订单，仍按 per-order update watermark 应用；对 REST open set 中缺失的本地订单，只能在通过上述 snapshot-level guard 后再发起 terminal backfill。

### Adapter API Shape

MVP 不引入一次性全量 `PrivateReconcileAdapter` union；在 `PrivateUserDataAdapter` 上增量增加可选方法，coordinator 只在方法存在且 interval 未禁用时调度：

* `reconcileAccount?(credentials, accountOptions?): Promise<RawAccountBootstrap>`：返回 authoritative current account snapshot，语义等同 account bootstrap 的完整 balances / positions / risk snapshot，但用于周期性 reconcile；manager 应按 full snapshot + snapshot-level watermark 清理 stale balances / positions，并 preserve stream status。
* `fetchOpenOrders?(credentials, accountOptions?): Promise<RawOpenOrdersSnapshot>`：返回当前全账户 open orders，形状为 `{ orders: RawOrderUpdate[], snapshotReceivedAt: number, snapshotExchangeTs?: number }`。Binance MVP 可复用现有 `/papi/v1/um/openOrders` 映射；首版仍使用全账户 openOrders，默认 `60_000ms` 下接受 weight `40`。如果 Binance openOrders 没有 endpoint-level update time，`snapshotExchangeTs` 可以省略，删除/消失判定用 coordinator 的 `requestStartedAt` 安全边界。
* `fetchOrder?(credentials, request, accountOptions?): Promise<RawOrderUpdate | undefined>`：按 `symbol + orderId/clientOrderId` 查询单笔订单终态；not found / retention miss 返回 `undefined` 或抛可识别 not-found error，由 coordinator 映射为“不合成终态 + degraded + 下一轮继续”。
* `fetchOrdersSince?` / time-window backfill 不进入 MVP 必需接口，只作为后续外部订单 discovery 扩展；MVP 的 terminal backfill 优先 `fetchOrder()`，仅缺少单笔标识或 adapter 无单笔能力时才考虑 `allOrders` fallback。

## Candidate Approaches

### A. Minimal Generic Scheduler + Binance-Specific Facets（推荐）

先抽通用 timer/in-flight/error/status 机制，首批接 Binance full account reconcile、现有 account refresh 和 order reconcile。Adapter 接口可以先增量扩展：

* `refreshAccount()` 继续存在，但在设计上归入 account reconcile facet。
* 新增 full account reconcile 能力，例如 `reconcileAccount()` 或标准 `AccountReconcileResult`，返回 authoritative balances / positions / risk snapshot。
* 新增订单 reconcile 能力，例如 `reconcileOrders()` 或更细的 `fetchOpenOrders()` + `fetchOrder()` / `fetchOrdersSince()`。

优点：能解决当前 bug，也不会过度抽象到所有交易所；保持现有层级边界。缺点：第一版 generic 仍主要由 Binance 驱动，后续 venue 需要继续打磨接口。

### B. Full Generic Reconcile Interface

一次性定义 `PrivateReconcileAdapter` / `PrivateReconcileJob`，所有 facet 都走统一 `ReconcileResult` union。

优点：长期模型清晰。缺点：当前只有 Binance PAPI UM 和 Juplend 两类私有数据，容易设计过度，改动面较大。

### C. Patch Existing Coordinator Only

在 `PrivateSubscriptionCoordinator` 内直接增加 account/order 两套 polling。

优点：改动小。缺点：会把 coordinator 继续膨胀，后续新增更多 incremental WS 数据时重复定时器和错误逻辑。

## Recommended MVP

采用 A。第一版范围：

* 只覆盖 private account / balances / positions / orders，不处理 market data。
* 抽出可复用的 private reconcile job 管理逻辑，至少让 full account reconcile、account refresh 和 order reconcile 共用生命周期、generation、in-flight、错误状态处理。
* Binance full account reconcile 通过 `/papi/v1/balance` + `/papi/v1/account` + `/papi/v1/um/positionRisk` 定时校准 balances / positions / risk；balances 和 positions 按 authoritative current snapshot 清理 stale 本地项。
* Binance fast account refresh 继续通过 `/papi/v1/account` + `/papi/v1/um/positionRisk` 定时校准 risk / mark-to-market position 字段；保持 incremental refresh 语义和现有兼容性。
* Binance orders 新增 REST reconciliation：
  * 定时获取 current open orders。
  * 对本地 open orders 与 REST open set 做 diff。
  * 对从 open set 消失的订单，优先用 `GET /papi/v1/um/order` 回补最终状态；仅在需要时 fallback 到 `GET /papi/v1/um/allOrders`。
  * 终态查询失败或 Binance retention 查不到时，不合成终态；order status 进入 degraded，下一轮继续。
  * 对 REST open set 中新增/变化的 open orders，应用标准 `RawOrderUpdate`。
  * 对所有应用更新执行 watermark 检查。
  * 初始 order bootstrap 和 reconnect reconcile 也必须使用同一套 order reconcile 语义；不得继续用 openOrders 全量替换直接删除本地订单终态。
* Public option 初版建议：
  * `account.binance.riskPollIntervalMs` 保持兼容。
  * 新增 `account.binance.privateReconcileIntervalMs`。
  * `privateReconcileIntervalMs` 的默认值为 `60_000`，同时驱动 full account reconcile 和 order reconcile。
  * `privateReconcileIntervalMs: 0` 表示关闭 Binance private REST reconcile；其它非正数或非有限值按默认值处理，仅显式 `0` disabled。
  * `privateReconcileIntervalMs: 0` 不影响 `riskPollIntervalMs`；`riskPollIntervalMs` 保持既有兼容语义，当前 `0` / 非正数会回落默认值，不作为关闭 fast risk refresh 的开关。

## Acceptance Criteria

* [ ] WS 未收到订单 filled/canceled 消息、但 REST 对账发现该订单不再 open 且终态查询成功时，SDK 会查询并应用该订单终态。
* [ ] 上述场景中 `getOpenOrders(accountId)` 不再返回该订单，`getOrder({ orderId/clientOrderId })` 能返回 `filled` 或 `canceled` 等最终状态。
* [ ] 本地 open order 从 REST open set 消失但终态查询因 not found/retention 失败时，SDK 不合成终态；发布 runtime error，order status 进入 `degraded`，下一轮继续尝试。
* [ ] Full account reconcile 成功后，REST 全量余额中缺失或归零的资产不再出现在 `getBalances(accountId)` / `getBalance(accountId, asset)` 的可用余额视图中。
* [ ] Full account reconcile 成功后，REST 全量 UM positions 中缺失或 `positionAmt = 0` 的本地仓位不再出现在 `getPositions(accountId)` / `getPosition(...)` 中。
* [ ] REST full snapshot 请求开始后收到较新 WS / command update 的 balance / position / order，不会被该轮 REST 缺失项删除或判定 disappeared。
* [ ] 初始 bootstrap、周期性 reconcile、WS reconnect reconcile 都不会因为 openOrders 全量替换而丢失已有订单终态。
* [ ] create/cancel/cancelAll REST command ack 写入本地缓存后，较旧的 WS/bootstrap/reconcile 更新不能覆盖该状态。
* [ ] REST 返回较旧 `exchangeTs` 的订单/account/balance/position/risk 更新不会覆盖较新的 WS 更新；缺失 `exchangeTs`、相等 `exchangeTs`、REST in-flight 期间收到新 WS 更新的场景都有测试覆盖。
* [ ] 相同 `exchangeTs` 下，订单 terminal status 不会被 open/partially_filled 覆盖，filled 数量不会倒退。
* [ ] Reconcile 成功时发布对应领域事件；订单终态发布 `order.filled` / `order.canceled` 等，而不是只发 snapshot replacement 后丢失终态。
* [ ] Reconcile HTTP/rate-limit 失败时，domain status 进入 `degraded`，reason 正确映射，并且下一轮继续。
* [ ] unsubscribe、client stop、account removed、credentials updated 后不会继续发起或回写旧 generation 的 reconcile 结果。
* [ ] 已有 reconnect reconcile 行为不回退。
* [ ] Binance account risk/position polling 现有测试继续通过，并补充 stale/old timestamp 场景；full account reconcile 覆盖 balance stale removal、position stale removal、position explicit zero removal。
* [ ] 文档说明新增 reconcile 配置、默认值、关闭方式、适用 venue 条件和 Binance request weight 注意事项。

## Definition Of Done

* tests added/updated：
  * coordinator/unit：reconcile job lifecycle、cleanup、in-flight guard、error downgrade、generation ignore。
  * order integration：漏 WS 终态后 REST reconcile 回补 final order，`getOpenOrders` 与 `getOrder` 都正确；覆盖 terminal lookup not found/retention 时不合成终态且进入 degraded；覆盖 command ack 后旧更新不倒灌。
  * account integration：full account reconcile 清理 stale balances / positions；REST refresh 不覆盖较新 WS，断线期间 refresh / reconcile 成功不把 status 改回 healthy。
* `bun run lint`
* `bun run type-check`
* `bun run test`
* docs/README/API 如 public option 变化则同步更新。
* 更新 `.trellis/spec/backend/adapter-contract.md` / `order-execution.md`，记录“incremental WS 必须有 REST reconcile，openOrders 不等于订单终态”的约定。

## Out Of Scope

* 不接入 Binance algo/conditional orders。
* 不做跨进程持久化 cursor；本任务只维护 SDK 进程内 watermark。
* 不把 market public streams 纳入本任务；market data 继续按现有 WS freshness / reconnect 模型运行，不做 REST 对账。
* 不承诺发现两轮对账之间由外部系统创建并已终态结束、且从未进入本地缓存的订单；这需要更广泛的 symbol/time-window discovery，另开任务处理。
* 不接入 Binance CM positions；首版 full account reconcile 只覆盖 PAPI UM positions 和 portfolio account balances/risk。
* 不一次性支持所有 CEX venue；只设计接口时避免 Binance 特判泄漏。

## Technical Notes

* 主要代码路径：
  * `src/client/private-subscription-coordinator.ts`
  * `src/client/context.ts`
  * `src/managers/account-manager.ts`
  * `src/managers/order-manager.ts`
  * `src/adapters/types.ts`
  * `src/adapters/binance/private-adapter.ts`
  * `src/types/shared.ts`
* 相关测试：
  * `tests/unit/private-subscription-coordinator.test.ts`
  * `tests/integration/account.test.ts`
  * `tests/integration/order.test.ts`
  * `tests/support/exchanges/binance.ts`
* 相关规范：
  * `.trellis/spec/backend/code-organization.md`
  * `.trellis/spec/backend/adapter-contract.md`
  * `.trellis/spec/backend/error-handling.md`
  * `.trellis/spec/backend/order-execution.md`
  * `.trellis/spec/backend/type-safety.md`

## Research References

* [`research/binance-open-orders-reconcile.md`](research/binance-open-orders-reconcile.md) — Binance private REST/WS 对账端点和语义摘要。

## Decisions

* 第一版只覆盖 private account / balances / positions / orders。
* Market data 不纳入本任务；L1/funding 等仍按 WS freshness / reconnect 处理，不需要 REST 对账。
* Public disable 语义：`account.binance.privateReconcileIntervalMs: 0` 关闭 Binance private REST reconcile；默认 `60_000ms`。
* `privateReconcileIntervalMs` 不影响既有 `riskPollIntervalMs` / `refreshAccount()` fast polling。
* Binance full account reconcile 对 balances / positions 使用 authoritative snapshot 语义；`refreshAccount()` 继续按 incremental refresh 处理，不把缺失项作为删除信号。
* 外部订单首版只覆盖对账时仍 open 的订单，以及曾进入本地 open set 后消失的订单终态。
* 消失订单的终态回补优先使用 `queryOrder`，每轮默认最多 `20` 笔、并发最多 `4`；Binance retention / not found 边界首版不伪造终态。
