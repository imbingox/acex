# brainstorm: market websocket subscription leases

## Goal

为 acex SDK 的 market websocket 订阅增加 per-consumer lease/handle API，让多个上层消费者共享同一个 client 时，不需要自行维护 owner/ref-count，也不会因为一个消费者释放订阅而误关闭其它消费者仍在使用的同一条 market 数据流。

## What I already know

* 当前 `MarketManagerImpl.subscribeL1Book()` / `unsubscribeL1Book()` 按 `venue:symbol` 在 `MarketRecord.l1BookStream` 保存单个底层 stream。
* 当前重复 `subscribeL1Book()` 会复用已有 stream，但 `unsubscribeL1Book()` 会直接关闭并清空该 stream。
* market-daemon 多策略共享单例 client 时，一个策略结束调用 `unsubscribeL1Book()` 会误关其它策略仍在使用的同 symbol L1。
* `SubscriptionMultiplexer` 已有 local subscriber/handle 模型，handle 形态为 `{ ready, close }`，但没有通过 `MarketManager` 公共 API 暴露。
* 用户倾向将这套逻辑推广到所有 market websocket，而不只 L1。
* 当前 funding rate websocket 也采用单个 `record.fundingRateStream` + 直接 close 的模式，存在同类多消费者误关风险。

## Assumptions

* 用户确认当前下游只有自己使用，可以接受 breaking change；应按最终推荐 API 设计，而不是优先保留历史兼容。
* SDK 不引入 `ownerId`，owner 归业务层，SDK 只暴露通用 lease/handle。
* `MarketDataStatus.activity` 继续使用现有 `"active" | "inactive"`，不新增 `"subscribed"` 字面量。
* 公共 API 应以 `acquire*Subscription()` 为主；用户确认旧 `subscribe*` / `unsubscribe*` 公共接口可以删除，不需要保留兼容 alias。

## Decisions

* 本任务里的 stop/restart 指 SDK client lifecycle：public `AcexClient.stop()` / `AcexClient.start()`，在 `MarketManagerImpl` 内部对应 `onClientStopping()` / `onClientStarted()`。不新增 public `market.stop()` / `market.restart()` API。
* `acquire*Subscription()` 的 Promise 只表示输入校验、market resolution、logical lease 注册完成；不等待首条 market data。
* 首次 market data readiness 由 `lease.ready` 表达；调用方需要 `const lease = await acquire...(); await lease.ready;`。
* 初始 ready 失败或 timeout 会自动释放对应 lease；如果多个 active leases 共享同一条底层 stream 且该 stream 初始化失败，所有仍 pending 的相关 leases 都应得到确定失败结果并释放引用。
* `lease.close()` 在 `ready` settle 前调用时，lease 立即释放，且该 lease 的 `ready` 必须 reject 为明确错误，不能永久 pending。
* `client.stop()` 关闭所有底层 market websocket，并将 snapshot/status 标为 inactive/stale，但保留 active logical leases。
* `client.start()` after stop 会按仍 active 的 logical leases 自动恢复底层 stream。
* stopped 期间调用 `lease.close()` 会正常减少引用；某 channel 的最后一个 lease 关闭后，后续 start 不再恢复该 channel。
* active lease 在 restart 恢复失败时不自动释放 logical lease；SDK 应关闭失败的底层 stream、发布错误并将对应 channel 标为 stale/disconnected，以便后续 start/reconnect 路径继续遵循已有 market lifecycle。初始 acquire 的 `lease.ready` 如果此前已经 resolved，不因 restart failure 重置。

## Requirements

* 新增 public lease type：`MarketSubscriptionLease { readonly ready: Promise<void>; close(): void }`。
* 新增 market websocket acquire API；L1 和 funding rate 均应覆盖：
  * `acquireL1BookSubscription(input: AcquireL1BookSubscriptionInput): Promise<MarketSubscriptionLease>`
  * `acquireFundingRateSubscription(input: AcquireFundingRateSubscriptionInput): Promise<MarketSubscriptionLease>`
* acquire input 可以复用现有 `SubscribeL1BookInput` / `SubscribeFundingRateInput` 的字段形状，但 public 命名应迁移到 acquire 语义，避免继续暴露 subscribe 术语。
* 文档应明确：推荐上层通过 `const lease = await acquire...(); await lease.ready; try { ... } finally { lease.close(); }` 管理订阅生命周期。
* 每次 acquire 返回独立 lease，`close()` 幂等。
* 同一 `venue:symbol` 的同一 market stream 底层只维护一条真实 stream。
* L1 与 funding rate 的 lease/ref-count 独立；同一 `venue:symbol` 关闭最后一个 L1 lease 不影响 active funding rate stream，反之亦然。
* 只有某 channel 最后一个 active lease 关闭后，SDK 才真正 unsubscribe/close 该 channel 的底层 stream。
* ready timeout、stream 初始化失败、ready 前 close 都必须释放对应 lease，不能泄漏引用。
* `MarketSubscriptionLease.ready` 表示本次 acquire 的首次 ready，不是跨 stop/restart 自动重置的 readiness signal；restart 后的 readiness 继续通过 status/events/snapshot 观察。
* 现有事件、snapshot、freshness、status 行为应保持一致。

## Acceptance Criteria

* [x] `Promise.all` 并发 acquire 同一 `venue:symbol` 的 L1 两次，只创建一次 L1 底层 stream，返回两个独立 leases。
* [x] `Promise.all` 并发 acquire 同一 `venue:symbol` 的 funding rate 两次，只创建一次 funding rate 底层 stream，返回两个独立 leases。
* [x] L1 close 第一个 lease 后，L1 底层 stream 不关闭，数据/status 仍可用；close 第二个 lease 后，L1 底层 stream 才关闭。
* [x] Funding rate close 第一个 lease 后，funding 底层 stream 不关闭，数据/status 仍可用；close 第二个 lease 后，funding 底层 stream 才关闭。
* [x] close 幂等。
* [x] 多个 leases 同时 pending 同一底层 stream 时，首条数据到达后所有 leases 的 `ready` resolve。
* [x] 底层 stream 初始 ready timeout/failure 时，所有仍 pending 的相关 leases 的 `ready` reject，引用被清理，底层 stream 被关闭并清空。
* [x] `lease.close()` 发生在 `ready` settle 前时，该 lease 引用被清理，`ready` reject，不再收到后续数据；其它 active leases 不受影响。
* [x] acquire 后、首次 ready 前调用 `client.stop()` 时，底层 stream 关闭，active lease 保留，`lease.ready` 继续 pending；随后 `client.start()` 恢复 stream，首条数据到达后该 lease 的 `ready` resolve。若 stopped 期间 close 该 lease，则 `ready` reject 且 start 不恢复。
* [x] L1 与 funding rate channel 独立：同一 `venue:symbol` 下关闭最后一个 L1 lease 不关闭 funding stream；如果 funding lease 仍 active，聚合 `MarketDataStatus.activity` 不变为 inactive。
* [x] 删除 legacy `subscribe*` / `unsubscribe*` 公共接口，repo 内调用和文档全部迁移到 acquire API。
* [x] client stopping 会关闭所有底层 stream，并按定稿语义处理 lease/ref 状态。
* [x] restart 后 active leases 对应的 market websocket 会自动恢复；stopped 期间关闭全部 leases 后不会恢复。
* [x] Public `MarketManager` 类型不再暴露 legacy subscribe/unsubscribe，README、`docs/api.md`、scripts、unit/integration/soak tests 全部编译迁移。
* [x] 增加 changeset 或 release note 说明 breaking change。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 不在 SDK API 中引入 `ownerId`。
* 不修改业务层 daemon 的 owner/ref-count 模型，除非后续另开任务接入新 SDK API。
* 不把 `ready` 扩展为可重复重置的生命周期 signal；如后续需要，可另行设计状态观察 API。

## Technical Notes

* 相关文件：
  * `src/types/market.ts`
  * `src/managers/market-manager.ts`
  * `src/internal/subscription-multiplexer.ts`
  * `tests/unit/market-manager-venue-dispatch.test.ts`
  * `tests/integration/client-lifecycle.test.ts`
  * `docs/api.md`
* 需要读取 `.trellis/spec/backend/index.md`、`.trellis/spec/backend/type-safety.md`，实现前还应按变更范围读取 code organization / adapter contract / quality guidelines。
