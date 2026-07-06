# Reconnect periodic market streams on stale business frames - Design

## Architecture

改动落在 Layer 0 `SubscriptionMultiplexer` / `ManagedWebSocket` 和 Binance market adapter protocol 配置：

- `ManagedWebSocketSession` 增加 internal `restart(reason?)` 能力：关闭当前 raw socket，但不把 session 标记为 manual closed，让现有 close handler 继续执行 `onUnexpectedClose()` 和 `scheduleReconnect()`。
- `SubscriptionMultiplexer` 增加 stream-level liveness policy。默认不启用 per-subscription timer，保持旧行为。
- `VenueStreamProtocol` 可根据 descriptor 返回 policy，例如 Binance `fundingRate` 返回 periodic + reconnect。

## Policy Contract

建议内部类型：

```ts
type StreamLivenessPolicy =
  | { kind: "event_driven" }
  | { kind: "periodic"; staleAfterMs?: number; onStale: "mark_stale" | "reconnect" }
  | { kind: "low_volume"; staleAfterMs?: number; onStale: "mark_stale" | "reconnect" };
```

语义：

- 未返回 policy：兼容旧连接级 watchdog。
- `event_driven`：不启用业务帧 idle timer。
- `periodic` / `low_volume`：只按 routed `data` payload 刷新 timer；ACK、status、ignore、pong 不算业务 payload。
- `onStale: "reconnect"`：先标记相关订阅 stale，再通过 `session.restart()` 进入既有 reconnect/backoff/resubscribe。

## Data Flow

1. `subscribe(descriptor)` 创建 `SubState` 时保存 descriptor 对应 policy。
2. subscription 被接受时启动 per-subscription liveness timer：
   - ACK 协议：ACK success 后启动；
   - no-ACK 协议：subscribe frame 发送后启动；
   - 首条 data 早于 ACK 时，data 同时 ready 并启动/刷新 timer。
3. routed `data` 到达对应 `SubState` 时，刷新该订阅的 liveness timer，并 fan-out payload。
4. timer 触发时，只标记该 logical subscription 的 local subscribers stale。
5. 若 policy 要求 reconnect，则关闭当前 raw socket；`ManagedWebSocket` close handler 触发 `onDisconnected()`、backoff reconnect 和 multiplexer replay。

## Compatibility

- 不改变 public type union，继续使用现有 `heartbeat_timeout` reason。
- 不改变 `MarketManager` getter/status 形状，依赖现有 freshness/activity/reason。
- 不改变 private adapter 的短路径；private user-data 不经过 `SubscriptionMultiplexer`，且默认 private stale threshold 是 65 分钟。
- `SubscriptionMultiplexer` 默认 policy 为空时，现有 Deribit/L1 行为保持旧语义。

## Risks

- 如果 timer 从 subscribe 创建时就启动，可能在 socket 未 open 或 control frame 未发送前误判 stale；实现必须从 accepted/sent/data 这些生命周期点启动。
- `session.close()` 会永久关闭 ManagedWebSocket，不能用于 stale reconnect；必须使用新的 raw-socket restart 能力。
- 同一连接多个 periodic 订阅同时 stale 时，必须避免重复重启和 timer 泄漏。
