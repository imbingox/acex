# Deribit 期权行情 MVP

## Goal

为 `acex` 增加 Deribit 公开期权行情能力，让调用方可以发现 BTC 等标的的 Deribit option chain，按 `underlying + expiry + strike` 配出 call/put pair，并订阅这些期权合约的一档盘口，用于和 Binance 永续合约做合成期货价差机会监控。

初版只覆盖公开行情和合约发现，不支持 Deribit 账户、下单、撤单、私有流、持仓或风控。

## Confirmed Context

- 当前 SDK 已有状态型 `MarketManager` 和 venue adapter 架构，Binance L1 Book 已可作为永续对冲腿数据源。
- 当前公共 `MarketType` 只有 `spot | swap | future`，需要新增 `option` 才能把 Deribit 期权作为一等市场类型表达。
- 现有 `L1Book` 可以表达策略初筛所需的买一卖一价格和数量。
- 仅靠 `getL1Book({ venue, symbol })` 不够，因为策略需要先发现和筛选期权链，再从同一 `expiry + strike` 中配出 call/put 组合。
- Deribit `public/get_instruments` 可提供期权元数据，包括 `instrument_name`、`expiration_timestamp`、`strike`、`option_type`、`base_currency`、`quote_currency`、`settlement_currency`、`counter_currency`、`contract_size`、`tick_size`、`min_trade_amount`、`is_active`，以及部分 payload 中的 `state`。
- Deribit `public/ticker` 可提供一档买卖价量；Greeks / IV / mark price 属于期权报价上下文，不属于本 MVP 必需盘口数据。
- Deribit public WS 存在纯一档盘口 channel（例如 `quote.<instrument>` 或 `book.<instrument>.none.1.100ms`）和混合型 `ticker.<instrument>.100ms` channel；`ticker` 同时包含 best bid/ask、mark/index/underlying price、IV、Greeks、open interest 等字段。
- 本 MVP 应优先使用纯 L1 channel 作为 `L1Book` 数据源，避免为大规模 option pair 扫描订阅不需要的 Greeks / IV payload。
- Deribit 官方市场数据最佳实践说明：如果需要最早的 order book change 信号，应使用 raw book feed；`raw` 需要认证连接，消息量高，需要本地维护 order book。`quote.<instrument>` 无 interval 参数，提供 top-of-book 更新，实测比 `book/ticker.100ms` 更高频，适合作为未认证 public WS 下的低负载 L1 默认数据源。
- 当前 `client.market.loadMarkets()` 会按已注册 market adapter 加载目录；新增 Deribit 后，应该由 `createClient` 的 runtime venue 选择决定哪些 adapter 被注册，而不是为 Deribit 增加专属 `enabled` 开关。`venues` 不传时应沿用“SDK 当前 runtime 支持的 venue 全部生效”的语义，需要 Binance-only 等收窄场景时由调用方显式传 `venues`。

## Requirements

### Market Model

- `Venue` 必须包含 `deribit`。
- `MarketType` 必须包含 `option`。
- 必须新增可被 TypeScript 收窄的期权市场公共类型，例如 `OptionMarketDefinition`，或把 `MarketDefinition` 改造成等价的 discriminated union；`type: "option"` 时必须能表达以下标准化元数据：
  - `underlying`
  - `expiry`，epoch milliseconds
  - `strike`，canonical decimal string
  - `strikeCurrency`
  - `optionType: "call" | "put"`
  - `premiumCurrency`
  - `settle`
  - `contractSize`
  - `priceStep`
  - `amountStep`
  - `minAmount`
  - `active`
- `OptionMarketDefinition` 必须是标准 public `MarketDefinition` 合同的一部分，`MarketAdapter.loadMarkets()` 可以返回它；不得只作为 Deribit adapter 内部 subtype 存在。
- Deribit option 的标准字段映射必须明确：
  - `base` 来自 Deribit `base_currency`，并等于 `underlying`
  - `quote` 来自 Deribit `counter_currency`，并等于 `strikeCurrency`
  - `underlying` 来自 Deribit `base_currency`
  - `premiumCurrency` 来自 Deribit `quote_currency`
  - `strikeCurrency` 来自 Deribit `counter_currency`
  - `settle` 来自 Deribit `settlement_currency`
  - 现有 `MarketDefinition.quote` 对 Deribit option 必须等于 `strikeCurrency`
  - `contract` 必须为 `true`
  - `contractSize` 来自 Deribit `contract_size`
  - `inverse` / `linear` 必须由 Deribit `instrument_type` 映射；MVP 已知 `reversed` option 必须映射为 `inverse: true`
  - `active` 必须由 Deribit `is_active` 和可选 `state` 共同判断；`is_active` 必须为 `true`，且当 raw payload 提供 `state` 时只有 `state: "open"` 才视为 active
  - `priceStep` 来自 Deribit `tick_size`
  - `amountStep` 和 `minAmount` 在 MVP 中都来自 Deribit `min_trade_amount`
  - `pricePrecision` / `amountPrecision` 必须分别由 `priceStep` / `amountStep` 反推
  - Deribit `tick_size_steps` 暂不提升为稳定公共字段，必须保留在 `raw`
- Deribit 原生 `instrument_name` 必须保留在 `id`，原始 payload 必须保留在 `raw`。
- SDK 的期权 `symbol` 必须稳定、唯一，并能让调用方不依赖 Deribit 原生字符串完成后续订阅。
- Deribit option `symbol` 固定为 `<underlying>/<strikeCurrency>:<settle>-<YYYYMMDD>-<strike>-<C|P>`，例如 `BTC/USD:BTC-20260621-57000-C`。
- `symbol` 中的 `YYYYMMDD` 必须由 `expiry` 的 UTC 日期生成；`strike` 必须使用 canonical decimal string，不得保留 Deribit payload 中可能出现的科学计数法或无意义尾零。
- 同一 Deribit instrument 的 `symbol` 必须在 catalog reload 前后保持一致。
- Deribit option `symbol` 继续遵循 SDK 既有 `base/quote:settle` 直觉：斜杠后的 `quote` 是 strike / counter currency，不是权利金报价币种；权利金报价币种只能从 `premiumCurrency` 读取。
- Deribit option L1 的 `bidPrice` / `askPrice` 是 Deribit premium quote 单位，不是 Binance USDT 价格；文档必须明确调用方做合成期货价差时需要自行按 `premiumCurrency` / `strikeCurrency` / `settle` 进行单位折算。

### Option Discovery

- `MarketManager` 必须提供确定的 public API：`listOptionMarkets(filter)`。
- `listOptionMarkets(filter)` 返回期权合约的扁平列表，返回项必须可被 TS 识别为 option market 类型。
- `listOptionMarkets(filter)` 和 `listOptionPairs(filter)` 必须遵循现有 `listMarkets()` 的 catalog 读语义：只读取当前已加载 catalog，不隐式触发 network load 或 venue lazy load；Deribit 未被当前 client 选择或尚未加载 catalog 时，按当前 catalog 返回空结果。
- `listOptionMarkets(filter)` 至少支持按以下条件过滤：
  - `venue`
  - `underlying`
  - `optionType`
  - `expiry`
  - `strike`
  - `strikeCurrency`
  - `premiumCurrency`
  - `settle`
  - `active`
- `active` 不传时不得隐式过滤 inactive markets，保持和现有 `listMarkets()` 一样的 catalog 视图语义；调用方要扫描可交易合约时应显式传 `active: true`。
- `strike` filter 必须接受 decimal input 并归一化为 canonical decimal string 后做精确匹配。
- `expiry` filter 必须是 epoch milliseconds exact match。
- `underlying`、`strikeCurrency`、`premiumCurrency`、`settle` filter 必须按 uppercase currency code 精确匹配；输入应 trim 并 uppercase。
- `listOptionMarkets(filter)` 必须稳定排序：`venue`、`underlying`、`strikeCurrency`、`premiumCurrency`、`settle`、`expiry` 升序、`strike` 数值升序、`optionType`。
- `MarketManager` 必须提供确定的 public API：`listOptionPairs(filter)`。
- `listOptionPairs(filter)` 必须按 `venue + underlying + strikeCurrency + premiumCurrency + settle + expiry + strike` 形成一组 pair。
- `listOptionPairs(filter)` 至少支持 `listOptionMarkets(filter)` 的同一组过滤字段，但不接受 `optionType`，因为 pair 本身包含 call 和 put。
- `listOptionPairs(filter)` 的过滤必须先应用到单腿 option markets，再分组；因此 `active: true` 要求 pair 的 call 和 put 两腿都 active。
- `listOptionPairs` 返回的每个 pair 必须包含：
  - `venue`
  - `underlying`
  - `strikeCurrency`
  - `premiumCurrency`
  - `settle`
  - `expiry`
  - `strike`
  - `call: OptionMarketDefinition`
  - `put: OptionMarketDefinition`
- 如果某个 `underlying + strikeCurrency + premiumCurrency + settle + expiry + strike` 缺少 call 或 put，不能作为完整 pair 返回。
- `listOptionPairs(filter)` 必须稳定排序：`venue`、`underlying`、`strikeCurrency`、`premiumCurrency`、`settle`、`expiry` 升序、`strike` 数值升序。
- `listOptionMarkets(filter)` 中 `optionType` 的排序必须稳定为 call 后 put，或在类型中明确写死同等确定顺序；MVP 采用 call 后 put。

### Deribit Catalog Scope

- Deribit catalog 加载范围必须明确，不得隐式假设已经加载所有 Deribit option underlyings。
- `CreateClientOptions.venues?: Venue[]` 必须作为通用 runtime venue 选择入口，用于收窄当前 client 注册的 runtime adapters。
- `venues` 省略时必须注册 SDK 当前所有 runtime-supported venues；本 MVP 完成后默认包含 Deribit，因此默认 `client.market.loadMarkets()` 会加载 Deribit catalog。
- 调用方需要 Binance-only 等更窄 runtime 时，可以显式传 `createClient({ venues: ["binance"] })`；未被选择的 venue adapter 不参与 `client.market.loadMarkets()`、catalog lazy load、订阅或私有 runtime。
- `venues` 显式传空数组或规范化后为空数组时必须视为配置错误。
- `venues` 中包含 SDK 只声明类型但没有 runtime adapter 的 venue 时必须视为配置错误，不能静默降级为 type-only。
- Deribit 被当前 client 选择后，MVP 默认加载 Deribit BTC options。
- `CreateClientOptions.market.venues.deribit.underlyings?: string[]` 必须允许调用方显式指定加载的 Deribit option underlying 列表，例如 `["BTC", "ETH"]`。
- `underlyings` 输入必须 trim、uppercase、去重后按 option underlying code 处理并文档化；adapter 内部把每个 underlying 映射到 Deribit `public/get_instruments` 的 `currency` 参数。
- MVP 不要求自动通过 Deribit `public/get_currencies` 发现全部 option underlyings。
- Deribit 被当前 client 选择且 `underlyings` 省略时使用默认值 `["BTC"]`。
- Deribit 被当前 client 选择且 `underlyings` 显式传空数组或规范化后为空数组时必须视为配置错误，不能静默加载空 catalog。
- Deribit 被当前 client 选择且 `underlyings` 中包含 Deribit 不支持或请求失败的 underlying 时，catalog load 必须失败并按现有 market catalog load error 合同暴露错误，不得静默跳过。

### L1 Book

- Deribit option market 必须支持现有 `acquireL1BookSubscription({ venue: "deribit", symbol })`。
- Deribit option market 必须支持现有 `getL1Book({ venue: "deribit", symbol })`。
- Deribit option L1 必须输出 canonical decimal string：
  - `bidPrice`
  - `bidSize`
  - `askPrice`
  - `askSize`
- Deribit option L1 的 `exchangeTs` / `receivedAt` / freshness 状态必须遵循现有 `L1Book` 合同。
- 对套利初筛而言，L1 的语义必须是可成交的一档 quote，不要求暴露 Greeks、IV 或 mark price。
- 初版 Deribit option L1 默认数据源应使用 `quote.<instrument>`。
- Deribit `quote.<instrument>` payload 只有在 bid/ask price 和 size 都是非空、有限、正数时，adapter 才能发布 `L1Book`。
- 无完整双边可成交 quote 时不得发布部分 `L1Book`；对应 lease 的 `ready` 可以按现有首包超时规则失败，这是预期行为并必须在文档中说明。
- `MarketDataStatus["reason"]` / `MarketDataStreamStatus["reason"]` 必须支持 `no_quote`，用于表达当前无完整双边可成交 quote。
- 无完整双边 quote 的 payload 不得走会 resolve `lease.ready` 的普通 L1 update path；它必须走 status / freshness transition path。
- 首次订阅在 ready 前收到无完整双边 quote 时，不得 resolve `lease.ready`，也不得发布半成品 `L1Book`。
- 已经发布过完整 quote 后，如果后续收到无完整双边 quote，SDK 必须保留 last complete `L1Book` 的价格字段，但把该 book 的 status 更新为 `freshness: "stale"`、`reason: "no_quote"`；下游必须能通过 `book.status.freshness === "fresh"` 判断该盘口当前是否可用于套利扫描。
- `no_quote` 是 status-only transition：必须发布 `market.status_changed`；不得发布携带半成品价格的 `l1_book.updated`。
- `no_quote` transition 后，`getL1Book()` 返回的 last complete snapshot 必须满足：
  - `bidPrice` / `bidSize` / `askPrice` / `askSize` 保持最后一次完整 quote 的值
  - 顶层 `receivedAt` / `updatedAt` / `exchangeTs` / `version` 保持最后一次完整 quote 的值
  - `status.freshness` 更新为 `"stale"`
  - `status.reason` 更新为 `"no_quote"`
  - `status.lastReceivedAt` 更新为收到 no-quote payload 的本地接收时间
- 对应 `market.status_changed.status.lastReceivedAt` 也必须更新为收到 no-quote payload 的本地接收时间，以便不读取 book snapshot 的下游也能识别最近一次市场数据输入。
- 后续重新收到完整双边 quote 时，SDK 必须发布新的 `L1Book` 并把 status 恢复为 `freshness: "fresh"`、`reason: undefined`。
- MVP 不要求使用 `public/ticker` 或 REST 做 initial L1 priming；如果技术设计决定补 priming，也必须遵守同一完整双边 quote 校验，且不得把 ticker-only 字段作为稳定公共接口暴露。
- 文档必须说明 `quote.<instrument>` 是 public WS 下的 top-of-book 默认源；若后续策略要求每个 order book change 的最早信号和序列连续性，应追加支持 authenticated `book.<instrument>.raw`，但这不属于当前 MVP。

### Cross-Venue Usage

- 调用方必须能使用现有 Binance 永续 L1 和新增 Deribit option pair + L1 组合出如下扫描形态：
  - 1 条 Binance 永续腿，例如 `BTC/USDT:USDT`
  - N 组 Deribit option pair，每组包含同一 `expiry + strike` 的 call/put
- SDK 不负责计算套利 edge、资金费率、期权 carry、手续费或可交易规模，只提供发现和行情数据。

### Capabilities And Documentation

- Deribit 未被当前 client 选择时不得影响该 client 的 Binance market / L1 行为；`getVenueCapabilities("deribit")` 应按当前 runtime 无 Deribit adapter 的既有 fallback 语义返回 `runtimeStatus: "type_only"`、market/account/order unsupported。
- Deribit 被当前 client 选择时，`getVenueCapabilities("deribit")` 必须体现初版只支持 public market data，不支持 account/order。
- Deribit capabilities 必须明确：
  - `runtimeStatus: "available"`
  - `readOnly: true`
  - `market.catalog: "supported"`
  - `market.serverTime: "unsupported"`
  - `market.l1Book: "supported"`
  - `market.marketTypes: ["option"]`
  - `market.fundingRate: "unsupported"`
  - `market.fundingRateHistory: "unsupported"`
  - `market.publicTrades: "unsupported"`
  - `market.publicRawTrades: "unsupported"`
  - `account.*` 全部 `"unsupported"`，`credentialsRequired: false`
  - `order.supported: false`，其余 order 能力均为 unsupported / false，`order.reason: "read_only"`
- 现有 capability 聚合逻辑必须支持 market-only venue 声明 `readOnly: true` 和 `order.reason: "read_only"`；不得要求 Deribit 为了表达 read-only public market venue 而实现 private adapter。
- README / API 文档必须说明：
  - Deribit MVP 只支持公开期权行情
  - 期权合约发现通过 option catalog / option pair API 完成
  - 具体期权盘口通过统一 `L1Book` API 获取
  - Greeks / IV / mark price 暂不作为稳定公共接口
  - Deribit option L1 价格单位是 `premiumCurrency`，strike 单位是 `strikeCurrency`

### Compatibility

- 新增 `MarketType = "option"` 后，所有按 `MarketType` 穷尽匹配或 `Record<MarketType, ...>` 建模的代码必须保持 type-check 通过。
- 新增 option market 字段后必须更新 backend adapter contract / API 文档中对 `MarketDefinition` 的说明，保证 Deribit adapter 返回的 option 字段属于标准 public contract。
- 本 MVP 不要求实现 Deribit fee 查询；如现有 fee 默认值结构因新增 `option` 受到影响，必须显式处理 option 默认值或把相关结构改为 partial，不能留下类型缺口。
- 现有 Binance market / L1 API 行为不得发生破坏性变化；但 `venues` 省略时 `loadMarkets()` 会按“所有 runtime-supported venues”语义额外加载 Deribit，这是本 MVP 接受的新增 runtime venue 行为。需要维持 Binance-only 网络访问的调用方应使用 `createClient({ venues: ["binance"] })`。

## Acceptance Criteria

- [ ] `CreateClientOptions.venues` 省略时，client 注册 SDK 当前所有 runtime-supported venues；本 MVP 完成后 `client.market.loadMarkets()` 会加载 Binance 和 Deribit market catalogs。
- [ ] `createClient({ venues: ["binance"] })` 时，`client.market.loadMarkets()` 不访问 Deribit，现有 Binance market / L1 行为不变。
- [ ] Deribit 未被当前 client 选择或尚未加载 catalog 时，`listOptionMarkets({ venue: "deribit" })` / `listOptionPairs({ venue: "deribit" })` 不访问 Deribit 网络，并按当前 catalog 返回空结果。
- [ ] 默认 client 或 `createClient({ venues: ["binance", "deribit"] })` 选择 Deribit 后，`client.getVenueCapabilities("deribit")` 返回 Deribit runtime 可用、`readOnly: true`、market catalog 和 L1 Book 为 supported、`marketTypes: ["option"]`、account/order 为 unsupported。
- [ ] Deribit 被当前 client 选择且未传 `market.venues.deribit.underlyings` 时会加载 Deribit BTC options；配置 `market.venues.deribit.underlyings` 后只加载指定 Deribit option underlyings。
- [ ] `client.market.listOptionMarkets({ venue: "deribit", underlying: "BTC", active: true })` 返回 BTC active option markets。
- [ ] Deribit option market fixture 中的 `strike: 5.7e4` 会被归一化为 canonical decimal string `"57000"`，公开字段和 `symbol` 中都不得出现科学计数法。
- [ ] Deribit option market 的 `id` 保留原生 instrument name，例如 `BTC-21JUN26-57000-C`；`base` 等于 `underlying`，`quote` 等于 `strikeCurrency`，`premiumCurrency` 单独暴露；`symbol` 使用固定 SDK 格式，例如 `BTC/USD:BTC-20260621-57000-C`。
- [ ] Deribit option catalog normalization 覆盖 `pricePrecision` / `amountPrecision` 由 step 反推、`amountStep` / `minAmount` 来自 `min_trade_amount`、`tick_size_steps` 保留在 `raw`，以及 `active` 由 `is_active` 和可选 `state` 共同归一。
- [ ] `client.market.listOptionPairs({ venue: "deribit", underlying: "BTC", active: true })` 返回按 `strikeCurrency + premiumCurrency + settle + expiry + strike` 配好的 call/put pairs，且不会返回缺腿 pair。
- [ ] `listOptionMarkets()` 和 `listOptionPairs()` 返回稳定排序；同一 fixture 多次 load / reload 后顺序和 symbol 不漂移；`strike` filter 可接受科学计数法输入并归一化匹配。
- [ ] `CreateClientOptions.venues` 的省略 = 全部 runtime-supported venues、显式收窄到 `["binance"]`、空数组错误、type-only venue 错误，以及 Deribit 被选择后 `underlyings` 的省略、trim/uppercase/dedupe、空数组错误、无效 underlying 错误都有测试覆盖。
- [ ] 调用方可以对任意返回的 pair 同时订阅 `pair.call.symbol` 和 `pair.put.symbol` 的 Deribit L1 Book。
- [ ] Deribit option L1 Book 输出 canonical decimal string，且不会输出科学计数法。
- [ ] Deribit option L1 订阅使用 `quote.<instrument>` channel；null、缺边、非有限数或非正 size 的 quote payload 不产生 `L1Book`。
- [ ] 无完整双边 quote 时，Deribit L1 lease 按现有首包超时行为失败，不发布半成品盘口。
- [ ] 已有完整 quote 后收到空盘口时，`getL1Book()` 保留 last complete quote，但其 status 变为 `freshness: "stale"`、`reason: "no_quote"`，`book.status.lastReceivedAt` 和 `market.status_changed.status.lastReceivedAt` 更新为 no-quote payload 的本地接收时间，顶层 `receivedAt` / `updatedAt` / `exchangeTs` / `version` 保持最后完整 quote 的值；该 transition 发布 `market.status_changed`，不发布半成品 `l1_book.updated`；恢复完整 quote 后 status 回到 `fresh`。
- [ ] Deribit 被当前 client 选择时 capability 验收覆盖 `market.serverTime: "unsupported"`、`order.reason: "read_only"`，且不需要 Deribit private adapter。
- [ ] `bun run type-check` 通过。
- [ ] `bun run test` 通过，且默认测试不访问真实 Deribit 网络。
- [ ] 现有 Binance L1 Book API 不发生破坏性变化。
- [ ] 新增单元/集成测试覆盖 Deribit catalog normalization、option pair grouping、quote channel parsing，并使用 fixtures 或 fake transport。
- [ ] live smoke 如需访问真实 Deribit，只能作为独立脚本，不进入默认 `bun run test`。
- [ ] 文档包含一个“Binance 永续 vs Deribit call/put pairs”扫描数据准备示例。

## Out Of Scope

- Deribit 账户注册、余额、持仓、风险、私有 WebSocket。
- Deribit 下单、撤单、订单订阅。
- 套利收益、资金费率、carry、手续费、保证金、资金占用或风控模型计算。
- L2 order book / depth。
- Greeks / IV / mark price 的稳定公共 snapshot API。
- 自动选择最佳 expiry / strike。
- 自动执行套利交易。

## Notes

- 当前 PRD 只定义 MVP 范围。用户 review 通过后，进入技术设计时需要补 `design.md` 和 `implement.md`，再开始实现。
