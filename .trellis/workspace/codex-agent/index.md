# Workspace Index - codex-agent

> Journal tracking for AI development sessions.

---

## Current Status

<!-- @@@auto:current-status -->
- **Active File**: `journal-1.md`
- **Total Sessions**: 43
- **Last Active**: 2026-06-13
<!-- @@@/auto:current-status -->

---

## Active Documents

<!-- @@@auto:active-documents -->
| File | Lines | Status |
|------|-------|--------|
| `journal-1.md` | ~1542 | Active |
<!-- @@@/auto:active-documents -->

---

## Session History

<!-- @@@auto:session-history -->
| # | Date | Title | Commits | Branch |
|---|------|-------|---------|--------|
| 43 | 2026-06-13 | PR #83 review 修复：cid entropy Set 内存泄漏 | `b620eb8` | `codex/p2-batch1-engineering-cleanup` |
| 42 | 2026-06-13 | P2 批① 工程清理 + PAPI riskLevelChange 风控事件 | `86fa011`, `c2f07a3`, `7e95c58`, `8f060c2`, `716185b`, `549546d` | `codex/p2-batch1-engineering-cleanup` |
| 41 | 2026-06-12 | P1-C2/C3/C4 多交易所内置扩展基建 | `bd014d5`, `ae76e37`, `6dc95fa`, `93cbd6d`, `3e43e73` | `codex/p1-c2-c3-c4-venue-extensibility` |
| 40 | 2026-06-12 | P1-B6/B7/B8 流层打磨（hot-path 分配 / stale 语义 / 重连 jitter） | `74507eb`, `a9cd0ef` | `codex/p1-b6-b7-b8-stream-layer-polish` |
| 39 | 2026-06-12 | P1-B5 成交明细字段：独立 order.trade 逐笔事件 | `d3bcffa` | `codex/p1-b5-fee-realized-pnl` |
| 38 | 2026-06-12 | P1-B4 签名时钟自动同步回路 | `8cf0a72`, `7beac9d` | `codex/p1-b4-clock-resync` |
| 37 | 2026-06-11 | 完成限流分层 P1-B3 | `3edefc1`, `65e099f`, `3768874`, `838556f`, `ae4e3ee` | `main` |
| 36 | 2026-06-11 | 批次③ 事件流质量：conflation/背压 + status 发布去重（P1-B1 + P1-B2） | `35b8163` | `feat/event-conflation-status-dedup` |
| 35 | 2026-06-11 | 订单生命周期收尾:幽灵 open 订单驱逐与 pending claim TTL (P1-A1+P1-A2) | `bdaf9ea`, `e951436` | `feat/open-order-eviction-claim-ttl` |
| 34 | 2026-06-11 | 错误体系统一:venue 错误码归一与 orderState 语义 (P1-A3+P1-C5) | `3f6dcb8`, `d25d120` | `feat/venue-error-reason-order-state` |
| 33 | 2026-06-10 | Binance private listenKey recovery | `3581ced`, `f95e07b` | `fix/private-listenkey-recovery` |
| 32 | 2026-06-10 | Refactor OrderManager structure | `ec1cd11` | `fix/order-command-watermark` |
| 31 | 2026-06-10 | P0-2 order command watermark | `474035c` | `fix/order-command-watermark` |
| 30 | 2026-06-10 | cancelAllOrders PAPI 响应形状修复 + live 复核 | `e98dba3`, `7551af4` | `fix/cancel-all-response-shape` |
| 29 | 2026-06-10 | 全库 review 发现固化为 docs/improvement-todo.md | `1783541` | `main` |
| 28 | 2026-06-10 | OrderManager 内部 localOrderId 身份模型 + pending claim (PR #56) | `acbdfd8`, `d4cbafb` | `feat/order-manager-local-order-id` |
| 27 | 2026-06-09 | OrderManager 存储分层与 closed 订单裁剪 | `89f846e` | `feat/order-manager-store-tiering` |
| 26 | 2026-06-09 | Binance private REST reconciliation | `3b01486`, `95ae3f2` | `feat/binance-open-orders-reconcile` |
| 25 | 2026-06-08 | Binance TradFi public market data | `153e2d8` | `feat/binance-tradfi-public-market` |
| 24 | 2026-06-05 | AcexError 根因透传 | `d874b29` | `feat/acex-error-details` |
| 23 | 2026-06-03 | venue server time 接口 (client.market.fetchServerTime) | `dac87aa`, `89b38ac` | `feat/venue-server-time` |
| 22 | 2026-06-02 | market catalog reload: reloadMarkets 主动刷新目录 | `65fbdb2`, `f65bab7` | `feat/market-catalog-reload` |
| 21 | 2026-06-02 | Step 4: capability 化 private 分派，清 venue 硬编码（PR #42） | `355d8d6`, `a3aaf0e`, `f091a73`, `e61f10f`, `afa456e`, `5b9e059` | `feat/venue-capability-dispatch` |
| 20 | 2026-06-02 | 06-01 收尾：PR3 listenKey scope review 修复 + 任务归档 | `4259cc6` | `feat/venue-rate-limiter` |
| 19 | 2026-06-02 | 共享 venue 基础设施 PR3（REST 限流器 / RateLimiter seam） | `0d99377`, `f48c061` | `feat/venue-rate-limiter` |
| 18 | 2026-06-02 | 共享 venue 基础设施 PR2（统一 TimeProvider / 可注入签名时钟） | `c3c9460`, `2382b9e` | `feat/venue-time-provider` |
| 17 | 2026-06-02 | 共享 venue 基础设施 PR1（REST 骨架 + 错误脱敏） | `d9bacb6`, `df49fa1`, `362b6b5` | `feat/shared-venue-infrastructure` |
| 16 | 2026-06-01 | 公共数值契约：对外 BigNumber 改 canonical decimal string | `adc9274`, `eb9a1a2`, `6219bee` | `feat/public-decimal-string-contract` |
| 15 | 2026-06-01 | 行情多 venue 分派与 WS 连接复用 | `d99ac9a`, `343ac4b`, `19f60bc`, `a8328f6` | `feat/market-venue-ws-multiplex` |
| 14 | 2026-05-27 | 完成 Juplend lend-read 替换与收尾 | `e47874a`, `99fb840`, `f997750` | `dev` |
| 13 | 2026-05-11 | Refresh Binance Account Risk | `50e4e09`, `9ee60cf`, `628cefe` | `docs/account-realtime-refresh-spec` |
| 12 | 2026-05-06 | Venue capability queries and npm docs packaging | `ea9a4a7`, `46d1291` | `feat/new_account` |
| 11 | 2026-05-05 | Juplend lending account view | `c411b69` | `feat/new_account` |
| 10 | 2026-05-03 | Post-only orders and input normalization | `9dad2f0` | `feat/market` |
| 9 | 2026-05-01 | 文档补充 market 订阅行为 | `2516e8a` | `feat/market` |
| 8 | 2026-04-30 | Restructure test suites and CI | `0357dcc`, `97146d1` | `feat/test` |
| 7 | 2026-04-30 | 补充 funding 聚合 changeset | `680e315` | `main` |
| 6 | 2026-04-29 | Funding 聚合接口与 Binance mark price 修复 | `4ed0e0b` | `feat/funding` |
| 5 | 2026-04-25 | 补充 release changeset 规范并创建 PR | `5dcc3c1`, `d9e15d6` | `feat/funding` |
| 4 | 2026-04-25 | 添加资金费率 market 数据 | `62bea64`, `dbf5462` | `feat/funding` |
| 3 | 2026-04-21 | Stabilize npm release workflow after release PR rollout | `678d760`, `fdcb892`, `0a4c717` | `fix/release-version-packages-formatting` |
| 2 | 2026-04-21 | Ship Binance private trading MVP and release automation | `baeab15`, `f85a9b0`, `82ef26a` | `feat/order_account` |
| 1 | 2026-04-20 | Binance PAPI account read-only | `6429738` | `feat/order_account` |
<!-- @@@/auto:session-history -->

---

## Notes

- Sessions are appended to journal files
- New journal file created when current exceeds 2000 lines
- Use `add_session.py` to record sessions