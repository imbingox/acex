# Codex 对本 PRD 的独立评审(2026-06-09)

> 评审对象:本任务 prd.md 的设计。codex 只读检查了 order-manager.ts / types/order.ts / watermark.ts / adapters/types.ts / private-subscription-coordinator.ts / context.ts / order.test.ts + 两份 research。下面是结论与本任务的采纳情况。

## 总体评价
方向 sound(open/closed 分表、按 symbol 局部化、orderId 主键、closed 裁剪都对),但需先补齐若干决策再开工,否则"内存有界"与身份索引有漏洞。→ 已在 PRD 全部处理。

## 赞同的点
- open/closed 分表使 `getOpenOrders` 与历史终态数解耦(现状是 `record.snapshots.values()` 全扫)。
- `(symbol, orderId)` 主身份正确;binance orderId 安全范围是 per-symbol。
- closed-only 裁剪、不裁 open 正确。
- 不可变 snapshot 替换语义正确(`createSnapshot` 每次返回新对象)。

## 风险/缺陷与采纳
- **高 #1 全局内存未必硬有界**:per-symbol N 只保证单 symbol 有界,总量 = `symbolCount × N`;持续交易新 symbol 时空子表清理不触发。
  → 决策:用户确认 **venue symbol 有限**,维持 per-symbol N(PRD Assumptions/D3 记录此前提)。
- **高 #2 orderId 索引不能是单值全局**:binance orderId 仅 per-symbol 唯一,测试有 BTC/ETH 同 `orderId=1001`(`order.test.ts:1069,1121`)。
  → 采纳:索引按 `(symbol, orderId)` 精确 + orderId-only 歧义索引(`Map<orderId, Set<location>>`)。
- **高 #3 cid 索引单值不安全**:测试要求同 symbol 同 cid 不同 orderId 两单共存(`order.test.ts:1132`)。
  → 采纳:cid 索引 `Map<cid, Set<location>>` 一对多。
- **高 #4 无 orderId 的终态更新策略缺失**:`RawOrderUpdate.orderId` optional。
  → 采纳:contract 要求终态带 orderId + 运行时 provisional cid-key 兜底(D4)。
- **中 #5 `getOrder({clientOrderId})` 语义变化**:现状 closed 也能命中 cid(`order-manager.ts:348`)。
  → 决策:**保持** cid 覆盖 open+closed(不退化),把 O(n) 全扫优化成索引;多命中返回最新。consume 了该行为变化担忧。
- **中 #6 裁剪丢 watermark 历史**:closed 被裁后旧终态事件迟到会被当新单重插、重复发事件。
  → 决策:**接受**(罕见),spec 注明,不加 tombstone(D5)。
- **中 #7 `snapshot_replaced` 须发全量**:现 reconcile 发布 open+retained closed 全量(`order-manager.ts:518`),分表后别只发 open。
  → 采纳:PRD Requirements/AC 明确全量。
- **中 #8 open 侧 stale 增长**:reconcile 回补失败保留 stale open(`order-execution.md:85`),open 不裁剪。
  → 决策:"硬有界"范围限定 closed 历史;open 的 stale 清理是现有 reconcile 行为,本任务不改。
- **低 #9 option 未接入类型**:`CreateClientOptions` 仅 market/account(`shared.ts:107`),`OrderManagerImpl` 构造未接 options(`runtime.ts:137`)。
  → 采纳:PRD Requirements 含接入。
- **低 #10 批量裁剪 N 边界**:N=0/负/非整、N<10 时删 10% 可能删 0。
  → 采纳:N normalize,保证至少删 1、删到 ≤ N。

## 实现建议(采纳)
- 索引放每个 `OrderRecord` 内,避免 manager 级裸全局 Map。
- `OrderLocation = { table, symbol, key }`,增删改只走 `insertSnapshot`/`deleteSnapshot`/`moveSnapshot`。
- orderId 精确索引用 `(symbol, orderId)`;orderId-only 单独歧义索引。
- cid 索引 `Map<cid, Set<location>>`;closed 带 cid 查询用 snapshot 字段校验。

## 遗漏的测试建议(纳入 AC)
跨 symbol 同 orderId、同 cid 多 open、cid-only→orderId 迁移、open→closed 迁移、裁剪后索引无悬挂、空子表清理、disappeared backfill 后裁剪不回退、双 id conjunctive 匹配。
