# Workspace Index - codex-agent

> Journal tracking for AI development sessions.

---

## Current Status

<!-- @@@auto:current-status -->
- **Active File**: `journal-1.md`
- **Total Sessions**: 21
- **Last Active**: 2026-06-02
<!-- @@@/auto:current-status -->

---

## Active Documents

<!-- @@@auto:active-documents -->
| File | Lines | Status |
|------|-------|--------|
| `journal-1.md` | ~793 | Active |
<!-- @@@/auto:active-documents -->

---

## Session History

<!-- @@@auto:session-history -->
| # | Date | Title | Commits | Branch |
|---|------|-------|---------|--------|
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