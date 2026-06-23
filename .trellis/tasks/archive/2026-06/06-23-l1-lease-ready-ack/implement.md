# Implement Plan

## Checklist

- [x] 读取相关 SDK spec：architecture、managers、adapters、venues、testing、docs。
- [x] 梳理 `SubscriptionMultiplexer` 当前 control frame、ACK、initial timeout 和 subscriber ready 状态机。
- [x] 扩展 protocol ACK contract，使 ACK 能关联 subscribe control frame。
- [x] 修改 multiplexer：subscribe ACK success resolve subscription ready；ACK error/timeout reject；ACK 前已命中 pending subscription 的真实 data 也 resolve ready。
- [x] 更新 Deribit protocol，使 `public/subscribe` ACK 可被识别并关联到订阅。
- [x] 更新 Binance protocol/测试，确保 SUBSCRIBE ACK 语义不被破坏。
- [x] 调整 MarketManager 对已有 ready stream + no book 的新 lease 处理。
- [x] 增加/修改测试：
  - Deribit ACK 后无 quote，`lease.ready` resolve 且 `getL1Book()` 仍为 `undefined`。
  - Deribit ACK 后迟到 empty quote，发布 nullable L1 update。
  - ACK timeout 或 ACK error reject ready。
  - ACK 前 data 到达会更新 book 并 resolve ready，后续 ACK success 幂等。
  - 共享 socket / 批量订阅不误 resolve。
- [x] 更新 `docs/quickstart.md`、`docs/managers.md`、`docs/types.md`。
- [x] 运行聚焦测试，再运行质量门禁。

## Validation Commands

```bash
bun test tests/unit/managed-websocket.test.ts tests/unit/deribit-stream-protocol.test.ts tests/unit/market-manager-venue-dispatch.test.ts tests/integration/deribit-market.test.ts tests/integration/market.test.ts
bun run lint
bun run type-check
bun run test
```

## Risky Files

- `src/internal/subscription-multiplexer.ts`
- `src/adapters/deribit/stream-protocol.ts`
- `src/adapters/binance/stream-protocol.ts`
- `src/managers/market-manager.ts`
- `tests/integration/deribit-market.test.ts`
- `tests/unit/market-manager-venue-dispatch.test.ts`

## Review Gate

开始实现前确认：PRD/design/implement 已经覆盖 ACK ready 语义、无首帧不合成 empty book、ACK failure 仍 reject 三个核心约束。
