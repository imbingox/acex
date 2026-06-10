# Refactor OrderManager structure

## Goal

在 P0-2 修复之后，对 `src/managers/order-manager.ts` 做 no-behavior-change 结构拆分，降低单文件复杂度，方便后续 WS 下单、P0-3 私有流恢复和订单状态机继续演进。拆分必须保持 public API、事件语义、订单缓存语义和测试行为不变。

## What I Already Know

* `src/managers/order-manager.ts` 当前约 1600 行，职责同时覆盖 public manager API、命令执行、私有流消费、order cache open/closed 表、索引同步、pending claim、状态合并和错误包装。
* 现有代码边界清晰：
  * 纯 helper / model：`OrderRecord`、`OrderLocation`、`OrderTable`、`normalizeMaxClosedOrdersPerSymbol`、status helper。
  * 身份解析：`getOrderLookupKeys`、query match、stored identity match、clientOrderId 规则。
  * 存储索引：open/closed 表、`localOrderLocations`、`orderIdIndex`、`clientOrderIdIndex`、closed 裁剪。
  * 主 manager 编排：public API、事件发布、runtime context、错误包装。
* 相关规范要求 manager 持有领域状态，不能把状态塞回 runtime，也不能泄漏交易所特定类型。

## Requirements

* 拆出内部 order 领域模块，建议落点为 `src/managers/order/`。
* 保留 `OrderManagerImpl` 在 `src/managers/order-manager.ts`，继续实现 public `OrderManager`、`ManagerLifecycle`、`AccountAwareManager`、`HealthReporter`、`PrivateOrderDataConsumer`。
* 拆分按职责边界落地为：
  * `src/managers/order/model.ts`：内部类型与 record/location/options 结构。该文件是 `OrderManager` 私有子模块例外，不进入 public contract、不跨领域复用、不从任何 barrel 导出。
  * `src/managers/order/identity.ts`：订单身份、clientOrderId 规则、lookup key、query/stored identity match。
  * `src/managers/order/snapshot.ts`：订单快照创建、状态优先级、open 判断、P0-2 的 filled/remaining 单调合并。
  * `src/managers/order/store.ts`：open/closed 表、索引同步、裁剪、snapshot 查询和迁移。
  * `src/managers/order/data-status.ts`：order data status clone / create / successful 状态 helper 和 closed 容量归一化；所有 helper 必须显式返回 `OrderDataStatus`，reason/status 字段复用 public shared 类型，纯类型依赖使用 `import type`。
* 不新增、不删除、不改名任何 public type / public method / event type。
* 不改变订单生命周期行为：
  * open/closed 表迁移和 closed 裁剪语义不变；
  * `getOrder()` / `getOpenOrders()` / `getOrderStatus()` 查询语义不变；
  * pending clientOrderId claim 语义不变；
  * P0-2 command watermark、filled/remaining 单调合并语义不变；
  * `order.snapshot_replaced` 仍发布 open + retained closed 的全量视图，不能只发布 open；
  * reconcile open-set diff 继续基于 venue identity（`symbol + orderId/clientOrderId`），不能改用 `localOrderId`；
  * warning/error 发布语义不变。
* `OrderManagerImpl` 继续拥有 command `requestStartedAt`、pending claim 和错误包装；任何 snapshot / watermark helper 必须显式接收 `source` / `requestStartedAt` / `exchangeTs` / `receivedAt` 所需输入，不得在 helper 内自行推断命令水位。
* `store.ts` 是唯一维护 open/closed tables、`localOrderId -> location`、`(symbol, orderId)`、`orderId -> Set<localOrderId>`、`clientOrderId -> Set<localOrderId>` 的模块；insert/delete/move/trim 必须统一走 store helper，同步四个内部结构，裁剪必须走 delete helper。`order-manager.ts` 不应散落直接维护这些主表和索引的 `Map.set/delete`。
* 拆分应优先移动纯逻辑和内部 store/index 逻辑；需要 `ClientContext` 的事件发布、错误包装、runtime health 发布仍留在 manager。
* 不拆 `OrderCommandService`、`OrderEventPublisher` 这类较高层 service；命令路径仍留在 `OrderManagerImpl`，避免把 P0-2 watermark / pending claim / 错误包装这条敏感路径打散。
* 只做 refactor，不新增订单功能，不做 WS 下单实现。

## Acceptance Criteria

* [x] `order-manager.ts` 只保留 public API、lifecycle、runtime coordination、事件发布、错误包装、records ownership、command orchestration/pending claim；identity/store/snapshot/status 纯逻辑不再内联，除必要委托调用外不保留重复实现。
* [x] 内部模块命名清晰，无公共 barrel 导出，也不从 `src/index.ts` 导出。
* [x] 无循环依赖；纯类型依赖使用 `import type`。
* [x] P0-2 关键断言仍覆盖并通过：WS filled 先于 REST ack 不回退、`cancelAllOrders()` 合成 `exchangeTs: undefined` ack 不覆盖命令期间的新 WS fill、filled/remaining 不回退。
* [x] store/index 不变量仍覆盖并通过：closed 裁剪无索引悬挂、open 不被裁剪、cid-only provisional 迁移不重复、同 orderId/clientOrderId 多命中选择规则不变。
* [x] `order.snapshot_replaced` 仍返回全量 retained snapshot；reconcile/backfill 仍按 venue identity 判断 open-set 缺口。
* [x] `bun run lint`、`bun run type-check`、`bun run test` 通过。
* [x] P0-2 新增的竞态测试仍通过。

## Out Of Scope

* 改 public API、事件名、snapshot 字段或错误 code。
* 改 adapter contract、runtime/private coordinator 职责。
* 做性能优化或新功能。
* live / soak 测试。

## Technical Notes

* 相关规范：`.trellis/spec/backend/code-organization.md`、`.trellis/spec/backend/type-safety.md`、`.trellis/spec/backend/order-execution.md`、`.trellis/spec/backend/quality-guidelines.md`。
* 已确认拆分方案：保留 `order-manager.ts` 作为领域入口和 runtime 编排；内部模块不从 `src/index.ts` 导出，也不引入 public barrel。
* 为兼容现有测试里对 `orderManager.records` 的调试访问，本任务不把 `records` 整体藏进新类；`store.ts` 以纯函数形式操作 manager 持有的 `OrderRecord`。
