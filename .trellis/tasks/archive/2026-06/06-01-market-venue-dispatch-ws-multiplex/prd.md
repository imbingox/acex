# 行情多 venue 分派与 WS 连接复用层 (P0-2 + P0-1)

## Goal

让 SDK 的行情侧具备**多 venue 能力**并**复用物理连接**：

1. **P0-2** — `MarketManager` 从"持单个 adapter"改为按 `market.venue` 向多 adapter 分派，并定义一份 **logical stream 契约**（per-subscription ready / unsubscribe / 重连重放 / 单 channel stale）。
2. **P0-1** — 给 `ManagedWebSocket` 增加 `send()` 与重连后重放能力，并在其上构建**订阅多路复用层**，让同一 venue/family/base 的多个 symbol 共用一条物理 WS（取代当前"每 symbol 一条"）。

**Why**：用户最初点名的"Binance 多 symbol 各开一条 WS"是连接复用层缺失的症状；同时这是接入第二个 CEX（OKX/Bybit）前必须先打好的地基。全局路线见 [`docs/multi-venue-roadmap.md`](../../../docs/multi-venue-roadmap.md)。

## What I already know（已核实 @ `8dc5118`）

* `MarketManager` 持**单个** adapter：`market-manager.ts:113` `private readonly adapter: MarketAdapter`（构造注入 `:127/:131`），`:503` 用 `venue === this.adapter.venue` 判定。多 venue 必须改为 registry 分派。
* `MarketAdapter` 接口（`adapters/types.ts:73-87`）：`venue` / `marketCapabilities` / `loadMarkets()` / `createL1BookStream(market, callbacks, options): StreamHandle` / `createFundingRateStream(...)`。**WS 构造下沉在 adapter 内部**，logical stream 契约边界就在这两个 `create*Stream` 方法上。
* Binance L1：`subscribeBinanceBookTicker`（`book-ticker.ts:74`）对**每个 symbol** 单独 `createManagedWebSocket`（`:79`），URL 为单 symbol raw 流 `wss://.../<symbol>@bookTicker`（`:60`）。
* Binance funding：`subscribeBinanceMarkPrice`（`mark-price.ts:77`）与 L1 **完全同构**，每 symbol 一条 WS（`:82`），payload 带 `s`(symbol)+`r`(funding)（`:39/:42`）。
* **重要**：bookTicker USDM base 是 `wss://fstream.binance.com/ws`（book-ticker.ts:45），markPrice USDM base 是 `wss://fstream.binance.com/market/ws`（mark-price.ts:46）——**不同 channel 的 base URL 不同**，连接分组键必须含 base URL。
* `ManagedWebSocketSession`（`managed-websocket.ts:34-37`）只有 `ready` / `close()`，**无 `send`**；`createManagedWebSocket` 已支持注入 `now`（`:50`）、`createWebSocket`（`:53`）、`readyWhen`（`:58`，默认 `"message"`）；messageWatchdog 当前是**连接级**。
* MarketManager 当前 ready 语义：`ensureL1BookStream`（`:555-567`）按 `record.l1BookStream.ready` 逐流等待；freshness 为 record 级字段 `l1Freshness/fundingRateFreshness`（`:56/:58`）。复用为"单连接多订阅"后，ready/freshness/watchdog 需重新设计为 per-subscription / per-channel。
* `FakeWebSocket.send()` 当前为空实现（`test-utils.ts:50`）；改造后测试需要它记录并断言 subscribe payload。
* adapter-contract §3.9（`adapter-contract.md:168`）规定所有 WS 必须走 `createManagedWebSocket()`，禁止裸 `new WebSocket`——多路复用层必须落在这条契约内（复用器内部仍调 `createManagedWebSocket`）。

## Decision (ADR-lite)

**Context**：接第二个 CEX 前，行情侧既不能多 venue 分派，也每 symbol 一条 WS。需要先定地基。

**Decisions**：

* **Q1 = A**：本任务**不接真实第二 venue**（OKX/Bybit 属 step 5），多 venue 分派用 registry + 测试用 fake 第二 adapter 验证。
* **Q2 = A**：Binance 复用走 **JSON `SUBSCRIBE`/`UNSUBSCRIBE` 控制帧 + 单连接**（连 `/ws`，运行时动态增删，按 payload `s`+channel 路由），不用 combined-stream URL。
* **Q3 = A**：多路复用层做成 `src/internal/` **可复用原语**（venue-agnostic 通用核 + 注入式 venue 协议策略），不做 adapter 私有。
* **Q4 = A**：L1 + funding **一起**纳入复用改造，用两个 channel 压测策略接口与"按 base URL 分组连接"的设计。

**Consequences**：拿到可复用地基，step 5 接新所只写一个协议策略；代价是现在要把策略接口、连接分组键（含 base URL）、per-subscription ready/stale 一次设计对。

## Requirements

* `MarketManager` 按 `market.venue` 向对应 adapter 分派（注入 `Map<Venue, MarketAdapter>` 或等价 registry），移除所有单 adapter 假设；新增 venue 不需改 MarketManager 代码。
* 定义并文档化 logical stream 契约：
  * `ready` = 该 logical 订阅**首条 data 消息**到达（非 SUBSCRIBE ack）；超 `initialMessageTimeoutMs` 则该流 ready reject 并清理。
  * `close()` = 退订该 logical 流（发 `UNSUBSCRIBE`）；物理连接在**最后一个** logical 流关闭时才断开。
  * 重连后自动**重放**所有活跃订阅。
  * stale 判定细化到 **per-subscription**（单 symbol 静默即便其余在推也能判 stale），不止连接级 watchdog。
* `ManagedWebSocket` 增加 `send(data: string)`，并提供每次 (re)open 都触发的 hook（如 `onOpen`/`onReconnected`），供复用器重放订阅。
* `src/internal/` 新增多路复用原语：通用核（按 `(venue, family, wsBase)` 池化连接、refcount、重连重放、控制帧批量+限速 ≤5/s、per-subscription ready/stale、refcount→0 拆连接、**单连接订阅数达 `maxSubscriptionsPerConnection` 上限时同 connectionKey 开新物理连接（一个 connectionKey → 连接池）**）+ 注入式 venue 策略（`connectionKey` / `url` / `encodeSubscribe` / `encodeUnsubscribe` / `routeMessage→{subKey,payload}|ack|undefined`）。
* Binance L1 与 funding 都改为经多路复用器订阅；连接分组键须正确区分 bookTicker(`/ws`) 与 markPrice usdm(`/market/ws`) 及 coinm base。
* `FakeWebSocket.send()` 记录发送帧，供测试断言 SUBSCRIBE/UNSUBSCRIBE payload 与重连重放。

## Acceptance Criteria

* [ ] 同一 venue/family/base 下订阅 N 个 symbol 只建 **1 条**物理 WS（FakeWebSocket 断言连接数 + SUBSCRIBE payload 含全部 symbol）。
* [ ] L1 与 funding 各自正确路由：bookTicker 与 markPrice 的消息分发到对应 logical 流，不串扰。
* [ ] 退订其中一个 symbol 发出 `UNSUBSCRIBE` 且不影响其余订阅；最后一个退订后物理连接关闭。
* [ ] 物理连接重连后自动重放全部活跃订阅（FakeWebSocket 断言重连后再次收到 SUBSCRIBE）。
* [ ] 单个 logical 流的 ready 独立；单 symbol 静默触发该流 stale，不影响同连接其他流。
* [ ] 控制帧速率不超过 5 msg/s（批量合并 params + 节流）。
* [ ] 单连接订阅数达 `maxSubscriptionsPerConnection` 上限后，同 connectionKey 的后续订阅落到**新物理连接**；退订释放容量；每条物理连接各自独立 ready/replay/refcount/限速。
* [ ] `MarketManager` 能向 2 个不同 venue 的 adapter 分派（fake 第二 adapter 测试）。
* [ ] `bun run lint` / `type-check` / `test` 全绿；新增单测覆盖多路复用、重连重放、per-subscription ready/stale、多 venue 分派。

## Technical Approach

**先 P0-2，后 P0-1**（否则 WS 池的 ready/freshness 语义会返工，路线图 §2.5）。

**Stage 1 — P0-2 多 adapter 分派 + logical stream 契约**

* `MarketManager` 构造改注入 adapter registry，所有 `this.adapter` 用法改为按 `market.venue` 解析；`:503` venue 判定改为 registry 命中判定；`create-client`/`runtime` 侧装配 registry。
* 在 `adapter-contract.md` 落 logical stream 契约（ready/close/重放/per-channel stale 语义）。
* MarketManager record 级 ready/freshness 调整为 per-subscription 语义。
* 测试：fake 第二 adapter 验证分派；现有 Binance 行为不回归。

**Stage 2 — P0-1 send + 重放 + 多路复用器**

* `ManagedWebSocketSession` 加 `send()`；options 加每次 (re)open 触发的 hook。
* 新增 `src/internal/<subscription-multiplexer>.ts`：通用核 + `VenueStreamProtocol` 策略接口（见 Requirements）。
* Binance 策略：`connectionKey` 按 (family, channel→base) 区分 `/ws` 与 `/market/ws`/coinm；`encodeSubscribe` 产出 `{method:"SUBSCRIBE",params:["btcusdt@bookTicker",...],id}`；`routeMessage` 按 payload `s`+事件类型定位 subKey，并识别 `{result:null,id}` ack。
* `book-ticker.ts`/`mark-price.ts` 改为经多路复用器订阅（保留对外 `StreamHandle` 形态）。
* `FakeWebSocket.send()` 记录帧；补多路复用 + 重连重放 + per-sub stale 单测。

**Implementation Plan（同一分支内分阶段提交）**

* 提交 1（Stage 1）：registry 分派 + 契约文档 + per-sub ready/freshness + fake-adapter 分派测试。
* 提交 2（Stage 2）：`send`+重放 hook + 多路复用原语 + Binance 策略 + 迁移 bookTicker/markPrice + `FakeWebSocket.send` + 多路复用/重连/stale 测试。
* 提交 3：更新 adapter-contract / code-organization / architecture 文档 + changeset + 全量质检。

## Definition of Done

* 单测/集成测试覆盖多路复用、重连重放、per-subscription ready/stale、多 venue 分派
* lint / type-check / test 全绿
* 更新 adapter-contract / code-organization / architecture 文档中受影响的契约描述
* changeset（按用户可见行为变更选择 bump 级别）

## Out of Scope

* 接入真实 OKX/Bybit/Gate（step 5）
* 共享 REST 骨架 / 错误归一 / timeout-retry / rate limiter / time provider（step 3）
* capability 化下单判别、per-adapter credential validator、venue runtime options registry、清理 4 处 venue 硬编码（step 4）
* 事件背压（`AsyncEventBus` queue 上限）——除非复用改造直接触发，否则单列

## Technical Notes

* 关键文件：`src/managers/market-manager.ts`、`src/adapters/types.ts`、`src/adapters/binance/{adapter,book-ticker,mark-price}.ts`、`src/internal/managed-websocket.ts`、`src/internal/<subscription-multiplexer>.ts`(新)、`src/client/{create-client,runtime}.ts`、`tests/support/test-utils.ts`。
* 实现分工：代码实现交 codex 子智能体，主 agent 做规划与审核。分支从 `main` 拉。
* 全局路线图：[`docs/multi-venue-roadmap.md`](../../../docs/multi-venue-roadmap.md)。
