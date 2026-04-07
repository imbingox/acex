# 设计 SDK 对外 API（Brainstorm）

## 目标

为一个 Bun-only 的多交易所交易 SDK 定义 MVP 阶段的对外接口。第一阶段只设计“数据面 API”，也就是客户端创建、账户注册、生命周期管理、市场/账户/订单三类数据订阅、本地快照读取、状态与健康信息，以及事件消费接口；暂不把交易命令接口纳入本轮设计。

## 当前已知信息

* 当前仓库仍处于起步阶段，代码基本为空：
  * `package.json` 已声明包名为 `@imbingox/acex`
  * `index.ts` 还是 Bun 初始化占位内容
  * `README.md` 还是默认模板
* `CLAUDE.md` 明确了工程约束：
  * 默认使用 Bun，而不是 Node.js
  * 测试使用 `bun test`
  * 整体按 Bun 工具链组织
* 用户期望的 SDK 使用方式已经给出，核心形态如下：
  * 通过 `createClient()` 创建一个 client
  * client 下挂 `market`、`account`、`order` 三个 manager
  * 通过 `registerAccount()` 注册账户
  * 通过 `start()` / `stop()` 控制内部 runtime
  * 通过 `subscribe*()` 建立市场数据或私有数据订阅
  * 通过 `get*()` 读取 SDK 内部维护的最新快照
  * 内部通过 WebSocket + REST 维护状态
  * 还需要对外暴露变化事件，例如 L1Book 更新事件
* 用户已明确本轮范围：
  * 只设计“数据面 API”
  * 暂不设计 `placeOrder` / `cancelOrder` / `amendOrder` 等交易命令
  * PRD 和后续设计文档都用中文编写
* 当前 git 历史中存在一版已删除的设计文档，可作为连续性参考：
  * `docs/sdk-public-api.md`
  * `docs/sdk-internal-design.md`
  * `docs/tech-stack.md`

## 临时假设

* 这是一个单 package、Bun-only、TypeScript 风格的 SDK。
* 对外 API 的一等抽象应是“统一 client + manager”，而不是“某个交易所的 REST client / WS client”。
* 单个 `AcexClient` 实例内部维护内存态快照，不涉及跨进程状态同步。
* 市场数据和私有数据都应通过统一的 SDK 语义暴露，而不是直接复用交易所原生事件格式。
* 交易对符号需要采用统一表示，而不是直接暴露每个交易所的原生 symbol 约定。
* 第一版 public API 采用 derivatives-first 设计，优先围绕永续/合约场景定义 funding、position、risk、合约 symbol 等语义。

## 未决问题

* 当前轮核心 public API 边界已基本收敛，下一步进入文档落地。

## 需求（持续演进）

* 暴露 `createClient(options)` 作为统一入口。
* `client` 需要暴露三个 manager：
  * `market`
  * `account`
  * `order`
* 支持在一个 client 内注册多个账户，并以 `accountId` 标识。
* `registerAccount()` 允许运行时动态调用；在 client 已经 `start()` 后注册的新账户，应可继续用于后续私有数据订阅。
* `registerAccount()` 时 credentials 字段可选，不强制要求在注册时就提供完整 `key/secret/password`。
* 第一版显式提供 `updateAccountCredentials(accountId, credentials)`，用于给已注册账户补充或更新私有凭证。
* `removeAccount(accountId)` 在存在活跃私有订阅时，应由 SDK 自动退订并清理对应资源，而不是要求调用方先手工退订。
* 支持按交易所和 symbol 维度订阅市场数据。
* 支持按 `accountId` 维度订阅账户和订单相关数据。
* 第一版数据模型优先覆盖 derivatives 场景，而不是同时为 spot / derivatives 做完整统一抽象。
* 提供 `start()` / `stop()` 生命周期接口。
* SDK 内部维护最新状态缓存，并提供同步读取接口。
* `subscribe*()` 在 Promise resolve 时应作为 ready barrier，表示对应数据的首个可用快照已经 ready，可立即通过 `get*()` 读取。
* 第一版显式提供 `unsubscribe*()`，允许调用方主动释放市场或私有数据订阅，而不是只能依赖 `stop()` 整体释放。
* `unsubscribe*()` 之后默认保留最后一个快照，但对应状态需标记为未订阅 / 非活跃，供调用方识别缓存已不再被持续维护。
* 私有数据所需的 credentials 在 `account.subscribeAccount()` / `order.subscribeOrders()` 时再做校验，而不是在 `registerAccount()` 时一律前置校验。
* 提供 client 级别的状态与健康信息接口。
* `subscribe*()` 的首要职责是声明“SDK 应该在内部维护哪些数据”，而不是直接承担事件消费职责。
* 事件接口应服务于“状态变化感知”，与同步快照读取形成分工，并按需提供给下游。
* 事件消费主接口以 `AsyncIterable` 为主，不以 callback / EventEmitter 作为第一层 public API。
* 事件入口放在各 manager 下的 `events` 子命名空间中，而不是把事件方法直接铺在 manager 顶层。
* 对外 API 需要为多交易所扩展留出空间，但不能把底层 transport 细节直接泄漏到主接口里。

## 验收标准（持续演进）

* [ ] 定义清楚顶层 client API，包括创建、注册账户、启动、停止、状态和健康信息。
* [ ] 定义清楚 `market`、`account`、`order` 三个 manager 的职责边界。
* [ ] 定义清楚第一版 `subscribe*()` 和 `get*()` 的语义。
* [ ] 定义清楚 `registerAccount()` 的运行态行为、`updateAccountCredentials()` 的职责，以及 credentials 的懒校验边界。
* [ ] 定义清楚第一版事件消费模型，并以 `AsyncIterable` 作为主接口。
* [ ] 定义清楚事件接口在 manager 中的挂载位置与命名方式。
* [ ] 明确第一版采用 derivatives-first 设计，并写清未来 spot 扩展边界。
* [ ] 明确 `subscribe*()` 的 ready barrier 语义，并让示例调用链成立。
* [ ] 明确 `unsubscribe*()` 是否与 `subscribe*()` 一一对应，以及释放语义。
* [ ] 明确退订后缓存是否保留，以及如何通过状态判断其已不再活跃。
* [ ] 明确 `removeAccount()` 遇到活跃私有订阅时的行为，以及与资源清理的关系。
* [ ] 明确本轮 MVP 的范围和非目标，避免实现阶段扩散。
* [ ] 设计结果符合 Bun-only 项目约束，不默认引入 Node 特有习惯。
* [ ] 所有设计文档均使用中文表达。

## 完成定义

* 对外 API 文档清晰到足以直接进入实现，不需要再次重解释核心语义。
* 关键偏好决策有记录，后续实现不需要重新拍板。
* 本轮范围与非范围写清楚，第一版实现可以小步推进。
* 后续实现可以拆成多个小阶段，但不需要推翻当前 public API 设计。

## 明确不做

* 本轮不设计交易命令接口：
  * `placeOrder`
  * `cancelOrder`
  * `cancelAllOrders`
  * `amendOrder`
* 不展开交易所 adapter 的具体实现合同。
* 不展开 reconnect / reconcile 的内部状态机。
* 不在本轮穷举完整错误码体系。
* 不在本轮定义完整内部存储结构。
* 不处理发包、构建、CI 细节，除非它们直接影响 public API 表达。

## 技术说明

* 已检查当前仓库文件：
  * `package.json`
  * `index.ts`
  * `README.md`
  * `CLAUDE.md`
* 已检查 git 历史中的已有设计文档，用于保证连续性：
  * `HEAD:docs/sdk-public-api.md`
  * `HEAD:docs/sdk-internal-design.md`
  * `HEAD:docs/tech-stack.md`

## 研究记录

### 类似工具常见做法

* CCXT Pro 更偏“transport-first”风格，直接提供 `watchOrderBook`、`watchBalance`、`watchOrders` 等流式方法，调用方自己处理状态。
* 交易所官方 SDK（例如 Binance、Coinbase 相关工具）通常把 REST 与 WebSocket 分开暴露，WebSocket 常见为 callback 驱动。
* 这些现成方案很少直接提供“跨交易所 + 本地状态缓存 + 统一 manager”这一层抽象。

### 当前项目约束

* 仓库尚未形成历史包袱，可以优先按理想 public API 设计。
* 用户已经明确偏好统一的 client + manager 形态。
* 目标是多交易所 SDK，所以 public API 不能过早绑定某个交易所的 transport 设计。
* 工程约束上是 Bun-only，因此不需要围绕 Node 兼容性去设计主接口。

### 当前可行方案

**方案 A：状态型 client + manager + 本地快照 getter + 事件接口**（推荐）

* 形式：
  * `createClient()` 返回一个统一 client
  * `subscribe*()` 负责建立兴趣和后台同步
  * `get*()` 读取 SDK 内部缓存的最新快照
  * 通过独立事件接口消费变化，但不把 `watch*()` 混入数据订阅入口
  * 事件入口统一放在 `manager.events` 下
  * 事件接口第一层使用 `AsyncIterable<...>`，只是具体命名不必固定为 `watch*()`
* 优点：
  * 与用户给出的期望用法最一致
  * 更适合作为“多交易所应用层 SDK”
  * 能把底层交易所差异留在内部
* 缺点：
  * 需要更严谨地定义 ready、freshness、降级和恢复语义
  * 比 transport-first SDK 更重一些

**方案 B：统一的 `watch*` / `fetch*` 风格接口**

* 形式：
  * 不强调 manager 和本地缓存
  * 主要暴露流式 watch 和即时 fetch
* 优点：
  * 接口更薄，更容易快速实现
* 缺点：
  * 不符合当前目标体验
  * 把状态维护复杂度转嫁给调用方

**方案 C：状态型 client + manager，但事件接口以 callback / EventEmitter 为主**

* 形式：
  * 保留 manager 与缓存
  * 事件接口主打 `.on()` / `.off()` 或 callback subscribe
* 优点：
  * 对很多 JS 用户足够直观
* 缺点：
  * 类型组织和回压语义不如 `AsyncIterable` 清晰
  * 生命周期和取消订阅语义更容易做散

## 决策记录（ADR-lite）

### 决策 1：事件消费主接口采用 `AsyncIterable`，并与数据订阅职责分离

**背景**

当前 SDK 的目标不是简单暴露交易所 transport，而是提供统一的状态型 client。这里至少有两类不同职责：

* 数据订阅：告诉 SDK 需要在后台维护哪些数据
* 事件消费：让下游按需读取状态变化流

如果把两类职责都塞进同一个 `watch*()` 入口，API 心智模型会变混乱。

**决策**

第一版 public API 中：

* `subscribe*()` 负责声明和维持内部数据订阅
* 事件消费接口单独存在，但主形态仍采用 `AsyncIterable`

预期表现形式：

* `client.market.subscribeL1Book(...)`
* `client.market.subscribeFundingRate(...)`
* `client.account.subscribeAccount(...)`
* `client.order.subscribeOrders(...)`
* manager 额外通过 `events` 子命名空间提供事件订阅入口，用于按需消费增量事件

事件消费方式仍以 `for await ... of` 为主，但具体方法命名待定。

**影响**

* 优点：
  * 类型边界更清晰
  * “内部维护状态”和“下游消费事件”两类职责更清晰
  * 生命周期与取消语义更容易做统一
  * 对高频流式数据更适合
  * 后续如果需要再包装 callback / emitter，会更容易
* 代价：
  * 对部分普通 JS 用户来说，不如 `.on()` 直观
  * 第一版还需要继续收敛 `events` 子命名空间里的具体命名

### 决策 2：事件接口统一挂在 `manager.events` 下

**背景**

既然 `subscribe*()` 已经承担了“告诉 SDK 维护哪些数据”的职责，那么事件接口如果继续直接挂在 manager 顶层，就很容易和数据订阅、快照读取混在一起，导致顶层方法膨胀。

**决策**

第一版 public API 中，事件接口统一挂在各 manager 的 `events` 子命名空间下。

预期表现形式：

* `client.market.events.*`
* `client.account.events.*`
* `client.order.events.*`

**影响**

* 优点：
  * manager 顶层职责更清晰：订阅、读取、状态查询
  * 事件能力集中，后续扩展更可控
  * 读代码时，一眼能区分“控制订阅/读取状态”和“消费增量事件”
* 代价：
  * 会多一层命名空间
  * 还需要继续收敛 `events` 下的具体方法名和过滤方式

### 决策 3：第一版 public API 采用 derivatives-first 设计

**背景**

当前目标明显更偏合约交易场景：

* 市场订阅已经出现 `BTC/USDT:USDT`
* 需要 funding rate
* 账户侧天然会涉及 position 和 risk

如果第一版强行同时覆盖 spot 与 derivatives，会把很多字段和语义过早抽象，导致 public API 发散。

**决策**

第一版数据面 API 采用 derivatives-first 设计。

这意味着：

* symbol 语义优先围绕合约统一 symbol
* `market` 默认考虑 funding 等衍生品特有数据
* `account` 默认考虑余额、持仓、风险快照
* `order` 的数据面默认围绕合约账户下的订单状态投影

**影响**

* 优点：
  * 更贴近当前真实目标
  * 第一版接口更聚焦，字段定义更直接
  * 更利于尽快落地可用 MVP
* 代价：
  * spot 未来接入时，需要明确哪些字段降级、缺省或拆层
  * 文档里要提前把“未来 spot 扩展”写成保留空间，而不是默认已完整支持

### 决策 4：`subscribe*()` 在 resolve 时必须完成首个可用快照准备

**背景**

当前 SDK 的主要使用方式已经很明确：

* 先 `await subscribe*()`
* 再立刻 `get*()`

如果 `subscribe*()` 只表示“后台开始尝试维护”，那调用方就还得再引入额外的 ready 判断或等待机制，这会破坏当前想要的简洁心智模型。

**决策**

第一版 public API 中，`subscribe*()` 统一作为 ready barrier。

这意味着：

* `await client.market.subscribeL1Book(...)` 返回后，`client.market.getL1Book(...)` 应该已经可用
* `await client.market.subscribeFundingRate(...)` 返回后，`client.market.getFundingRate(...)` 应该已经可用
* `await client.account.subscribeAccount(...)` 返回后，`client.account.getAccountSnapshot(...)` 应该已经可用
* `await client.order.subscribeOrders(...)` 返回后，对应订单数据快照和状态查询应该已经可用

**影响**

* 优点：
  * 调用语义最直观
  * 不需要额外设计 `waitUntilReady()` 一类接口
  * 与“状态型 SDK”定位更一致
* 代价：
  * `market` 订阅的 resolve 语义会比很多底层行情 SDK 更重
  * 实现上需要确保首个可信快照判定足够清晰

### 决策 5：第一版显式提供 `unsubscribe*()`

**背景**

既然 SDK 是状态型 client，而且 `subscribe*()` 不是一次性拉取而是持续维护，那么调用方就需要有办法主动告诉 SDK 停止维护某些数据。否则只能依赖 `stop()` 整体关闭，难以支持长生命周期进程中的动态订阅切换。

**决策**

第一版 public API 中，`subscribe*()` 都应有明确对应的 `unsubscribe*()`。

预期方向：

* `market.subscribeL1Book()` 对应 `market.unsubscribeL1Book()`
* `market.subscribeFundingRate()` 对应 `market.unsubscribeFundingRate()`
* `account.subscribeAccount()` 对应 `account.unsubscribeAccount()`
* `order.subscribeOrders()` 对应 `order.unsubscribeOrders()`

`stop()` 仍负责兜底释放所有资源，但不替代细粒度退订。

**影响**

* 优点：
  * 适合动态订阅场景
  * 更符合“声明维护哪些数据”的设计逻辑
  * 后续扩展引用计数、共享订阅、资源优化更自然
* 代价：
  * 需要定义退订后的缓存和事件语义
  * 需要定义重复订阅、重复退订的幂等行为

### 决策 6：`registerAccount()` 允许运行时动态生效

**背景**

如果账户只能在 `start()` 之前注册，client 生命周期会变得很死，不适合长生命周期进程按需接入新账户。当前 SDK 既然已经允许动态订阅市场和私有数据，那么账户注册也应该保持同样的运行时灵活性。

**决策**

第一版 public API 中，`registerAccount()` 允许运行时动态调用。

这意味着：

* `await client.start()` 之后，仍可继续 `registerAccount()`
* 新注册的账户应能继续用于 `account.subscribeAccount()` 和 `order.subscribeOrders()`
* `registerAccount()` 的职责是“登记账户身份和关联元信息”，而不是强制立即拉起所有私有同步

**影响**

* 优点：
  * 生命周期更灵活
  * 更适合真实交易系统逐步接入账户
  * 与动态 `subscribe*()` 的设计保持一致
* 代价：
  * 需要明确运行态新增账户的初始化时机
  * 需要定义重复注册和移除后的再注册语义

### 决策 7：credentials 在私有订阅时校验，而不是在注册时强校验

**背景**

并不是所有已注册账户都会立刻订阅私有数据，也不是所有使用场景都需要在 `registerAccount()` 当下就拿到完整 credentials。尤其在当前设计里，`registerAccount()` 更像账户登记，而 `subscribeAccount()` / `subscribeOrders()` 才是实际开始维护私有数据的入口。

**决策**

第一版 public API 中：

* `registerAccount()` 允许 `credentials` 为可选
* `apiKey` / `secret` / `password` 等私有能力所需字段，在 `account.subscribeAccount()` 或 `order.subscribeOrders()` 时再校验

**影响**

* 优点：
  * `registerAccount()` 职责更纯粹
  * 对只关心账户标识、延后注入凭证的场景更友好
  * 更符合“在真正需要私有能力时再做约束检查”的原则
* 代价：
  * 错误会从注册阶段后移到私有订阅阶段
  * 文档必须清楚说明：注册成功不等于私有数据一定可订阅

### 决策 8：通过 `updateAccountCredentials()` 显式补充或更新账户凭证

**背景**

既然 `registerAccount()` 已允许不带完整 credentials，那么 SDK 就需要一个清晰的后续补充入口。把“更新 credentials”继续塞回 `registerAccount()` 会混淆“注册账户”和“更新账户配置”两类职责。

**决策**

第一版 public API 中，显式提供：

* `client.updateAccountCredentials(accountId, credentials)`

用于给已注册账户补充或更新私有凭证。

这意味着：

* `registerAccount()` 负责登记账户
* `updateAccountCredentials()` 负责补充或覆盖 credentials
* `account.subscribeAccount()` / `order.subscribeOrders()` 在真正需要时再校验当前 credentials 是否满足要求

**影响**

* 优点：
  * 账户注册与凭证更新职责清晰
  * 对运行时补充 credentials 的场景更友好
  * 避免重复调用 `registerAccount()` 时出现“到底是报错还是更新”的歧义
* 代价：
  * client 顶层会多一个账户配置方法
  * 需要补充 credentials 更新后的生效时机语义

### 决策 9：`unsubscribe*()` 后保留最后快照，但状态标记为非活跃

**背景**

如果退订后立即清空缓存，语义确实最干净，但会丢掉最后一次可观测状态，不利于排障、日志记录和调试。当前 SDK 既然是状态型 client，更合理的做法是把“是否仍在持续维护”显式体现在状态上，而不是靠是否还能读到缓存来间接表达。

**决策**

第一版 public API 中，`unsubscribe*()` 之后：

* 默认保留最后一个快照
* 但对应状态必须标记为未订阅 / 非活跃

这意味着：

* `get*()` 仍可读到最后一个已知快照
* 调用方不能把该快照再视为持续更新中的权威状态
* 是否仍在被维护，应通过状态接口明确判断

**影响**

* 优点：
  * 更利于调试和观测
  * 不会在退订瞬间丢失最后已知状态
  * 与“状态型 SDK”定位更一致
* 代价：
  * 需要引入“未订阅 / 非活跃”的显式状态
  * 文档必须强调：保留缓存不代表仍然新鲜或可信

### 决策 10：`removeAccount()` 自动退订并清理活跃私有资源

**背景**

既然账户支持运行时动态注册，而且 `removeAccount()` 本质上是“把该账户从 client 中移除”，那么如果还要求调用方先手动把所有私有订阅逐个退掉，接口会显得很碎，也容易出现清理不完整的问题。

**决策**

第一版 public API 中，`removeAccount(accountId)` 在该账户存在活跃私有订阅时，应自动完成：

* `account` 相关订阅释放
* `order` 相关订阅释放
* 账户关联资源和运行时状态清理

调用方不需要先显式执行 `unsubscribeAccount()` / `unsubscribeOrders()` 才能移除账户。

**影响**

* 优点：
  * 调用语义更完整
  * 更符合“移除账户”这个动作的自然预期
  * 降低资源泄漏和半清理状态的风险
* 代价：
  * 需要清楚定义自动清理时事件和状态如何变化
  * 文档里要强调：`removeAccount()` 比单纯退订更彻底，会移除账户配置与凭证引用

## 扩展思考

### 未来演进

* 未来大概率会加入交易命令接口，因此当前的数据面 API 不能阻碍后续把 `order` manager 扩展成“读写一体但职责清晰”的设计。
* 后续可能接入多个交易所、多账户并发，因此 client 级状态模型和 key 设计需要从第一天就保持统一。
* 未来大概率会支持 spot，因此当前虽按 derivatives-first 设计，也要避免把公共 key 和状态接口彻底写死成某个交易所的永续特例。

### 相关场景

* 市场数据、账户数据、订单数据三类接口在命名、订阅方式、读取方式上最好保持一致的心智模型。
* `subscribe*()` 应该统一表示“让 SDK 开始维护某类数据”；事件接口的命名也要统一，但不应和数据订阅入口混用。

### 失败与边界情况

* 如果 `subscribe*()` 过早 resolve，而数据尚未 ready，调用方很容易误判可用性。
* 如果事件接口与同步 getter 的职责边界不清，调用方会混淆“最新状态读取”和“增量事件处理”的正确用法。
* 如果 spot / derivatives 的统一抽象不提前想清楚，symbol、账户快照、风险字段的 public API 很容易反复推翻。
