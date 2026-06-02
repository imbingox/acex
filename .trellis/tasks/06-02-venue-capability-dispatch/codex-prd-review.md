# PRD 对抗性复核：venue capability dispatch

总体判断：PRD 方向可据以实现，但需要先补两类约束：coordinator 账户链路不能只用 `accountCapabilities.updates` 一个字段粗暴替代所有 `binance/juplend` 分派；D3 的实现表达式写错了对象来源，且需明确 `transportReason` 的 fallback 语义。

## 确认无误

- capability 真源已在两个 private adapter 上，且当前取值与 PRD 表一致：Binance `accountCapabilities.updates = "websocket"`、`credentialsRequired = true`、`orderCapabilities.supported = true`、`orderCapabilities.updates = "websocket"`（`src/adapters/binance/private-adapter.ts:575`、`src/adapters/binance/private-adapter.ts:585`）；Juplend `accountCapabilities.updates = "polling"`、`credentialsRequired = false`、`orderCapabilities.supported = false`、`reason = "read_only"`、`orderCapabilities.updates = "unsupported"`（`src/adapters/juplend/private-adapter.ts:670`、`src/adapters/juplend/private-adapter.ts:680`）。
- capability 聚合层按 adapter 真源组合并 clone 返回，PRD 的 D1「内部直接读 adapter capability，不走 public snapshot」合理；public snapshot 会 clone（`src/client/venue-capabilities.ts:55`、`src/client/venue-capabilities.ts:90`）。
- `src/` 内实际 `===/!== "binance"/"juplend"` 比较清单完整，PRD 覆盖了所有业务分派比较点：`runtime.ts` 下单拒 Juplend（`src/client/runtime.ts:432`）、`context.ts` credential 特判（`src/client/context.ts:110`）、coordinator 分派簇（`src/client/private-subscription-coordinator.ts:118`、`:236`、`:321`、`:342`、`:351`、`:377`、`:492`、`:703`）、`OrderManager.subscribeOrders()`（`src/managers/order-manager.ts:105`）。
- PRD 未覆盖但应合理保留的 venue 字面量包括：`SUPPORTED_VENUES` / register discriminated union / public namespaced options（`src/types/shared.ts:1`、`:91`、`:141`、`:148`）、runtime 构造期 adapter 注册和 Juplend 构造参数注入（`src/client/runtime.ts:107`、`:114`）、adapter 自身 `readonly venue` 常量（`src/adapters/binance/private-adapter.ts:568`、`src/adapters/juplend/private-adapter.ts:664`）、Binance/Juplend adapter 内部实现字符串和 URL。这些不是业务分派。
- `hasPrivateCredentials()` 的 capability 替换对现有两 venue 等价：当前 Juplend 直接返回 true，其他 venue 要 `apiKey && secret`（`src/client/context.ts:106`）；当前 adapter capability 正好是 Juplend `credentialsRequired=false`、Binance `true`。
- `subscribeOrders()` 用 `orderCapabilities.updates === "unsupported"` 拒 Juplend对现有两 venue 等价：当前 public path 在 credential check 前直接抛 `VENUE_NOT_SUPPORTED`（`src/managers/order-manager.ts:102`、`:105`、`:112`），Binance 为 `"websocket"`、Juplend 为 `"unsupported"`。
- `runtime.getPrivateCommandAccount()` 用 `!orderCapabilities.supported` 拒 Juplend对现有两 venue 等价：当前先取 adapter，再对 Juplend 抛 `VENUE_NOT_SUPPORTED`，之后才做 private credentials 检查（`src/client/runtime.ts:429`、`:432`、`:440`）。
- `OrderManager` 对 runtime 抛出的 `AcexError` 会原样返回，不会包装成 `ORDER_CREATE_FAILED` / `ORDER_CANCEL_FAILED` / `ORDER_CANCEL_ALL_FAILED`（`src/managers/order-manager.ts:661`、`:674`）。所以把 runtime 拒绝条件 capability 化后，只要仍抛同一个 `AcexError` code，public command code 不会漂移。
- 公共 `AccountRuntimeOptions` 已 namespace 化，PRD 对 roadmap 旧锚点的勘误成立（`src/types/shared.ts:91`）。

## 需修正 / 补充

### 1. coordinator 账户流不能只靠 `accountCapabilities.updates` 表达 Binance 现状

问题：PRD 写「account 流 gate on `accountCapabilities.updates === "websocket"` vs `"polling"`」，但 Binance 当前是 WS 私有流 + REST `refreshAccount()` polling 的混合模型。`updates: "websocket"` 只能表达主 private stream，不表达 risk refresh polling。如果实现时把 `record.venue === "binance"` 的 refresh timer 全替成单字段判断，容易误删 Binance risk/position 校准，或把 future websocket venue 错误纳入 refresh timer。

代码证据：Binance capability 是 `updates: "websocket"`（`src/adapters/binance/private-adapter.ts:575`），但 adapter 同时实现 `refreshAccount()`（`src/adapters/binance/private-adapter.ts:656`）；coordinator 现有 refresh polling 由 `record.venue !== "binance"` gate 和 `binanceRiskPollIntervalMs` 调度（`src/client/private-subscription-coordinator.ts:319`、`:341`、`:381`）。`refreshAccount()` 成功后还必须用 `{ preserveStatus: true }`，不能把 WS 断线期间的状态改回 healthy（`src/client/private-subscription-coordinator.ts:427`、`:432`）。

建议改法：PRD 明确拆成两个 predicate：主账户 stream 顺序按 `accountCapabilities.updates` 判别；REST refresh polling 按 `typeof adapter.refreshAccount === "function"`（必要时再加 `record.accountSubscribed` 和现有 interval）判别，而不是单靠 `updates`。如果坚持 capability 面，应在 PRD 里承认当前 public capability 没有 `refresh` 字段，使用 adapter method presence 是本任务的内部能力判别。

### 2. Juplend polling 的 subscribe 顺序必须被锁住

问题：Juplend `createPrivateStream().ready` 不会立即拉首个 snapshot，只是安排下一次定时 poll；所以现有 `subscribeAccountFeed()` 先 `bootstrapAccount()` 再 `ensureStream()` 是可观测行为。PRD 提到了顺序风险，但 Acceptance/测试描述还不够硬。

代码证据：Juplend 分支当前先 bootstrap 后 stream（`src/client/private-subscription-coordinator.ts:118`）；Juplend stream 的 `ready` 只调用 `scheduleNextPoll()`，不会马上执行 `poll()`（`src/adapters/juplend/private-adapter.ts:801`）；poll 到期后才调用 `bootstrapAccount()` 并发 `onAccountSnapshot`（`src/adapters/juplend/private-adapter.ts:773`、`:783`）。

建议改法：PRD 在 Commit 2 明确要求单测验证调用顺序：polling account venue 订阅时 `bootstrapAccount` 先于 `createPrivateStream/ready` 产生首个 snapshot；websocket account venue 则保持 `ensureStream` ready 后再 bootstrap（`src/client/private-subscription-coordinator.ts:121`）。

### 3. D3 里的 `account.credentialsRequired` 是错误对象；`transportReason` 是 fallback，不是覆盖值

问题：PRD 的 Q2/D3 写 `transportReason(error, account.credentialsRequired ? "auth_failed" : "http_failed")`。实际 `RegisteredAccountRecord` 没有 `credentialsRequired` 字段（`src/client/context.ts:18`），需要从 `adapter.accountCapabilities.credentialsRequired` 取。并且 `transportReason()` 不是无条件覆盖 reason；它只在 `TransportError.kind === "rate_limited"` 时返回 `"rate_limited"`，否则返回传入 fallback。

代码证据：`transportReason()` 语义在 `src/client/private-subscription-coordinator.ts:49`，`:53` 返回 rate_limited，`:55` 返回 fallback。现有 bootstrap fallback 是 Juplend -> `"http_failed"`，其他 -> `"auth_failed"`（`src/client/private-subscription-coordinator.ts:701`、`:703`）。`RegisteredAccountRecord` 字段只有 `accountId/venue/credentials/options`（`src/client/context.ts:18`）。

建议改法：D3 改成类似 `const adapter = this.getAdapter(record.venue); const fallback = adapter.accountCapabilities.credentialsRequired ? "auth_failed" : "http_failed"; reason: transportReason(error, fallback)`。对当前两 venue 等价：Binance 非 rate-limit 仍 `"auth_failed"`，Juplend 非 rate-limit 仍 `"http_failed"`，rate limit 仍统一被 `transportReason` 提升为 `"rate_limited"`。

### 4. `PrivateSubscriptionCoordinator.startStream()` 的 credential 检查不要被顺手加强

问题：`startStream()` 当前只检查 `credentials` 对象是否存在，并用 `record.venue !== "juplend"` 决定是否提前抛 `CREDENTIALS_MISSING`。public 订阅路径更早由 `ensurePrivateCredentials()` 做 `apiKey && secret` 检查。若实现时把 `startStream()` 也改成 `credentialsRequired ? Boolean(apiKey && secret) : true`，会改变一些内部/恢复边界路径的错误来源与时机。

代码证据：public account subscribe 先调用 `ensurePrivateCredentials()`（`src/managers/account-manager.ts:107`、`:110`）；public order subscribe 先硬拒 Juplend，再 credential check（`src/managers/order-manager.ts:102`、`:105`、`:112`）；coordinator `startStream()` 当前只判断 `!credentials && record.venue !== "juplend"`（`src/client/private-subscription-coordinator.ts:491`、`:492`）。Binance adapter 自身仍会在实际请求处校验 `apiKey/secret`（`src/adapters/binance/private-adapter.ts:184`、`:188`）。

建议改法：`startStream()` 这处只做等价替换：`if (adapter.accountCapabilities.credentialsRequired && !credentials) ...`。不要在这处引入完整 credential validator。

### 5. PRD 对错误 message 的态度和“逐字节等价”冲突

问题：PRD 表里写 runtime 下单拒 Juplend 时「message 可用 `reason` 增强但 code 须不变」。如果本任务定义为纯内部重构、对外可观测行为逐条等价，`AcexError.message` 也是可观测输出；顺手增强 message 会制造非必要 diff。

代码证据：当前 runtime 下单拒绝 message 是 `Venue does not support private order commands: ${account.venue}`（`src/client/runtime.ts:433`、`:435`）；order subscription 拒绝 message 是 `Venue does not support private order subscriptions: ${account.venue}`（`src/managers/order-manager.ts:106`、`:108`）。

建议改法：PRD 把「message 可增强」删掉或标为 out of scope；本任务保留现有 message、code、metadata 和抛错时机。

### 6. `orderCapabilities.supported` 与 `orderCapabilities.updates` 不要混用到订阅路径

问题：PRD 对 `subscribeOrders` 写 `orderCapabilities.updates === "unsupported"`（或 `!supported`）。对现有 Binance/Juplend 二者等价，但语义上订阅路径应读 `updates`，命令路径才读 `supported/create/cancel/cancelAll`。否则未来可能出现 read-only 但有 order history/update 的 venue 时被多拒。

代码证据：capability 类型把 venue 级 order command support 和 order update support 分开（`src/types/client.ts:102`、`:105`）。Juplend 当前二者都 unsupported（`src/adapters/juplend/private-adapter.ts:681`、`:683`），所以这次不暴露差异。

建议改法：PRD 固定 `subscribeOrders` 使用 `orderCapabilities.updates === "unsupported"`；下单命令使用 `!orderCapabilities.supported`，如未来要逐动作细化再看 `create/cancel/cancelAll`。

### 7. 测试面需要补得更具体

问题：PRD 的 DoD 写“回归测试覆盖等价拒绝路径”，但实际现有测试只覆盖了 Juplend `subscribeOrders` 拒绝（`tests/integration/order.test.ts:683`）和 Juplend account 不需 credentials（`tests/integration/account.test.ts:1017`）。未看到 Juplend `createOrder/cancelOrder/cancelAllOrders` 仍抛 `VENUE_NOT_SUPPORTED` 的测试，也缺少 capability 化后 coordinator 账户顺序和 refresh polling predicate 的单测。

代码证据：当前 order command 测试集中在 Binance 成功/失败（`tests/integration/order.test.ts:276`、`:572`），Juplend 只测 order subscription（`tests/integration/order.test.ts:683`）。已有 coordinator unit tests只覆盖 Binance risk polling 的 missing account 和非法 interval fallback（`tests/unit/private-subscription-coordinator.test.ts:210`、`:236`）。

建议改法：Commit 1 增加 Juplend `createOrder/cancelOrder/cancelAllOrders` 拒绝集合测试，断言 code 仍是 `VENUE_NOT_SUPPORTED` 且发生在 adapter command 前；Commit 2 增加 coordinator unit tests，断言：Binance-like websocket adapter 仍启动 stream 后 bootstrap 并继续 refresh polling；Juplend-like polling adapter 仍 bootstrap 后启动 stream；`refreshAccount` method absence 不调度 timer。

### 8. Commit 3 的“内部 options registry”范围还不够可执行

问题：PRD 只说把 `PrivateStreamOptions.juplendPollIntervalMs` 收口为 venue-namespaced internal carrier，但没有给目标形状。实现者容易在 `PrivateStreamOptions` 里直接新增 `venueOptions?: { juplend?: ... }`，也可能继续把 public `AccountRuntimeOptions` 的 venue 字段穿透到 adapter 通用接口。

代码证据：当前通用 adapter stream options 被 Juplend 字段污染（`src/adapters/types.ts:208`、`:213`），coordinator 从 public options 读 `options.juplend?.pollIntervalMs` 后再塞回通用 stream options（`src/client/private-subscription-coordinator.ts:105`、`:590`、`:595`）。Binance risk polling options 不进入 `PrivateStreamOptions`，而是 coordinator 自己用（`src/client/private-subscription-coordinator.ts:101`、`:381`）。

建议改法：PRD 明确目标类型，例如在 `PrivateStreamOptions` 中放内部 `venueOptions?: Record<string, Record<string, unknown>>` 不是好选择；更适合在 coordinator 内部按 adapter.venue 解析并只把通用 stream knobs 传入 adapter，Juplend polling interval 通过 `accountOptions` 或专门的内部 adapter options carrier 传递。无论选哪种，验收应包含 `PrivateStreamOptions` 不再出现 `juplend` 字样。

## 实现者提醒

- `hasPrivateCredentials()` 当前在 `context.ts` 是纯 helper，没有 adapter registry。实现时要么改签名为接收 `credentialsRequired`，要么把 credential 判定收口到 `runtime` 里；不要在 helper 内反向 import adapter 或 capability snapshot，避免层级反转。
- `getPrivateCommandAccount()` 已经拿到 `adapter`，是最适合读 `adapter.orderCapabilities.supported` 的位置（`src/client/runtime.ts:429`、`:431`）。
- `subscribeOrders()` 当前只能通过 `ClientContext` 拿 account，拿不到 private adapter capability。若不想让 `OrderManager` 依赖 adapter registry，需要给 `ClientContext` 增加一个内部 capability 查询方法，或让 runtime 暴露 `getPrivateOrderCapabilities(venue)` 这类窄接口。这个接口变更是内部的，但要同步测试 stub（例如 `tests/unit/private-subscription-coordinator.test.ts` 的 `StubContext`）。
- coordinator 的 `closeIfUnused()` 失败回滚路径很敏感：`subscribeAccountFeed()` catch 会把 `accountSubscribed=false` 后 close stream（`src/client/private-subscription-coordinator.ts:126`、`:128`）。改顺序时要确保失败后不会留下 Juplend poll timer 或 Binance listenKey。
- `transportReason()` 的 rate-limit 优先级必须保留；不要把 fallback 判断写成覆盖 `"rate_limited"`。
- D2 延后 validator 对 Step 5 基本安全：public `AccountCredentials` 已有 `password` 和 `extra`（`src/types/shared.ts:117`），OKX passphrase 可在 Step 5 用 `password` 或 `extra.passphrase` 表达；但 Step 5 接 OKX 时必须补 per-adapter credential validator 或 credential schema，否则 `credentialsRequired` 这个 boolean 仍只能表达“需要某些凭证”，不能表达“需要 apiKey + secret + passphrase”。
- 3 commit 切分整体合理，但 Commit 1 不是纯机械：D3 需要 adapter lookup，`subscribeOrders` 需要内部 capability 查询入口。建议先补测试再改实现，尤其锁住 `VENUE_NOT_SUPPORTED`、`CREDENTIALS_MISSING`、`auth_failed/http_failed/rate_limited` 三组 code/reason。
