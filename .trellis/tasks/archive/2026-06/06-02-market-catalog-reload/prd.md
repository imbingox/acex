# market catalog reload

## Goal

下游（如 polaris daemon）需要一个**主动刷新市场目录**的方法，以便在交易所**新增 symbol** 后无需重启进程即可加载到。当前 `MarketManager` 的目录加载是**懒加载 + 一次性短路**的：首个 venue 的 catalog 在首次 `loadMarkets()` / `subscribe*` 时拉取并缓存，之后被 `loadedCatalogVenues.has(venue)` 短路，永不刷新。本任务新增一个主动重载入口，让目录可被显式刷新，且不影响已有订阅。

## What I already know（来自代码核对）

- `market-manager.ts` 已被 venue-capability-dispatch（PR #42）重构为**多 venue** 结构：
  - `loadedCatalogVenues: Set<Venue>`（`:116`）—— 每 venue 的「已加载」标记。
  - `catalogPromises: Map<Venue, Promise<void>>`（`:117`）—— 每 venue 的在途 promise。
  - `loadMarkets()`（`:163-167`）对所有 adapter 并发 `loadMarketCatalog(venue)`。
  - `loadMarketCatalog(venue)`（`:434`）在 `loadedCatalogVenues.has(venue)` 处短路。
  - `fetchAndStoreMarketCatalog(venue)`（`:455`）：先 `await adapter.loadMarkets()`（`:459`），成功后**按 venue 作用域** delete 旧 definitions（`:461-465`）+ 重填（`:467-469`）+ `loadedCatalogVenues.add`（`:471`）。
- 三个不变量在现有代码里**本来就满足**：
  1. **先 fetch 后原子换**：`:459` await 后，`:461-469` delete+set 全同步、中间无 `await`，读路径永不见空目录。
  2. **失败保留旧目录**：delete/set 都在 await 成功之后；adapter 抛错直接进 catch（`:472`）不动 `definitions`；`loadMarketCatalog` 失败还 `catalogPromises.delete(venue)`（`:450`）以便重试。
  3. **不碰订阅**：`fetchAndStoreMarketCatalog` 只动 `definitions` + `loadedCatalogVenues`，从不碰 `records`/streams/buses。
- `loadMarkets()` 不 `assertStarted`（`:163`），任意生命周期可调；只有 `subscribe*`（`:170`/`:202`）才 assert。
- 公共面：`MarketManager` 接口（`src/types/market.ts:158-176`）经 `client.market.*` 暴露；测试用 `client.market.loadMarkets()`。
- 测试基建已就绪：`tests/unit/market-manager-venue-dispatch.test.ts` 的 fake adapter 自带 `loadMarketsCalls` 计数器，可直接复用做 reload 断言。

## 一个非显然的并发坑（必须处理）

现状 `catalogPromises` **成功后不删除**（只 `:450` 失败时删），会留下一个**已 resolved** 的 promise。reload 若直接 `await catalogPromises.get(venue)` 会命中这个旧 promise → 不重新 fetch。修法：把 `catalogPromises` 改成真正的「在途登记表」（成功也用 `.finally` 删），load / reload 共用一个 coalescing 入口。对现有行为零回归（首次成功后 `loadMarketCatalog` 在 `loadedCatalogVenues` 守卫处就返回，不会再读该 map）。

## Requirements（已定）

- 新增 public 方法 **`reloadMarkets(venue?: Venue): Promise<MarketCatalogReloadSummary[]>`**（接口 + impl + client 暴露），绕过 `loadedCatalogVenues` 短路，对目标 venue 重跑 `fetchAndStoreMarketCatalog`。省略 `venue` = 全量；传 = 单 venue。
- 全量用 **`Promise.allSettled`**：各 venue 独立，单 venue 失败不拖垮其他。
- 返回 **per-venue summary**：`MarketCatalogReloadSummary = { venue, added: string[], removed: string[], total: number, ok: boolean, error?: AcexError }`。
- **失败契约**：catalog/网络拉取失败 → 该 venue summary `ok:false` + 旧目录原样保留 + 仍 `publishRuntimeError`（保留现有可观测性），方法**不** reject。仅「不支持的 venue」（`assertSupportedVenue`）这类编程错误才 throw（对齐 `loadMarkets`）。
- 引入 coalescing 入口 `fetchCatalogCoalesced(venue)`：并发 load/reload 同一 venue 只打一次底层 `adapter.loadMarkets()`。
- 严守三个不变量（先 fetch 后原子换 / 失败保留旧目录 / 不碰订阅）。
- 单元测试覆盖全部验收用例。

## Decisions（ADR-lite）

- **Q1 API 形态 → 方案 A**：独立方法 `reloadMarkets(venue?)`，不选 `loadMarkets({force})`（避免 `subscribe*` 隐式依赖的幂等短路被误触发，零回归）。
- **Q2 失败语义 → `Promise.allSettled`** + per-venue 结果，利于 daemon 轮询；偶发网络失败不把整批刷新搞挂。
- **Q3 返回值 → per-venue summary**（`added`/`removed` 给 symbol 列表，调用方取 `.length` 即可）。
- **Q4 事件 → 不发** `catalog.reloaded`；summary 返回值已满足 polaris 日志需求（二选一，取 summary）。
- **Q5 stale `record.market` → v1 忽略**：reload 后已订阅 symbol 的 `record` 不主动刷新/迁移（与原提案一致）。列入 Out of Scope，必要时再做。
- **Q6 lifecycle → 不 `assertStarted`**：任意生命周期可调，对齐 `loadMarkets`；只走 REST 刷目录，不依赖 WS 启停。在 `docs/api.md` 写明。
- **Q7 reload × subscribe 并发语义 → 保持 `loadedCatalogVenues` 短路在前（subscribe 不等 reload）**：已加载 venue 上 reload 进行中，新 `subscribe*`(经 `resolveMarketDefinition→loadMarketCatalog`) 直接读旧目录；若订阅的正是 reload 将新增的 symbol，reload 完成前可能 `MARKET_NOT_FOUND`。理由：下游 daemon 的用法是「`await reloadMarkets()` → 读 summary → 订阅新增 symbol」，天然先 await reload 再订阅；让 subscribe 永不被后台 reload 拖住、热路径不查 in-flight map，耦合更低。**契约写进 `docs/api.md` + AC**：订阅新增 symbol 前必须 await `reloadMarkets(venue)`。（codex 复核 #2）
- **失败契约细化（codex #3/#4/#6）**：①`reloadVenue` 窄 catch——仅 `AcexError.code === "MARKET_CATALOG_LOAD_FAILED"` 转 `ok:false`，`VENUE_NOT_SUPPORTED`/非预期错误 rethrow；②单 venue 分支先同步 `assertSupportedVenue` throw，全量只遍历 `this.adapters.keys()`；③`fetchAndStoreMarketCatalog` 缩窄 try 到 adapter 调用 + 写入前校验 `markets.every(m => m.venue === venue)`。
- **类型依赖（codex #7）**：`MarketCatalogReloadSummary` 落 `src/types/market.ts`，`error?: AcexError` 用 **`import type { AcexError } from "../errors.ts"`**；`venue` 保持闭合 `Venue` union 不宽化。

## Acceptance Criteria（evolving）

- [ ] 新增 symbol 后调 `reloadMarkets('binance')` → `listMarkets('binance')` 能查到它；fake adapter 的 `loadMarketsCalls` 从 1 → 2；返回 summary `added` 含新 symbol。
- [ ] **先成功加载旧目录、后 reload 失败** → 该 venue summary `ok:false` + `error` 已填；旧目录 `definitions` 原样保留；方法**不** reject；`publishRuntimeError` 被调用。（需可变/队列式 fake，见 Technical Notes）
- [ ] adapter 返回混入其他 venue 的 market → 按 catalog load failure 处理，旧目录保留、summary `ok:false`（codex #6 的 venue 校验）。
- [ ] reload 不影响已有 L1/funding 订阅：订阅流在 reload 期间/之后继续推数据（stream 计数 + 事件断言）。
- [ ] 并发调用 `reloadMarkets('binance')` ×N → `loadMarketsCalls` 只 +1（coalesce 生效）。
- [ ] 多 venue 隔离：`reloadMarkets('okx')` 不影响 `binance` 的 `loadMarketsCalls` 与 definitions；`reloadMarkets()` 全量刷新所有已注册 venue。
- [ ] 全量 reload 时单 venue 失败 → 其余 venue 正常返回 `ok:true`，失败 venue `ok:false`（allSettled 语义）。
- [ ] `reloadMarkets('bybit')`（合法 `Venue` 但 runtime 未注册 adapter）→ throw `VENUE_NOT_SUPPORTED`（编程错误，区别于 catalog 失败的 `ok:false`）。
- [ ] reload 可在 `client.start()` 之前 / `stop()` 之后调用（不 `assertStarted`）。
- [ ] reload 进行中对「将新增 symbol」的并发 subscribe 仍可能 `MARKET_NOT_FOUND`（Q7 契约，文档化行为，按需断言）。

## Definition of Done

- 单元测试新增/更新（覆盖上述 AC）。
- `bun run lint` / `bun run type-check` / `bun run test` 全绿。
- **changeset 必带，bump=`minor`**（新增 public API `reloadMarkets` + public type `MarketCatalogReloadSummary`，按 release-publishing §3.7 矩阵属「新增 public API/新可观察字段」；summary 写用户可见行为，不写内部流水账）。
- `docs/api.md` 更新（新方法签名 + lifecycle 说明：不 assertStarted）。
- README / architecture 文档若涉及行为变化则同步。

## Out of Scope

- 多 venue 下「reload 是全量还是按 venue 增量 diff」之外的高级策略（如增量 patch）。
- 自动定时刷新（定时器逻辑属下游 daemon 职责，本任务只提供主动入口）。
- reload 后对已下架 symbol 的订阅做主动清理 / 迁移（v1 仅保留旧 `record`，不主动 teardown）。

## Technical Approach（草案，已纳入 codex 复核）

内部 coalescing 改为**带返回值**（支撑 summary diff）；`catalogPromises` 类型升级：

```ts
// 内部成功结果，供 summary 复用
interface CatalogFetchResult { venue: Venue; added: string[]; removed: string[]; total: number; }

private readonly catalogPromises = new Map<Venue, Promise<CatalogFetchResult>>();

// map 改为真·在途登记表：成功/失败都删（成功也删对懒加载零回归，loaded guard 在读 map 之前）
private async fetchCatalogCoalesced(venue: Venue): Promise<CatalogFetchResult> {
  let inflight = this.catalogPromises.get(venue);
  if (!inflight) {
    inflight = this.fetchAndStoreMarketCatalog(venue)
      .finally(() => this.catalogPromises.delete(venue));
    this.catalogPromises.set(venue, inflight);
  }
  return await inflight;
}

private async loadMarketCatalog(venue: Venue): Promise<void> {
  this.assertSupportedVenue(venue);
  if (this.loadedCatalogVenues.has(venue)) return;   // 懒加载短路不变；丢弃返回值
  await this.fetchCatalogCoalesced(venue);
}

async reloadMarkets(venue?: Venue): Promise<MarketCatalogReloadSummary[]> {
  if (venue !== undefined) {
    this.assertSupportedVenue(venue);                 // unsupported venue 同步 throw（区别于 catalog 失败）
    return [await this.reloadVenue(venue)];
  }
  const venues = [...this.adapters.keys()];           // 全量只遍历已注册 adapter，不产生 unsupported
  const settled = await Promise.allSettled(venues.map((v) => this.reloadVenue(v)));
  return settled.map((r, i) => r.status === "fulfilled" ? r.value : failSummary(venues[i], r.reason));
}

private async reloadVenue(venue: Venue): Promise<MarketCatalogReloadSummary> {
  try {
    const { added, removed, total } = await this.fetchCatalogCoalesced(venue);
    return { venue, added, removed, total, ok: true };
  } catch (error) {
    // 窄 catch：仅 catalog 失败转 ok:false；VENUE_NOT_SUPPORTED / 非预期错误 rethrow
    if (error instanceof AcexError && error.code === "MARKET_CATALOG_LOAD_FAILED") {
      return { venue, added: [], removed: [], total: this.countVenue(venue), ok: false, error };
    }
    throw error;
  }
}
```

`fetchAndStoreMarketCatalog(venue)` 改动：
- **缩窄 try/catch 到 `adapter.loadMarkets()` 本身**——成功返回后再做同步 delete/refill，避免把 manager 存储逻辑 bug 伪装成 catalog 失败。
- 写入前校验 **`markets.every((m) => m.venue === venue)`**；若混入其他 venue → 按 catalog load failure 处理并保留旧目录（防止污染其他 venue 的 definitions 与 summary diff 失真）。
- delete 前快照该 venue 的 `marketKey` 集合、set 后 diff，得到 `added/removed/total`（对外 `added/removed` 投影为 symbol 列表）。

## Review References

- [`codex-prd-review.md`](codex-prd-review.md) — codex 对抗性复核（file:line 已核验）：确认三不变量/并发坑/lifecycle/落点/changeset 判断成立；7 点修正已全部并入本 PRD（coalescing 返回值、reload×subscribe 语义、窄 catch、unsupported venue 边界、fixture 不足、venue 校验、import type）。

## Technical Notes

- 主要改动文件：`src/managers/market-manager.ts`、`src/types/market.ts`（接口 + 新 type，`import type` AcexError）、`docs/api.md`、`.changeset/*.md`(minor)、测试。
- 关键行号见「What I already know」。
- **测试 fake 需扩展**：现有 `tests/support/exchanges/okx.ts` 的 `failLoadMarkets` 是构造期 `private readonly` 定值（`okx.ts:106`、`:111`、`:114-118`），无法覆盖「先成功、后 reload 失败保留旧目录」。需扩展为可变/队列式行为（如 `loadMarketsResults: Array<MarketDefinition[] | Error>` 逐次出队），或新增 reload 专用 fake。新增 symbol 场景可复用 constructor 持有的 `markets` 数组引用（`okx.ts:110`、`:120`）。
- `loadMarketsCalls` 计数器：`tests/unit/market-manager-venue-dispatch.test.ts:104` 的 `CountingMarketAdapter` 与 `okx.ts:100`，可直接用于 coalesce / reload 次数断言。
