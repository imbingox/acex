# Design

## Problem

当前 L1 subscription 的 ready 路径把“订阅已建立”和“首条 market data 已到达”耦合在一起。冷门 Deribit option 可能在 WS open 且 subscribe ACK 成功后很久才推送 `quote.<instrument>`，现有逻辑会在 first data timeout 时 reject lease 并释放订阅。

## Target Semantics

- Transport ready：底层 WebSocket 已 open。
- Subscription ready：具体 logical subscription 已被 venue 接受。`lease.ready` 对齐这一层。
- Market state ready：首条真实 L1 book data 到达后，`getL1Book()` 返回 book，book `status.ready === true`。

## Architecture

### SubscriptionMultiplexer

将 per-subscription ready 从“必须等第一条 `data` payload”改为“控制帧 ACK 成功，或可确认属于该 pending subscription 的真实 data 已到达”。需要让 protocol 的 ACK 路由携带足够信息，使 multiplexer 能把 ACK 关联到 queued subscribe descriptors；同时 data route 必须已经给出明确的 `subscriptionKey`，才能作为 ACK 前的等价接受信号。

建议最小改法：

- 保留 `routeMessage()` 的 `ack` kind，但扩展 ACK payload，使 protocol 可以表达 success/error 和可选 request id。
- control frame 发送时记录该 frame 覆盖的 subscription keys 和 request metadata。
- 收到 subscribe ACK success 后，resolve 对应 local subscriber ready，并清理 ACK timeout。
- 收到 subscribe ACK error 或 ACK timeout 后，reject 对应 local subscriber ready，并移除对应 subscription。
- data delivery 在命中仍 pending 的 subscription 时也 resolve ready；随后仍负责 freshness、payload callback 和 book 更新。无关 data/status 不得 resolve。

### Venue Protocols

- Deribit JSON-RPC ACK 有 `id`，应让 `encodeSubscribe()` 生成并记录 frame id，`routeMessage()` 根据 `id` 返回 ACK result。
- Binance SUBSCRIBE ACK 有 `id`，同样应按 frame id resolve 对应 queued subscriptions。
- 如果某个 venue/protocol 无法提供 ACK，发送 subscribe 后可使用 adapter 能提供的等价接受信号；但不能用无关消息或 status 伪造 ready。

### MarketManager

`monitorL1BookStreamReady()` 当前可以继续等待 `stream.ready`；语义会由 adapter/multiplexer 改为 ACK ready。`onUpdate()` 保持负责创建和发布 L1 book。

注意 `createL1BookLease()` 中已有 `record.l1BookStreamReady && record.l1Book` 才立即 resolve 新 lease。ACK-ready 后如果 stream 已 ready 但没有 book，新 lease 是否应立即 ready 需要一起调整：当底层 stream 对该 subscription 已 ready，即使无 book，新 lease 也应 resolve。

## Compatibility

这是行为语义变更，需要同步文档。对调用方的主要影响：

- `await lease.ready` 不再保证 `getL1Book()` 已有值。
- 调用方必须继续读取 `getL1Book()` 并检查 bid/ask 字段；无首帧时要处理 `undefined`。
- 低流动性 symbol 的订阅更稳定，不会因无首帧 data 被反复 reject/retry。

## Risks

- ACK 和 control frame 的关联如果处理错误，会误 resolve 错 symbol 或批量订阅。
- 共享 socket 上重复 lease、批量 subscribe、unsubscribe 和 reconnect replay 的状态机需要测试覆盖。
- 文档若不强调 `lease.ready !== book available`，调用方可能在 ready 后立即假设 book 存在。

## Rollback

如果 ACK ready 引入回归，可以回滚 multiplexer ACK 关联改动，恢复 data-first ready 语义；PRD 里记录的文档改动也需同步回滚。
