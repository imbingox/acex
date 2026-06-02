# PRD 对抗性复核：market catalog reload

总体判断：PRD 目标正确，且对现有 `MarketManager` 多 venue 目录缓存、三不变量、`catalogPromises` stale resolved promise 的事实判断大多成立；但草案还不能直接实现。必须先补齐 summary 与 coalescing 的返回值设计、已加载 venue 上 reload 与新 subscribe 并发时的语义、失败 catch 的边界，以及测试 fixture 对“先成功后失败”场景的不足。

## 确认无误

- `MarketManagerImpl` 当前确实是多 venue catalog 状态：`definitions` 是全局 `Map`，`loadedCatalogVenues` 是 `Set<Venue>`，`catalogPromises` 是 `Map<Venue, Promise<void>>`（`src/managers/market-manager.ts:114`、`:116`、`:117`）；`loadMarkets()` 对所有已注册 market adapter 并发调用 `loadMarketCatalog(venue)`（`src/managers/market-manager.ts:163`、`:165`）；runtime 当前只注册 Binance market adapter，但 manager 构造函数接收 `Map<Venue, MarketAdapter>`，测试也能注入多 venue（`src/client/runtime.ts:107`、`:109`、`src/managers/market-manager.ts:124`、`:126`、`tests/unit/market-manager-venue-dispatch.test.ts:159`、`:164`）。
- 三个现有不变量在 manager 层成立：`fetchAndStoreMarketCatalog()` 先 `await adapter.loadMarkets()`，之后按 venue 删除旧 definitions、同步 set 新 markets、再标记 loaded，中间没有 `await`（`src/managers/market-manager.ts:455`、`:459`、`:461`、`:468`、`:471`）；如果 adapter 抛错，会直接进入 catch 并不会执行 delete/set，所以 manager 的旧 `definitions` 保留（`src/managers/market-manager.ts:459`、`:461`、`:472`、`:484`）；该 helper 只触碰 `definitions` 和 `loadedCatalogVenues`，而订阅状态和 stream handle 在 `records` / `MarketRecord` 上（`src/managers/market-manager.ts:49`、`:62`、`:63`、`:114`、`:471`）。
- PRD 对 `catalogPromises` 并发坑的判断属实：`loadMarketCatalog()` 成功路径只 await，不删除 map；只有 catch 路径 delete，所以首次成功会留下已 resolved promise（`src/managers/market-manager.ts:441`、`:444`、`:447`、`:450`）。同时，首次成功后后续懒加载会先被 `loadedCatalogVenues.has(venue)` 短路，不再读取该 map（`src/managers/market-manager.ts:437`、`:441`）。
- 把 `catalogPromises` 改成“真正 in-flight 登记表”对现有 `loadMarkets()` 懒加载短路本身是零回归：`loadMarketCatalog()` 的 loaded guard 在读取 map 之前（`src/managers/market-manager.ts:437`、`:441`），所以首次成功后即便 `.finally()` 删除 map，后续 `loadMarkets()` 仍会直接 return。
- lifecycle 判断无误：`loadMarkets()` 没有调用 `assertStarted()`（`src/managers/market-manager.ts:163`、`:166`）；`subscribeL1Book()` 和 `subscribeFundingRate()` 才先 assert client 已启动（`src/managers/market-manager.ts:169`、`:170`、`:201`、`:202`）；当前 docs 也只声明 start 前调用 `subscribe*()` 会失败（`docs/api.md:246`、`:248`）。
- failure 可观测性判断基本成立：当前 catalog 拉取失败时，manager 会先 `publishRuntimeError("adapter", originalError, { venue })`，再 throw 新的 `AcexError("MARKET_CATALOG_LOAD_FAILED")`（`src/managers/market-manager.ts:472`、`:477`、`:484`）。adapter contract 也要求 adapter 只 throw `Error`，业务错误码归 manager / runtime（`.trellis/spec/backend/adapter-contract.md:157`、`:162`）。
- public API 落点判断成立：`MarketManager` public 接口定义在 `src/types/market.ts`（`src/types/market.ts:158`、`:176`），`AcexClient.market` 暴露该接口（`src/types/client.ts:128`、`:129`），runtime 把 `MarketManagerImpl` 实例赋给 `client.market`（`src/client/runtime.ts:127`、`:143`）。`src/types/index.ts` 直接导出 `market.ts`，根入口又导出 `types/index.ts`（`src/types/index.ts:1`、`:3`、`src/index.ts:2`、`:5`）。
- `MarketCatalogReloadSummary` 放在 `src/types/market.ts` 与 `MarketManager` 接口同文件，符合 code organization：market 领域 public type 应落在 `src/types/market.ts`（`.trellis/spec/backend/code-organization.md:86`、`:89`），新增根导出不应通过中间 re-export 文件（`.trellis/spec/backend/code-organization.md:81`、`:84`）。
- changeset bump=`minor` 判断正确：仓库当前是 `0.4.0-beta.5`（`package.json:3`）；release spec 明确任何影响 npm 用户的 PR 必须带 changeset（`.trellis/spec/backend/release-publishing.md:119`、`:121`），新增 public API / 新能力 / 新可观察字段对应 `minor`（`.trellis/spec/backend/release-publishing.md:127`、`:131`），0.x beta 阶段的破坏性 public contract 变更也仍用 `minor`（`.trellis/spec/backend/release-publishing.md:134`、`:137`）。
- 测试基建部分属实：`tests/unit/market-manager-venue-dispatch.test.ts` 已有 `CountingMarketAdapter.loadMarketsCalls` 计数器（`tests/unit/market-manager-venue-dispatch.test.ts:101`、`:104`、`:113`、`:115`）；`FakeOkxMarketAdapter` 也已有 `loadMarketsCalls` 与 `failLoadMarkets`（`tests/support/exchanges/okx.ts:85`、`:88`、`:100`、`:116`）。但它不足以直接覆盖所有 reload 验收，见下方第 5 点。

## 需修正 / 补充

### 1. coalescing 草案返回 `void`，无法支撑 reload summary

问题：PRD 要求 `reloadMarkets()` 返回 `MarketCatalogReloadSummary[]`，其中成功场景必须有 `added` / `removed` / `total`（`.trellis/tasks/06-02-market-catalog-reload/prd.md:29`、`:31`）。但草案里的 `fetchCatalogCoalesced()`、`loadMarketCatalog()`、`reloadMarketCatalog()` 全都是 `Promise<void>`，`catalogPromises` 也仍按 `Promise<void>` 存（`.trellis/tasks/06-02-market-catalog-reload/prd.md:73`、`:75`、`:82`、`:85`、`:91`）；最后一句“`fetchAndStoreMarketCatalog` 内 diff，供 summary 使用”没有落到可返回的类型上（`.trellis/tasks/06-02-market-catalog-reload/prd.md:97`）。

代码证据：当前 `catalogPromises` 类型就是 `Map<Venue, Promise<void>>`（`src/managers/market-manager.ts:117`），`fetchAndStoreMarketCatalog()` 返回 `Promise<void>`（`src/managers/market-manager.ts:455`），`loadMarketCatalog()` 只是 await 这个 void promise（`src/managers/market-manager.ts:441`、`:448`）。

建议改法：PRD 应把内部 coalescing 类型改成可复用的成功结果，例如 `CatalogFetchResult = { venue: Venue; added: string[]; removed: string[]; total: number }`，并把 `catalogPromises` 改成 `Map<Venue, Promise<CatalogFetchResult>>`。`loadMarketCatalog()` 丢弃返回值；`reloadMarkets()` 用返回值组装 `ok:true` summary；失败时只在 per-venue catch 里补 `ok:false` summary。

### 2. 已加载 venue 上 reload 与新 subscribe 并发时，subscribe 不会等待 reload

问题：PRD 写“并发 load/reload 同一 venue 只打一次底层 `adapter.loadMarkets()`”，但草案保留 `loadedCatalogVenues.has(venue)` 在读取 `catalogPromises` 之前。对已经加载过的 venue，reload 正在拉新目录时，新 `subscribeL1Book()` 会通过 `resolveMarketDefinition()` 调 `loadMarketCatalog()`，然后被 loaded guard 直接放行，继续读旧 `definitions`。如果这个 subscribe 目标正是 reload 会新增的 symbol，就会在 reload 未完成期间误报 `MARKET_NOT_FOUND`。这可能可以接受，但 PRD 没有说清“调用方必须 await reload 后再订阅新增 symbol”。

代码证据：`resolveMarketDefinition()` 先 await `loadMarketCatalog()`，再从 `definitions` 读 symbol，缺失就抛 `MARKET_NOT_FOUND`（`src/managers/market-manager.ts:488`、`:493`、`:495`、`:497`）；`loadMarketCatalog()` 在 loaded venue 上直接 return，不会读 in-flight map（`src/managers/market-manager.ts:437`、`:441`）。

建议改法：PRD 必须二选一写死语义。若希望 reload 期间的新 subscribe 不误报新增 symbol，则 `loadMarketCatalog()` 应先检查该 venue 是否有 in-flight reload，并 await 它，再应用 loaded guard。若希望保持订阅路径永不被后台 reload 拖住，则 docs 和 AC 应明确：订阅新增 symbol 前必须 await `reloadMarkets(venue)` 完成；reload 进行中对新 symbol 的 subscribe 可能仍按旧目录返回 `MARKET_NOT_FOUND`。

### 3. “catalog 失败不 reject”需要窄 catch，否则会吞掉编程错误

问题：PRD 要求 catalog/网络失败返回 `ok:false` 且不 reject，只有 unsupported venue throw（`.trellis/tasks/06-02-market-catalog-reload/prd.md:32`、`:54`）。当前 `fetchAndStoreMarketCatalog()` 的 catch 覆盖了 `adapter.loadMarkets()`、delete、set、`loadedCatalogVenues.add()` 整个同步存储段；如果 reload 实现再 broad catch 所有 per-venue 错误并转成 summary，就会把 manager 存储逻辑 bug、错误返回形状导致的异常等都伪装成 catalog 失败。

代码证据：`try` 从 `adapter.loadMarkets()` 开始，一直包到 `loadedCatalogVenues.add()`（`src/managers/market-manager.ts:458`、`:459`、`:461`、`:468`、`:471`），catch 会统一 publish adapter runtime error 并 throw `MARKET_CATALOG_LOAD_FAILED`（`src/managers/market-manager.ts:472`、`:477`、`:484`）。unsupported venue 由 `assertSupportedVenue()` 通过 `createError("VENUE_NOT_SUPPORTED", ...)` 抛出并发布 runtime error（`src/managers/market-manager.ts:531`、`:537`、`:541`、`:1032`、`:1044`）。

建议改法：PRD 明确 reload 的 catch 只把 `AcexError` 且 `code === "MARKET_CATALOG_LOAD_FAILED"` 转成 `ok:false`；`VENUE_NOT_SUPPORTED` 和其他非预期错误必须 rethrow。更彻底的做法是把 `adapter.loadMarkets()` 的 try/catch 缩窄到 adapter 调用本身，成功返回后再做同步 delete/refill，让存储逻辑 bug 不被包装成 adapter failure。

### 4. `Promise.allSettled` 与 unsupported venue throw 的边界要预先校验

问题：PRD 同时要求全量用 `Promise.allSettled`、单 venue catalog 失败不 reject、unsupported venue 才 throw（`.trellis/tasks/06-02-market-catalog-reload/prd.md:30`、`:32`、`:54`）。如果实现把 `reloadMarketCatalog(venue)` 的所有结果直接交给 `allSettled` 再统一转 summary，`reloadMarkets("bybit")` 这类 runtime 未注册 market adapter 的合法 `Venue` 字面量可能会被转成 `ok:false`，而不是按 PRD throw。

代码证据：`Venue` union 包含 `bybit`、`gate`，但 runtime 当前 market adapter map 只注册 Binance（`src/types/shared.ts:1`、`:7`、`src/client/runtime.ts:107`、`:109`）；manager 的支持判断看的是 adapter map，不是 `SUPPORTED_VENUES` union（`src/managers/market-manager.ts:531`、`:532`、`:537`）。

建议改法：PRD 写清 `reloadMarkets(venue)` 的单 venue 分支先同步 `assertSupportedVenue(venue)`，unsupported 直接 throw；只有 adapter 已注册后的 catalog failure 才变成 `ok:false`。全量 `reloadMarkets()` 只遍历 `this.adapters.keys()`，理论上不会产生 unsupported venue。

### 5. 测试 fixture 不能直接覆盖“旧目录成功加载后 reload 失败保留旧目录”

问题：PRD 说 `tests/support/exchanges/okx.ts` 有 `failLoadMarkets`，可直接复用做 reload 断言（`.trellis/tasks/06-02-market-catalog-reload/prd.md:103`）。这只适合“从一开始就失败”的场景；核心验收需要先成功加载旧目录，再让下一次 reload 失败，断言旧目录不变。当前 fake 的 `failLoadMarkets` 是构造期只读配置，实例创建后不能切换。

代码证据：`FakeOkxMarketAdapterOptions.failLoadMarkets` 是 constructor option（`tests/support/exchanges/okx.ts:85`、`:88`），实例字段 `failLoadMarkets` 是 private readonly，并在 constructor 固定（`tests/support/exchanges/okx.ts:105`、`:111`）；`loadMarkets()` 每次只读取这个固定 boolean（`tests/support/exchanges/okx.ts:114`、`:117`）。

建议改法：PRD 应要求补一个 reload 专用 fake，或扩展 `FakeOkxMarketAdapter` 支持 mutable/queue 行为，例如 `loadMarketsResults: Array<MarketDefinition[] | Error>`。新增 symbol 的测试可以复用外部传入的 `markets` 数组，因为 constructor 持有传入数组引用并在 `loadMarkets()` 返回它（`tests/support/exchanges/okx.ts:87`、`:110`、`:120`）；失败保留旧目录则不能只靠现有 `failLoadMarkets`。

### 6. summary diff 必须按 `marketKey` / target venue 计算，并校验 adapter 返回 venue

问题：PRD 说 delete 是 per-venue，summary 返回 `added` / `removed` symbol 列表，但没有要求验证 `adapter.loadMarkets()` 返回的每个 `MarketDefinition.venue` 都等于正在刷新的 venue。当前 manager 删除旧目录时只删除 `market.venue === venue` 的条目，但 set 新目录时会无条件按 `marketKey(market)` 写入所有返回 market；如果 adapter 返回混入其他 venue 的 market，reload 某个 venue 会污染其他 venue 的 definitions，summary diff 也会失真。

代码证据：`marketKey()` 包含 `venue:symbol`（`src/managers/market-manager.ts:71`、`:72`）；`fetchAndStoreMarketCatalog()` 通过目标 venue 取 adapter（`src/managers/market-manager.ts:455`、`:456`），删除旧 definitions 时按 `market.venue === venue` 过滤（`src/managers/market-manager.ts:461`、`:464`），但写入新 markets 时没有检查返回 market 的 venue（`src/managers/market-manager.ts:467`、`:468`）。`MarketAdapter` 自身有 `readonly venue: Venue`，返回值是 `MarketDefinition[]`，每个 definition 也有 `venue` 字段（`src/adapters/types.ts:73`、`:76`、`src/types/market.ts:6`、`:8`）。

建议改法：PRD 增加约束：`fetchAndStoreMarketCatalog(venue)` 在成功写入前应校验 `markets.every((market) => market.venue === venue)`。失败时按 catalog load failure 处理并保留旧目录；成功 summary 的 diff 只比较目标 venue 的 `marketKey` 集合，`added` / `removed` 对外可投影为 symbol。

### 7. public summary 的 `error?: AcexError` 需要明确 type-only 依赖

问题：PRD 要把 `MarketCatalogReloadSummary` 放进 `src/types/market.ts`，且 `error?: AcexError`（`.trellis/tasks/06-02-market-catalog-reload/prd.md:31`）。这会让 `src/types/market.ts` 首次引用 `src/errors.ts`。这可以做，但必须是 `import type`，否则 public types 可能引入不必要运行时依赖；PRD 当前只说类型落点，没有说 import 方式。

代码证据：`src/types/market.ts` 当前只有 type imports，且从 `shared.ts` 引入 `Venue`（`src/types/market.ts:1`、`:2`）；type-safety spec 要求 implementation 优先 `import type`，纯类型依赖默认用 `import type`（`.trellis/spec/backend/type-safety.md:73`、`:76`）；根入口已经单独导出 `AcexError` 与 `AcexErrorCode`，然后导出 types barrel（`src/index.ts:2`、`:5`）。

建议改法：PRD 明确 `src/types/market.ts` 使用 `import type { AcexError } from "../errors.ts";`，并保持 `MarketCatalogReloadSummary.venue` 使用闭合 `Venue` union，不宽化成 `string`（`.trellis/spec/backend/type-safety.md:55`、`:58`）。
