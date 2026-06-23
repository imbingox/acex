# L1 lease ready 使用订阅 ACK 判定

## Goal

调整 L1 Book subscription lease 的 ready 语义：`lease.ready` 表示 logical subscription 已被底层 stream/venue 接受并可接收数据，而不是必须等首条 L1 book data 到达。

这个改动要避免冷门期权等低频 symbol 在 WS 已连接、订阅已接受但首条 quote 长时间不来的情况下被误判为 `MARKET_STREAM_TIMEOUT` 并自动释放 lease。

## Confirmed Facts

- L1 Book public contract 已支持 nullable quote side：bid-only、ask-only、two-sided 和四字段全 `null` 的 empty book 都是有效 market state。
- 当前 `SubscriptionMultiplexer` 的底层 WebSocket 以 `open` 作为 transport ready，但每个 subscription handle 的 `ready` 仍等待第一条 routed `data` payload。
- Deribit `public/subscribe` 会返回 JSON-RPC ACK；`quote.<instrument>` data 才会被映射为 L1 payload。
- 当前文档把 `lease.ready` 写成等待首份 top-of-book 状态，这需要随实现一起更新。

## Requirements

- `MarketSubscriptionLease.ready` 对 L1 Book 应以订阅建立成功为准：venue 对订阅 ACK 成功，或 adapter 能提供等价的订阅接受信号后 resolve。
- 如果一条真实 data 在 ACK 前到达，且 adapter/multiplexer 能确定它属于当前 pending subscription，则该 data 可视为等价订阅接受信号，并 resolve `lease.ready`。
- 对支持订阅 ACK 的 venue，首条 L1 book data 超时不得导致 lease ready reject 或自动释放 lease。
- 没有首条真实 L1 data 时，不得凭空合成 empty book；`getL1Book()` 可以保持 `undefined`，直到 venue 发来第一份 book state。
- 如果订阅建立失败、订阅 ACK 返回错误、或订阅 ACK 在合理时间内未到，`lease.ready` 仍应 reject，并释放该 logical lease。
- 已收到真实 empty quote 时，仍应发布 nullable L1 update，并将 book status 标记为 ready/fresh。
- 多 symbol 批量订阅、共享 socket、重连 replay 和重复 lease 场景不能因为 ACK ready 语义破坏现有复用逻辑。
- 用户文档必须说明 `lease.ready` 与 `getL1Book()` / book `status.ready` 的区别。

## Acceptance Criteria

- [ ] Deribit L1 订阅在 `public/subscribe` ACK 后 `lease.ready` resolve，即使该 instrument 尚未收到 `quote` data。
- [ ] Deribit `quote.<instrument>` data 如果在 matching ACK 前到达，会更新 book 并 resolve 对应 `lease.ready`。
- [ ] Deribit ACK 成功但首条 quote 长时间不来时，lease 不会被 `MARKET_STREAM_TIMEOUT` 自动释放。
- [ ] Deribit quote data 到达后仍按 nullable side 规则更新 `getL1Book()` 并发布 `l1_book.updated`。
- [ ] Deribit subscribe ACK error 或 ACK timeout 会 reject `lease.ready`，错误仍能被调用方识别为 stream/subscription 建立失败。
- [ ] Binance L1/funding 等现有基于 SUBSCRIBE ACK 的 stream 语义不回退；相关测试覆盖批量 ACK 或至少不破坏现有集成测试。
- [ ] `docs/quickstart.md`、`docs/managers.md`、`docs/types.md` 中关于 L1 lease ready 的语义已同步。
- [ ] 相关单元/集成测试通过，至少覆盖 manager dispatch、Deribit market stream 和 multiplexer ACK ready 行为。

## Out Of Scope

- 不新增 L2/orderbook depth。
- 不把无首帧 data 的订阅合成为 empty L1 book。
- 不改变下单前对 bid/ask 字段的方向性检查要求。
- 不改变 account/order private WS ready 语义。
