# brainstorm: market data ingress

## Goal

为当前 Acex SDK 增加第一条真实市场数据接入链路：通过 WebSocket 持续接收 L1 Book，通过 REST 获取交易元信息，为后续真实交易所 adapter/runtime 打基础，并替换当前仅依赖内存 mock 快照的数据来源。

## What I already know

* 用户希望现在开始开发 market 数据接入。
* 用户已经指定两条输入链路：L1 Book 走 WebSocket，交易元信息走 REST。
* 用户确认首个真实接入交易所选择 `binance`。
* 用户确认本轮 market MVP 只做 `L1 Book + instrument metadata`，不同时补 funding rate。
* 用户要求 instrument metadata 覆盖每个交易对的丰富参数，至少包括 `price/amount` 精度、`contract size`、`base/quote/settle` 等信息。
* 用户要求像 CCXT 一样把 Binance 支持的市场尽量统一起来，内部做市场类型转换，对外调用方只通过统一 `symbol` 使用，不再显式感知具体市场类型。
* 用户确认首版 Binance market families 覆盖 `Spot + USDⓈ-M + COIN-M`，暂不纳入 options。
* 用户确认 rich instrument metadata 需要通过 public API 对外暴露。
* 用户确认首版一并纳入最小 catalog 和 robustness：
  - catalog: `getMarket(symbol)` + `listMarkets()`
  - robustness: unknown symbol、不可交易 market、WebSocket 断线三类语义
* 用户确认 WebSocket 心跳与新鲜度检测应作为通用扩展能力设计，而不只是 Binance 特判：
  - 协议层处理交易所 `ping/pong`
  - 应用层提供通用 freshness/watchdog 语义
* 当前仓库里的 SDK 已有 `AcexClient`、`MarketManager`、事件总线和测试骨架。
* 当前 `MarketManager` 订阅行为仍是本地生成占位快照，不是真实交易所数据接入。
* 当前文档把 SDK 定位在数据面 MVP，尚未落地真实 adapter/runtime。
* 当前 examples 和测试默认都以 `binance` + `BTC/USDT:USDT` 作为样例输入。

## Assumptions (temporary)

* 首轮实现只接 `binance` 一个交易所，并覆盖其 `Spot + USDⓈ-M + COIN-M` 三类市场。
* 首轮重点是 market 数据面，不包含下单/撤单等交易命令。
* 交易元信息至少会被用于统一 symbol 解析、订阅参数构造、market 分类与精度元数据缓存。

## Open Questions

* 暂无阻塞性开放问题。

## Requirements (evolving)

* 首个真实 market 数据接入目标交易所为 `binance`。
* 首版 Binance market families 覆盖 `Spot + USDⓈ-M + COIN-M`。
* 本轮 market MVP 只实现 `L1 Book + instrument metadata`。
* SDK 需要用真实 WebSocket 维护 Binance L1 Book 数据，而不是本地 mock。
* SDK 需要通过 REST 拉取 Binance instrument metadata。
* instrument metadata 需要覆盖每个交易对的丰富参数，至少包括 `price/amount` 精度、`contract size`、`base/quote/settle` 等字段。
* rich instrument metadata 需要通过 public API 对外暴露。
* 公开 market API 需要新增一个显式 metadata barrier，用于加载 / 刷新 market catalog，然后才允许同步读取缓存。
* public market catalog 至少支持 `getMarket(symbol)` 和 `listMarkets()`。
* 对外调用方应尽量只通过统一 `symbol` 使用 market API，不需要显式感知 Binance 的具体市场类型。
* 内部需要建立类似 CCXT 的 market 统一映射层，把不同 Binance 市场转换到统一 symbol / metadata 视图。
* WebSocket runtime 需要抽出通用扩展能力，至少包含：
  - 协议层 `ping/pong` 处理
  - 应用层消息新鲜度 watchdog
  - 为后续多交易所复用预留统一接口
* robustness 需要至少覆盖：
  - unknown symbol 的错误语义
  - 不可交易 / 已下线 market 的处理语义
  - WebSocket 断线后的 L1 缓存与 `MarketDataStatus` 语义
* 设计应能承接后续更多市场数据和更多交易所接入。

## Acceptance Criteria (evolving)

* [ ] `market.subscribeL1Book()` 在真实数据链路下完成 ready barrier。
* [ ] SDK 能通过 REST 获取并缓存 Binance `Spot + USDⓈ-M + COIN-M` 的交易元信息。
* [ ] SDK 提供公开的 market metadata / catalog 读取能力。
* [ ] unknown symbol、不可交易 market、WebSocket 断线有明确且可测试的行为。
* [ ] 测试覆盖最小可验证链路与关键错误场景。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 下单、撤单、改单等交易命令接口
* 多交易所并行接入
* Funding rate 等其他 market 数据类型
* Binance options
* 复杂筛选 DSL 或分页 catalog 查询
* 完整恢复状态机、自动重连策略细化、reconcile、持久化与分布式状态同步

## Technical Notes

* 当前相关实现位于 `src/client/runtime.ts`、`src/managers/market-manager.ts`、`src/types/market.ts`。
* 当前 `docs/sdk-public-api.md` 只定义了 MVP 数据面公开接口，真实 adapter 合同和恢复状态机尚未展开。
* `MarketManager` 当前直接创建 mock `L1Book` / `FundingRateSnapshot`，ready barrier 依赖本地占位数据而不是真实链路。
* backend 规范要求继续沿用现有结构，把 public contract 放在 `src/types/*`，runtime 放在 `src/client/*`，领域实现放在 `src/managers/*`，通用原语放在 `src/internal/*`。
* 当前仓库已有 type-safety 和 quality 规范，但还没有单独的 error-handling / logging spec 文件。
* 依赖策略已确定为原生 `fetch` + `WebSocket`，首轮不引入 `ccxt` / `ccxt pro`。

## Research Notes

### Constraints from our repo/project

* 不能把真实接入逻辑直接塞进 `src/client.ts` / `src/types.ts` 这种聚合入口。
* `subscribeL1Book()` 必须继续保持 ready barrier 语义，resolve 时 `getL1Book()` 已可用。
* public API 已经稳定在统一 symbol 语义上，内部接入层可以演进，但不应把交易所原生接口细节泄露到对外 contract。
* 当前 tests 偏向内存态与语义验证，首轮真实接入大概率需要新增可 mock 的 transport / adapter 边界，而不是直接连公网做测试。
* Binance 官方文档显示：
  - Spot 用 `/api/v3/exchangeInfo` 和 `wss://stream.binance.com` 的 websocket streams。
  - USDⓈ-M 用 `/fapi/v1/exchangeInfo` 和 `wss://fstream.binance.com`。
  - COIN-M 用 `/dapi/v1/exchangeInfo` 和 `wss://dstream.binance.com`。
  - 三类市场都存在 `bookTicker` 语义，但 REST/WS 地址彼此独立。
* Binance 文档同时提示：`pricePrecision` / `quantityPrecision` 不能替代 `tickSize` / `stepSize`，精度边界应优先读取 filters。
* Binance Spot、USDⓈ-M、COIN-M 各自有独立的 REST/WS endpoints，因此统一 symbol 方案需要先做 market family 识别，再路由到对应 transport。
* 参考 CCXT 的统一市场设计，symbol 可以作为稳定索引，但不要在调用路径里靠字符串切片硬编码业务逻辑；应优先依赖已标准化的 market metadata。
* Binance 提供的是协议层 websocket keepalive 约束；SDK 仍需补应用层 freshness/watchdog，才能把 “连接还活着但数据已经不新鲜” 和 “连接已断开” 区分开。

### Feasible approaches here

**Approach A: native adapter layer** (Recommended)

* How it works:
  为单个交易所新增内部 market adapter，REST 和 WebSocket 都走原生 `fetch` / `WebSocket`，由 runtime/manager 调用 adapter 更新 record。
* Pros:
  最贴近后续正式架构；依赖少；能明确 transport、解析、状态更新边界。
* Cons:
  首次接入代码量较大；需要自己处理协议细节和测试替身。

**Approach B: thin transport wrapper**

* How it works:
  先只新增最薄的一层 `market data source`，把 REST/WS 封装成可替换 transport，暂不完整抽象成交易所 adapter。
* Pros:
  更快落地；对当前 skeleton 改动较小。
* Cons:
  后续扩多交易所时可能要再重构一次。

**Approach C: CCXT/CCXT Pro bootstrap**

* How it works:
  先借助第三方库打通 REST/WS，再把产出映射进当前 public contract。
* Pros:
  早期接入速度快；少处理部分底层协议。
* Cons:
  引入额外依赖与适配限制；当前仓库还没有相关基础设施；未来替换成本更高。

## Technical Approach

推荐按以下形状落地：

* public contract
  - 在 `src/types/market.ts` 新增标准化 market metadata 类型，例如 `MarketDefinition`。
  - 为 `MarketManager` 新增：
    - `loadMarkets(): Promise<void>`
    - `getMarket(symbol: string): MarketDefinition | undefined`
    - `listMarkets(): MarketDefinition[]`
  - `subscribeL1Book()` 在内部自动确保 market catalog 已加载，因此调用方不必先手工 `loadMarkets()` 才能订阅。
* standardized market metadata
  - 统一字段至少包括：
    - `exchange`
    - `symbol`
    - `id` / 交易所原生 symbol
    - `type` / `spot | swap | future`
    - `base`
    - `quote`
    - `settle?`
    - `active`
    - `contract`
    - `linear?`
    - `inverse?`
    - `contractSize?`
    - `pricePrecision`
    - `amountPrecision`
    - `priceStep`
    - `amountStep`
    - `minAmount?`
    - `minNotional?`
    - `expiry?`
    - `raw`
* runtime / adapter shape
  - 在 `src/client/*` 或新增内部模块中引入 Binance market catalog loader 和 bookTicker stream 连接管理。
  - 抽出可复用 websocket runtime helper，统一处理连接生命周期、协议层心跳和应用层 freshness watchdog。
  - 先按 market family 分三套 REST/WS transport，再统一映射为一套标准化 metadata 和 L1 update。
  - `MarketManager` 负责公开 API 与 record 更新，不直接持有底层协议细节。
* robustness semantics
  - unknown symbol: `subscribeL1Book()` 直接失败；`getMarket()` 返回 `undefined`；`listMarkets()` 不包含该 symbol。
  - inactive market: catalog 中可见但 `active = false`；订阅时直接失败。
  - websocket disconnected: 保留最后 L1 快照；`MarketDataStatus.freshness = "stale"`；`reason = "ws_disconnected"`；后续重连策略先保留最小实现空间，不在本轮展开完整状态机。
  - freshness watchdog: 当连接仍在但长时间没有消息时，先把数据标记为 `stale`，避免把协议层存活误判为数据仍可用。
* testing strategy
  - 单元测试优先 mock REST/WS transport，不依赖公网。
  - 保留现有 public 语义测试，并新增真实 adapter 层的标准化映射测试、ready barrier 测试和断线状态测试。

## Decision (ADR-lite)

**Context**: 本轮需要把 SDK 从内存态 mock market 过渡到首条真实交易所 market 数据接入，同时保住现有统一 symbol 和同步 getter 的主体验。

**Decision**:

* 采用 `binance` 作为首个真实接入交易所。
* 覆盖 `Spot + USDⓈ-M + COIN-M`，不含 options。
* 依赖策略使用原生 `fetch` + `WebSocket`。
* 对外继续以统一 `symbol` 为中心，不暴露 market family 作为主调用参数。
* 新增显式 `loadMarkets()` barrier，并提供 `getMarket(symbol)` / `listMarkets()` catalog API。
* `subscribeL1Book()` 自动依赖 market catalog，并在真实 websocket 首个可用快照后再 resolve。
* WebSocket 层按“协议心跳 + 应用 freshness watchdog”两层实现，并尽量抽成可复用 internal primitive。

**Consequences**:

* 首轮实现复杂度高于单市场、单 endpoint 接入，但能直接建立多 market family 的统一映射层。
* public API 会从“只读 L1/funding 快照”扩展为“market catalog + L1”，后续 account/order/funding 都可以复用同一份 metadata。
* 测试必须引入 transport mock 和更明确的错误语义，否则很难稳定验证多 market family 逻辑。
