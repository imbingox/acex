# OrderManager 存储分层与 closed 订单裁剪

## Goal

重构 `OrderManagerImpl` 的内部订单存储,解决终态订单无界累积导致的内存膨胀与查询退化,并按访问模式分层。在不破坏现有 reconcile / watermark / 不可变快照 / 事件语义的前提下,支持:(1) 高效查询当前所有挂单;(2) 按 id(可不带 symbol)查询具体订单;(3) 对 closed 订单(canceled/filled/rejected/expired)按 **per-symbol** 数量上限裁剪,每 symbol 只保留最近 N 个(client option `maxClosedOrdersPerSymbol`,默认 500)。

## What I already know

### 现状问题(已确认)
- 单表 `OrderRecord.snapshots: Map<lookupKey, OrderSnapshot>` 同时存所有状态订单,**终态订单永不删除** → 无界增长。
- 终态订单两条进入路径:正常成交/撤单走 `onPrivateOrderUpdate`;WS 漏消息的挂单经 reconcile→`backfillDisappearedOrders`→`fetchOrder`→`onPrivateOrderUpdate` 回灌终态(`private-subscription-coordinator.ts:741-871`)。两条都沉淀进同一 Map 且无清理。
- `getOpenOrders`(`order-manager.ts:324`)= 全表 `filter(isOpenOrder)`,O(全部历史);`getOrder`(`:289`)线性扫描;`setSnapshot`(`:656-664`)删同身份用**全表扫 O(n)**——写入瓶颈。

### acex 定位(用户确认)
- acex 定位是**策略自动下单(发起型 OMS)**;reconcile 仅为 WS 漏消息兜底,**不是**为管理大量外部单。→ 长期看本地生成 cid 的身份模型契合定位(见 Decision 的目标态),但本任务不做。

### venue / WS 下单调研结论
- 仅两个私有 adapter:**binance**(可下单)、**juplend**(`readOnly`,`clientOrderId:false`,不下单)。
- `RawOrderUpdate.orderId` 与 `.clientOrderId` 均 optional(`adapters/types.ts:160-162`);`CreateOrderRequest.clientOrderId` optional,SDK **不自动生成**,binance 仅在调用方提供时回显;binance 实践中 create/cancel/openOrders/`ORDER_TRADE_UPDATE` 总返回 orderId。
- **WS 下单不存在**:私有 WS 仅 listen-key 用户流、receive-only(`order-execution.md:84`)。
- 现有身份机制已较鲁棒(`getOrderLookupKey`/`shouldMatchOrderIdentity`/双向 carry-forward),能容忍 orderId 后填充。

### 调研:身份与 cid(详见 Research References)
- binance `clientOrderId` 服务端自动生成(app/web/外部单的 `c` 几乎从不为空),但官方定义"unique id among **open** orders"、**终态后可复用**、ADL 共享 `adl_autoclose` 字面量 → **非生命周期稳定唯一键**;`orderId` 才是 **per-symbol** 稳定唯一(非全局唯一)。
- 主流 OMS = 双身份(client id 主 handle + exchange-id 反向索引);观察型库用 exchange id。

### 参考:用户既有 Python OrderManager(评审结论)
- **借鉴**:open/closed 分层、按 symbol 嵌套、按 status 路由+跨表清理、批量摊销裁剪。
- **不照搬**:对 open 表也裁剪(误删挂单)、原地 mutate(acex 用不可变替换)、单 cid 主键、`>=` 粗比较。

## Assumptions

- 裁剪只作用于 closed;open 永不因容量被裁。
- 保持 `OrderSnapshot` 不可变替换语义。
- 保持 watermark / reconcile / 事件发布行为不回退。
- **内存有界依赖"venue symbol 集合有限"这一前提**(binance 交易对有限),故 per-symbol 上限即可,无需全局 cap。

## Open Questions

- (已收敛 — 见 Decision 段;实现期细节:批量摊销步长、option 默认值/命名校验)

## Requirements

- **核心优先级**:内存有界是**硬约束**;在此前提下**优先查询/写入效率**,可牺牲部分存储(closed 总量 ≈ 活跃 symbol × N)。
- 身份策略 = **复合身份**:`(symbol, orderId)` 为主键;`clientOrderId` 为二级索引。沿用现有身份匹配,不改对外契约(`getOrder`/`cancelOrder` 仍可只给 orderId 或 clientOrderId、symbol 可选)。
- 内部存储分 **open / closed 两表**,均按 **symbol 嵌套** `Map<symbol, Map<orderKey, snapshot>>`;写入(删同身份)、裁剪、按 symbol 查询局部化到子表。
- closed 裁剪 = **按 symbol 子表各留 N**:上限经 client option **`maxClosedOrdersPerSymbol`**(默认 500)可配;超限子表内按 FIFO **批量摊销**裁剪(一次删约 N 的 10%);N 需 **normalize**(非正/非整时落到安全默认;保证每次至少删 1、删到 ≤ N)。
- open 订单永不因容量被裁剪。
- **清理空 symbol 子表**(订单清零/账户移除时移除 key),symbol 维度不累积空 Map。
- **查询索引(放在每个 `OrderRecord` 内,避免跨 account/venue 泄漏)**:
  - `(symbol, orderId)` 精确索引,覆盖 open+closed,支持 O(1) 定位。
  - orderId-only 歧义索引 `Map<orderId, Set<location>>`,支持 `getOrder` **不带 symbol** 命中;跨 symbol 同 orderId 多命中时返回最新(seq 最大)。
  - `clientOrderId` 索引 `Map<cid, Set<location>>`,**覆盖 open+closed**(保持现有"cid 能查 closed"行为);多命中返回最新(seq 最大,open 优先)。精确定位历史单需用 orderId。
  - **三索引随主存储增删严格同步**(裁剪 / 空子表清理 / open→closed 迁移 / 账户移除时删除对应条目),条目数 ≤ 订单总数,不额外无界增长。
- **无 orderId 的终态单兜底**:`adapter-contract.md` 写明"终态更新应带 orderId";运行时若收到无 orderId 的终态单,用 `clientOrderId` 作 **provisional** closed key 存入(不丢数据)+ warning;拿到 orderId 后迁移到正式 key。连 cid 都无则丢弃 + warning。
- 统一通过 `insertSnapshot` / `deleteSnapshot` / `moveSnapshot` 三个 helper 维护"主存储 + 三索引",避免散落不同步。
- `getOpenOrders` 查询复杂度与历史终态订单数量无关。
- `snapshot_replaced` 事件继续发布**全量**(open + 保留的 closed),分表后不得只发 open(避免语义回退)。
- 保持不可变快照、watermark、reconcile、事件语义不回退。
- closed option 接入 `CreateClientOptions`(`src/types/shared.ts`)并贯通到 `OrderManagerImpl` 构造(`src/client/runtime.ts`)。

## Acceptance Criteria

- [ ] 单 symbol closed 超 N 后批量裁剪最旧,该子表稳定在 ≤ N。
- [ ] open 挂单数超过 N 时不被裁剪(数据正确性)。
- [ ] `getOpenOrders` 不随历史订单线性变慢(基准/单测验证)。
- [ ] `getOrder` 能查到 open 与未裁剪的 closed;**不带 symbol** 经 orderId 索引仍命中;**带 clientOrderId 能命中 closed**(行为不回退)。
- [ ] 同账户跨 symbol 同 `orderId`(BTC/ETH=1001)带 symbol 精确区分(参考 `order.test.ts:1069-1129`)。
- [ ] 同 symbol 同 `clientOrderId` 不同 orderId 的两个 open 单共存、cid 查询不互相覆盖(参考 `order.test.ts:1132`)。
- [ ] cid-only open 单收到 orderId 后迁移 key、不留旧 key/索引;open→closed 迁移正确(从 open 删、写 closed、索引更新)。
- [ ] closed 裁剪 / 空子表清理 / 账户移除时三索引同步删除,无悬挂条目。
- [ ] 空 symbol 子表在订单清零后被移除。
- [ ] `getOrder({orderId, clientOrderId})` 维持"两者同时匹配"(conjunctive)语义(`order-manager.ts:321`)。
- [ ] reconcile disappeared backfill 写入终态并触发裁剪后,`getOpenOrders` 不回退;`snapshot_replaced` 仍为全量。
- [ ] 现有 reconcile / watermark / 事件单测与集成测试全绿。
- [ ] `order-execution.md` / `adapter-contract.md` 记录新存储约定、cid 查询语义变化、裁剪后迟到事件可能重复、三表演进触发条件。

## Definition of Done

- 单测/集成测试新增或更新(分表迁移、裁剪、查询、索引同步、迁移路径)。
- `bun run lint` / `bun run type-check` / `bun run test` 全绿。
- 行为/语义变化反映到 `docs/api.md` 与相关 spec。
- src/ 重构配套 patch changeset(无对外 API 变更也需要)。

## Out of Scope

- 实现 WS 下单/撤单本体。
- `submitting` 在途态与三表设计(仅 spec 记录演进路径)。
- **本地生成 clientOrderId 的身份模型(NautilusTrader 式)+ `venueOrderId→localCid` 映射**——独立任务,与 WS 下单演进绑定;本任务仅在 spec 记录为目标态。
- 改变 adapter 层契约的其他行为或各 venue 行为(除新增"终态应带 orderId"约定)。
- 持久化 closed 到磁盘/外部存储。

## Decision (ADR-lite)

### D1 身份与索引(方案 A,2026-06-09)
- **Context**:cid 在 binance 仅 open 内唯一、终态可复用、ADL 共享字面量;orderId 仅 per-symbol 唯一(非全局)。
- **Decision**:`(symbol, orderId)` 主键 + 三索引(见 Requirements)。closed 强制 orderId 主键(规避 cid 复用覆盖);orderId 索引必须按 `(symbol, orderId)` 而非裸 orderId(跨 symbol 会冲突);cid 索引用 `Set` 一对多、覆盖 open+closed、返回最新消歧。
- **Consequences**:保持现有 cid 能查 closed 的行为;复用/ADL 时 cid 查返回"最新"为弱约定,精确定位用 orderId。

### D2 分表数量(2026-06-09)
- MVP **open / closed 两表**,不引入 submitting(REST 下单同步、无在途窗口)。
- 演进:WS/异步下单落地时扩展为 `submitting + open + closed` 三表并扩 `OrderStatus`,须写入 `order-execution.md`。

### D3 分表组织与裁剪(2026-06-09)
- 两表按 **symbol 嵌套**,把写入/裁剪/查询局部化,避开全表扫 O(n)。
- closed **按 symbol 各留 N**(默认 500,可配),FIFO **批量摊销**;内存有界三保险:子表 FIFO 上限 + 清理空子表 + 索引同步删除;依赖 venue symbol 有限前提。

### D4 无 orderId 终态单(2026-06-09)
- contract 要求终态带 orderId;运行时兜底为 provisional cid-key closed + warning,拿到 orderId 后迁移。

### D5 裁剪后迟到事件(2026-06-09)
- **接受**:closed 被裁后同一旧终态事件若迟到,可能被当新订单重新插入并重复发事件(罕见,影响小)。不加 tombstone,spec 注明。

### D6 分阶段与目标态(2026-06-09)
- 本任务用 orderId 主键解决内存膨胀,不做身份模型重构。
- 目标态(记入 spec):NautilusTrader 式**本地生成 cid 主键 + `venueOrderId→localCid` 映射**,契合 acex 发起型定位,与 WS 下单一起作为独立任务实施。

## Research References

* [`research/binance-client-order-id-behavior.md`](research/binance-client-order-id-behavior.md) — cid 仅 open 内唯一、可复用、ADL 字面量;orderId per-symbol 唯一。
* [`research/order-key-convention.md`](research/order-key-convention.md) — 主流双身份;Nautilus/Hummingbot client-id 主键 + venue-id 反向索引;观察型库用 exchange id。
* [`research/codex-prd-review.md`](research/codex-prd-review.md) — codex 对本 PRD 的独立评审(已采纳:复合 orderId 索引、cid 一对多、全量 snapshot 事件、option 接入、N normalize、helper 化、provisional 兜底)。

## Technical Notes

- 关键文件:`src/managers/order-manager.ts`、`src/types/order.ts`、`src/internal/watermark.ts`、`src/client/private-subscription-coordinator.ts`、`src/client/context.ts`、`src/types/shared.ts`、`src/client/runtime.ts`。
- 相关 spec:`.trellis/spec/backend/order-execution.md`、`.trellis/spec/backend/adapter-contract.md`。
- 实现建议(codex):定义 `OrderLocation = { table: "open"|"closed"; symbol: string; key: string }`;所有增删改只走 `insertSnapshot`/`deleteSnapshot`/`moveSnapshot`;索引放每个 `OrderRecord` 内。
- 测试参考:`tests/integration/order.test.ts`(getOrder 带/不带 symbol、跨 symbol 同 orderId、同 cid 多单)。
- 与 in_progress 任务 `06-09-binance-open-orders-reconcile` 强相关但独立:本任务聚焦内存存储结构,不改 reconcile 对账算法。
