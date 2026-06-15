# handle Binance ACCOUNT_CONFIG_UPDATE leverage

## Goal

Binance PAPI private WebSocket 收到 `ACCOUNT_CONFIG_UPDATE` 时，用事件里的 symbol 和 leverage 更新对应 USDⓈ-M 仓位快照，让本地 `PositionSnapshot.leverage` 不必等下一轮 REST risk refresh/reconcile 才校准。

## What I Already Know

* 当前 Binance private adapter 连接 `wss://fstream.binance.com/pm/ws/<listenKey>`。
* `parsePrivateMessage()` 已放行 `ACCOUNT_CONFIG_UPDATE`，但 `dispatchPrivateMessage()` 目前直接忽略。
* Binance PAPI `ACCOUNT_CONFIG_UPDATE` 的 futures 配置更新示例包含 `ac.s` 和 `ac.l`，分别代表 symbol 和 leverage。
* SDK 当前 Binance 私有账户能力面向 PAPI UM，仓位快照已有 `leverage?: string` 字段。

## Assumptions

* 本任务只处理 PAPI UM futures leverage update，不扩展 COIN-M、margin spot、条件单或算法单能力。
* 若对应 symbol 无本地 position，仍允许通过 account update 路径创建/更新一个 size 为 `0` 的 position update；AccountManager 当前会删除 zero-size position，因此实际效果是只对已有 position 生效。
* symbol mapping miss 应复用现有 quarantine + catalog refresh 机制，避免新上市 symbol 事件被立即丢弃。

## Requirements

* 解析 `ACCOUNT_CONFIG_UPDATE` 的 `ac.s` 和 `ac.l`。
* 将 `ac.s` 从 Binance venue symbol 映射为 SDK unified symbol。
* 通过现有 account update callback 更新对应仓位的 `leverage`。
* 使用事件 `T ?? E` 作为 exchange timestamp，使用 WS receivedAt 作为 receivedAt。
* 保留现有 unknown-symbol quarantine/replay 行为。
* 无有效 symbol 或 leverage 时不发布无效更新。

## Acceptance Criteria

* [x] 单测覆盖 `ACCOUNT_CONFIG_UPDATE` 会更新已有仓位的 `leverage`。
* [x] 单测覆盖 unknown symbol 经过 catalog refresh 后 replay，leverage update 不丢。
* [x] 现有 `ACCOUNT_UPDATE` / `ORDER_TRADE_UPDATE` / `riskLevelChange` 行为不回退。
* [x] lint/typecheck/test 通过。

## Definition of Done

* Tests added/updated.
* Lint / typecheck / targeted tests green.
* Docs/notes updated if public behavior needs mention.
* Scope remains limited to Binance PAPI UM leverage update.

## Out of Scope

* 条件单、算法单、margin spot order/account event 支持。
* COIN-M private stream 支持。
* 新增公开 event type；本任务更新现有 account position state。
* 杠杆设置 API。

## Technical Notes

* Main implementation likely in `src/adapters/binance/private-adapter.ts`.
* Account state merge path is `AccountManager.onPrivateAccountUpdate()`, which already watermarks position updates and preserves unspecified fields from previous snapshots.
* Relevant tests likely in `tests/unit/binance-private-adapter.test.ts` and/or `tests/integration/account.test.ts`.
