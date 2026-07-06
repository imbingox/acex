# Reconnect periodic market streams on stale business frames - Implementation Plan

## Checklist

- [ ] 在 `ManagedWebSocketSession` 增加 internal `restart(reason?)`，复用 raw socket close -> existing reconnect 路径。
- [ ] 在 `SubscriptionMultiplexer` 增加 `StreamLivenessPolicy` 类型与 protocol hook。
- [ ] 给 `SubState` 增加 policy、business liveness timer 状态和清理逻辑。
- [ ] 在 subscription accepted / no-ACK subscribe sent / data payload 到达时调度或刷新 liveness timer。
- [ ] liveness timer 触发时标记该 subscription stale，并按 policy 调 `session.restart()`。
- [ ] 在 disconnect、subscription close、connection close、control ack error 等路径清理 per-subscription timer。
- [ ] Binance `fundingRate` descriptor 返回 `periodic + reconnect` policy；其他 channel 保持默认。
- [ ] 增补 `tests/unit/subscription-multiplexer.test.ts`：
  - periodic subscription 在 WS open 但无业务 payload 时 stale + reconnect + replay；
  - default/event-driven subscription idle 时不主动 reconnect；
  - reconnect 后新 payload 让 stale snapshot 回 fresh。
- [ ] 视需要补充 Binance stream protocol policy 测试。
- [ ] 更新 `.trellis/spec/sdk/adapters.md` 中 market multiplexer stale 契约，记录 periodic reconnect 例外。

## Validation

- `bun test tests/unit/subscription-multiplexer.test.ts`
- `bun test tests/unit/binance-stream-protocol.test.ts`
- `bun run type-check`
- `bun run lint`
- `bun run test`

## Rollback Points

- 若 `restart()` 影响 ManagedWebSocket 既有 close semantics，回退该方法并改为在 `ManagedWebSocket` 增加明确的 `restartOnStale` option。
- 若 per-subscription timer 引发 Deribit/L1 行为漂移，确认 default policy 为空且只在 Binance funding descriptor 启用。
