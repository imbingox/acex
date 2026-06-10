# order manager 本地 cid 句柄与 submitting 阶段演进

## Goal

在「OrderManager 存储分层 / 复合身份 / closed 裁剪」之上,落地 `order-execution.md` §6 的演进**第一步**:把内部存储从 `(symbol, orderId)` 主键演进为**统一 `localOrderId`(SDK 生成、纯内部代理主键)**的 NautilusTrader 式发起型 OMS 模型——含外部/ADL 单 external-order-claim 补发、`localOrderId` 反向索引、SDK 下单前生成并发送 cid。**公开 API 不变**(`orderId`/`clientOrderId` 字段与签名都不动),全部为内部重构 + cid 生成行为变化,为后续 WS/异步下单 + submitting 铺好地基。

## Decisions (ADR-lite)

- **D1 — scope 只做身份地基**:只做内部身份模型 + 反向索引 + cid 生成;**不**做 submitting 相位 / 第三张表 / `OrderStatus` 扩展 / WS 异步下单(同步 REST 无可观测 submitting 窗口,§6)。
- **D2 — 三类 id(内部概念)**:`localOrderId`(SDK 生成的内部代理主键)/ `venueOrderId`(交易所 `payload.i`,per-symbol 唯一、lifetime 稳定)/ `venueClientOrderId`(交易所 `payload.c`,可调用方自带、ADL/外部为交易所字符串、非可靠主键)。**公开字段沿用旧名**:public `orderId` == venueOrderId、public `clientOrderId` == venueClientOrderId(见 D7)。
- **D3 — `localOrderId` 完全 SDK 生成、永远内部**:一律 SDK 生成,纯内部主键,永远规范唯一,调用方不能指定;**不暴露在 public OrderSnapshot/输入上**(即便将来异步下单也不必暴露,见 D7)。
- **D4 — 统一 `localOrderId` 主键 + external-order-claim(Q7=A)**:全量订单(SDK 发起 + ADL/强平/外部会话)统一以 `localOrderId` 为内部主键;外部/系统单首见时 SDK **补生成 `localOrderId`**,由 `(symbol, venueOrderId)` 锚定保证同进程内稳定(重启会变,外部单可接受)。
- **D5 — 调用方可选自带 `clientOrderId` + 反向映射(合并 ①/②)**:调用方仍可在 create 传 `clientOrderId`(= venueClientOrderId,venue-facing);SDK 维护**四个**指向主键的内部结构(由现有三索引演进,均经 helper 严格同步、**随 closed 裁剪一并删除**):
  1. 主存储 `localOrderId → location`(open/closed 子表);
  2. `(symbol, venueOrderId) → localOrderId`(精确 1:1,**权威路径**);
  3. `venueOrderId → Set<localOrderId>`(无 symbol 查询;跨 symbol 同 orderId 时 1:多);
  4. `venueClientOrderId → Set<localOrderId>`(**1:多**;`adl_autoclose` 共享 + cid 终态后可复用)。
  - **resolution 优先级**(沿用上一任务 §4):orderId+symbol → 索引2 精确;仅 orderId → 索引3 消歧;仅 clientOrderId → 索引4 消歧;两者都给 → conjunctive(都匹配才命中)。多命中消歧:**open 绝对优先 → 同档 updatedAt 最新**(不用 seq)。ADL 务必用 orderId 精确定位;`adl_autoclose` 的 cid-only 查询本质歧义。1:多 索引的意义在于存/裁时不破坏索引,而非把共享 cid 当有用查询键。
- **D6 — 未传 cid 时发 `localOrderId`(Q6=P)**:调用方未传 `clientOrderId` 时,SDK 把生成的 `localOrderId` 作为 `newClientOrderId` 发往 Binance(SDK 下单前即知 cid,为超时恢复铺路;这些单 venueClientOrderId == localOrderId)。故**会被发送的 `localOrderId` 必须满足 Binance 约束**(≤32、`^[\.A-Z\:/a-z0-9_-]{1,32}$`、不撞当前 open 单)。调用方传了则发其值。
- **D7 — 公开 API 不变(Q4=β)**:不重命名 `orderId`/`clientOrderId`(各交易所通用字段名);`localOrderId` 永远内部不暴露。理由:localOrderId 永远内部 → 无 breaking 时机压力;`clientOrderId`(D6 下 == localOrderId 或调用方自带值)已足够当调用方稳定句柄,内部索引再解析到 localOrderId。**结果:public 类型零改动,仅 cid 生成行为变化**。
- **D8 — 现在投资完整内部模型(Q7=A)**:明确选择现在把 localOrderId 统一主键架构落到位,而非推迟。代价:重排上一任务刚稳定的存储主键(churn/回归风险,靠测试覆盖兜底);收益:Nautilus 架构一次到位,异步任务不必再动主键。

- **D9 — codex review 修订(已采纳)**:
  - **pending claim(补 scope)**:发 REST **前**登记内部 `venueClientOrderId → localOrderId` pending map,避免下单后/REST 返回前早到的 WS 把同一笔单当外部单再补一个 localOrderId(双建)。REST 明确失败/拒单→清理;超时(未知)→保留待后续 WS/reconcile 用同一 cid 复用(不主动查询)。**pending map ≠ submitting**:无 public 状态、无第三张表、不扩 `OrderStatus`,不违反 D1。
  - **生成器唯一性拆两层**:内部 `localOrderId` 在 OrderManager 实例**全局**唯一(查 `localOrderId→location` + pending);作为 `newClientOrderId` **发送**时只需在**该账户当前 open** 的 venueClientOrderId 不撞。
  - **cid-only claim 规则**:带 venueOrderId 永远先走 `(symbol,venueOrderId)`;cid-only 仅能 claim「同 symbol 同 cid 且无 venueOrderId」的 provisional;系统字面量(`adl_autoclose`/`autoclose-*`/`settlement_autoclose-*`)cid-only 不稳定归并、发 warning(复用现有 warn 机制)。
  - **reconcile open-set diff 仍基于 venue identity**(orderId/cid alias),不得改用 local 主键比较,避免 orderId 后到 / cid-only 迁移时误判 disappeared。
  - **行为变化**:未传 cid 现返回 SDK 生成的 `acex-*` 而非 Binance 生成值 → 补 changeset/release note;测试断言未传时请求带合规 cid 且 `snapshot.clientOrderId` == 该值;**mock 回显请求 cid**,否则假绿。
  - **C4 自带 cid 本地校验**:对调用方自带 `clientOrderId` 做 ≤32 + 字符集校验,不合规抛 `ORDER_INPUT_INVALID`(fail-fast)。

## Requirements

- 内部存储主键由 `(symbol, orderId)` 演进为统一 **`localOrderId`**;open/closed 两表与 closed FIFO 裁剪结构保留,主键/索引随之调整(D4)。
- `localOrderId` 完全 SDK 生成(D3);可能被发送的(D6 未传分支)满足 Binance `newClientOrderId` 约束;纯内部(外部单补发)仅需唯一。建议单一生成器、`acex-` 前缀、≤32。
- `createOrder`:生成 `localOrderId` → 未传 cid 发 localOrderId / 传了发其值(D6)→ 命令成功以 localOrderId 入库;snapshot 的 public `clientOrderId` 落实际 venueClientOrderId。
- 外部/ADL 单(bootstrap/reconcile/WS,非经 createOrder)首见补发 `localOrderId`,`(symbol, venueOrderId)` 锚定同进程稳定(D4)。
- **四个**内部结构经 `insertSnapshot`/`deleteSnapshot`/`moveSnapshot` 严格同步:`localOrderId→loc`、`(symbol,venueOrderId)→localOrderId`(1:1)、`venueOrderId→Set<localOrderId>`(无 symbol、跨 symbol 1:多)、`venueClientOrderId→Set<localOrderId>`(1:多);**closed FIFO 裁剪经 `deleteSnapshot` 同步删除该单在全部结构的条目**(Set 仅删该 localOrderId 成员、删空清理),无悬挂(D5)。
- `getOrder`/`cancelOrder`:public 输入仍按 `orderId`/`clientOrderId`(D7),SDK 内部解析到 localOrderId 主键再操作。
- **公开类型/签名零改动**(D7);`localOrderId` 不出现在任何 public 类型。
- 不破坏:open/closed 分层、closed 裁剪、reconcile/backfill 语义、`OrderSnapshot` 不可变替换、watermark(相同 exchangeTs terminal 不被 open 覆盖、filled 不倒退)、`order.snapshot_replaced` 全量(open + 保留 closed)。

## Acceptance Criteria

- [ ] `createOrder` 未传 `clientOrderId`:SDK 生成合规 cid 并作为 `newClientOrderId` 发出(非交给 Binance 自动生成);snapshot.clientOrderId == 该 cid;内部以 localOrderId 入库。
- [ ] `createOrder` 传了 `clientOrderId`:发其值;snapshot.clientOrderId == 该值;内部 localOrderId 为独立 SDK 值,索引可由该 clientOrderId 命中。
- [ ] 内部主键为 localOrderId;四个内部结构(`(symbol,venueOrderId)` 1:1、`venueOrderId→Set`、`venueClientOrderId→Set` 1:多)均能正确命中 localOrderId;增删改 + **closed 裁剪后无索引悬挂**(Set 仅删该成员、删空清理)。
- [ ] resolution 优先级:orderId+symbol 走精确权威路径;仅 orderId / 仅 clientOrderId 多命中按 open 优先 → updatedAt 最新消歧;orderId+clientOrderId conjunctive;ADL 共享 `adl_autoclose` 经 orderId 精确定位。
- [ ] 外部/ADL 单首见补发 localOrderId;同 `(symbol, venueOrderId)` 再次到达复用同一 localOrderId(同进程稳定)。
- [ ] 多笔 ADL 单共享 `adl_autoclose`:由各自 localOrderId/`(symbol,orderId)` 正确区分;`clientOrderId→localOrderId` 为 1:多。
- [ ] `getOrder`/`cancelOrder` 按 public `orderId`/`clientOrderId` 仍正确(内部解析到 localOrderId);cancel 走 origClientOrderId/orderId 不变。
- [ ] public 类型零改动:`OrderSnapshot`/`*Input` 无 `localOrderId` 字段,`orderId`/`clientOrderId` 名称不变。
- [ ] 既有不变式回归:closed FIFO 裁剪、open 不裁、不可变替换、watermark 不倒退、`snapshot_replaced` 全量、reconcile/backfill 终态语义。
- [ ] pending claim:下单后、REST 返回前到达的 WS(同 cid)复用同一 localOrderId、不双建;REST 失败清理 pending、超时保留。
- [ ] 生成器:内部 localOrderId 全局唯一、发送 cid 不撞该账户 open;自带不合规 cid 抛 `ORDER_INPUT_INVALID`。
- [ ] reconcile open-set diff 基于 venue identity:orderId 后到 / cid-only 迁移不误判 disappeared。
- [ ] 行为变化:未传 cid 时请求带合规生成 cid、`snapshot.clientOrderId` == 该值(mock 回显请求 cid 防假绿)。
- [ ] `bun run lint` / `type-check` / `test` 全绿;`order-execution.md` 同步更新;补 changeset(含未传-cid 行为变化 release note)。

## Out of Scope

- `submitting` 相位 / 第三张表 / `OrderStatus` 扩展;WS/异步下单路径(推迟,§6)。
- 下单超时未知 ack 的**主动恢复查询**(本任务只保证 cid 已 SDK 生成并发送,为其铺路)。
- **公开字段重命名 / 暴露 `localOrderId`**(D7 决定不做;将来异步也不必做)。
- 新 venue 接入(仍只 Binance PAPI UM)。

## What I already know

- 实现 `src/managers/order-manager.ts`(`OrderManagerImpl`);public 契约 `src/types/order.ts`(`OrderSnapshot`/`OrderStatus`/`*Input`,`clientOrderId?` 在 `:61`)。
- 当前主键 `(symbol, orderId)`,`clientOrderId→Set<location>` 索引(1:多),provisional `client:{cid}` 处理无 orderId 终态;open/closed 两表 + FIFO 裁剪(默认 500),全经 `insertSnapshot`/`deleteSnapshot`/`moveSnapshot`。
- **当前 cid 由 Binance 生成**:`src/adapters/binance/private-adapter.ts:808` `newClientOrderId: request.clientOrderId` 直透,未传 → Binance 生成、`payload.c` 返回;`:770/:842` 撤单用 `origClientOrderId`;`payload.i→orderId`、`payload.c→clientOrderId`。
- 下单同步 REST,`createOrder()` 返回即有 orderId;`OrderStatus` 无 submitting。
- Binance 约束(research):PAPI UM `newClientOrderId` ≤32、`^[\.A-Z\:/a-z0-9_-]{1,32}$`、unique-among-open(终态可复用);系统单 `autoclose-*`/`adl_autoclose`(固定字面量)/`settlement_autoclose-*`;`venueOrderId` 唯一 lifetime 稳定。

## Technical Notes

- 关键文件:`src/managers/order-manager.ts`(主改:主键/索引/external-order-claim/cid 生成入口)、`src/adapters/binance/private-adapter.ts`(未传时发 SDK cid)、`src/types/order.ts`(预期零改动,确认)、`src/types/shared.ts`、`src/client/runtime.ts`、`src/adapters/types.ts`、`tests/integration/order.test.ts`。
- 索引演进:`(symbol,orderId)` 精确 / `orderId→Set` / `clientOrderId→Set` → 主键 `localOrderId` + `(symbol,venueOrderId)→localOrderId`(1:1) + `venueOrderId→Set<localOrderId>`(无 symbol) + `venueClientOrderId→Set<localOrderId>`(1:多)。resolution 优先级见 D5。
- cid 生成器:`acex-` 前缀 + 紧凑唯一后缀(base62/计数),≤32,字符集合规,生成时查当前 open 子表防撞。

## Research References

- [`order-key-convention.md`](../archive/2026-06/06-09-order-manager-store-tiering-and-closed-order-eviction/research/order-key-convention.md) — Nautilus `ClientOrderId` 主键 + `_index_venue_order_ids` 反向 + **external-order-claim**(给 venue-only 单补发 id);dual-identity 主流。直接支撑 D4/D5。
- [`binance-client-order-id-behavior.md`](../archive/2026-06/06-09-order-manager-store-tiering-and-closed-order-eviction/research/binance-client-order-id-behavior.md) — Binance cid 约束/复用/ADL 字面量;`venueOrderId` 才是 lifetime 主键。支撑 D6 与 cid 格式。
