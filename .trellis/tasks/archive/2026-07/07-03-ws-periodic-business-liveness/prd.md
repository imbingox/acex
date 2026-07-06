# Reconnect periodic market streams on stale business frames

## Goal

当 public market 周期性业务流在 WebSocket 传输仍 open 的情况下停止发送业务 payload 时，SDK 必须自动恢复连接并重放订阅，避免 `FundingRateSnapshot` 等快照长期停留在旧值。

## Requirements

- Binance funding rate 使用 `markPriceUpdate` 业务帧，属于周期性 public market data；官方文档说明单 symbol mark price/funding rate stream 每 3000ms 或 1000ms 推送。
- `SubscriptionMultiplexer` 必须支持按 logical stream / descriptor 配置数据活性策略，不把所有 stream 都当成同一类连接级 idle。
- periodic public market stream 在超过 `staleAfterMs` 没有收到该订阅的 data payload 时必须：
  - 对该订阅触发 `onFreshnessChange("stale", "heartbeat_timeout")`；
  - 主动重启当前底层 WS，使既有 ManagedWebSocket reconnect/backoff/jitter 与 multiplexer resubscribe 逻辑继续生效。
- 默认行为必须保持兼容：未声明 periodic reconnect policy 的 stream 继续只使用现有连接级 watchdog 标记 stale，不新增 per-subscription 误报。
- private account/user-data stream 不套用 public market 的短周期业务帧超时语义；Binance private 现有长周期 listenKey/keepalive/reconcile 恢复机制不在本任务中改成行情级 liveness。
- snapshot/status 必须继续能通过现有 `freshness`、`reason`、`activity`、disconnect/reconnect 事件链区分 transport disconnected、business stale 与恢复后 fresh。

## Acceptance Criteria

- [ ] WebSocket open 但 periodic public market logical subscription 没有业务 payload 时，会在 `staleAfterMs` 后关闭当前 socket，并通过既有 reconnect/backoff/resubscribe 路径新建连接。
- [ ] Binance funding rate / `markPrice` descriptor 使用 periodic stale reconnect policy。
- [ ] 未声明 periodic policy 的 logical subscriptions 不会因为单订阅静默而主动重连。
- [ ] 业务 stale 后的快照先变为 stale；重连后收到新 payload 会恢复 fresh 并更新 snapshot。
- [ ] 现有 private account/user-data stream 行为不因本任务改动而变成短周期业务帧重连。
- [ ] 覆盖单元测试：periodic subscription stale reconnect、event-driven/default subscription no reconnect、stale 后 reconnect 再收到 payload 恢复 fresh。

## Notes

- 当前代码证据：`src/internal/subscription-multiplexer.ts` 的 `messageWatchdog.onStale` 只调用 `markAllStale(connection, "heartbeat_timeout")`，不会关闭底层 socket。
- 当前 `ManagedWebSocket` 已实现 close -> reconnect 的指数退避、jitter 和 resubscribe 支撑；本任务应复用该路径，不手写 adapter 级重连。
