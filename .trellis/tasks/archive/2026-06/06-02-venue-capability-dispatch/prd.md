# Capability 化下单分派 + 清 venue 硬编码（credential validator / runtime options registry）

> 路线图 step 4（`docs/multi-venue-roadmap.md` §3 第 4 条 + §4 表）。前置 step 1–3 已全部落地。
> 定位：**内部架构优化，对外非破坏**（不新增公共选项、不改数值/错误契约）。核心约束 = **行为逐条等价**。

## Goal

把 private 链路里残留的 venue 字面量分派，改为基于已建好的 **capability 查询面**（`05-06-venue-capabilities-query`，`orderCapabilities` / `accountCapabilities`）判别，让"接第一个新所"时不必再四处加 `=== "okx"`。**对外可观测行为（拒绝的 venue/操作集合、错误码、错误时机）必须保持等价**。

## What I already know（auto-context 已核实，分支 `feat/venue-capability-dispatch` @ main）

### capability 数据已就绪（Step 4 等于"接线"，不是"新建模型"）

每个 private adapter 已声明 `accountCapabilities` / `orderCapabilities`（`src/client/venue-capabilities.ts` 聚合）：

| 字段 | binance | juplend | 用途 |
|---|---|---|---|
| `accountCapabilities.credentialsRequired` | `true` | `false` | 替 `hasPrivateCredentials` 的 juplend 特判 |
| `accountCapabilities.updates` | `"websocket"` | `"polling"` | 替 coordinator account 流 binance/juplend 分派 |
| `orderCapabilities.supported` | `true` | `false`（reason `read_only`） | 替下单命令 juplend 硬拒 |
| `orderCapabilities.updates` | `"websocket"` | `"unsupported"` | 替 `subscribeOrders` juplend 硬拒 |
| `orderCapabilities.create/cancel/cancelAll` | `supported/supported/symbol` | 全 `unsupported` | 下单各动作判别（预留） |

### venue 字面量 → capability 映射（行为等价目标）

| 位置 | 现状字面量 | capability 替换 | 等价性 / 复核备注 |
|---|---|---|---|
| `runtime.ts:432` 下单命令拒 juplend → `VENUE_NOT_SUPPORTED` | `adapter.venue === "juplend"` | `!adapter.orderCapabilities.supported` | 直接等价。**message / code / metadata / 时机整条保留**，不增强（message 也是可观测输出，见 codex #5） |
| `runtime.ts:303,440` / `context.ts:106` `hasPrivateCredentials` juplend→true | `venue === "juplend"` | `credentialsRequired ? Boolean(apiKey&&secret) : true` | 直接等价。**helper 不可反向 import adapter/capability**：改签名收 `credentialsRequired: boolean`，由调用方（runtime/context 持 adapter 处）传入（codex 实现提醒） |
| `order-manager.ts:104` `subscribeOrders` 拒 juplend → `VENUE_NOT_SUPPORTED` | `account.venue === "juplend"` | **订阅路径读 `orderCapabilities.updates === "unsupported"`**（命令路径才读 `!supported`，勿混用，见 codex #6） | 直接等价。但 `OrderManager` 只有 `ClientContext`、拿不到 adapter capability → **需新增内部 capability 查询入口**（`ClientContext` 方法或 runtime 窄接口 `getPrivateOrderCapabilities(venue)`），同步改测试 stub（`StubContext`）。**故 Commit 1 非纯机械** |
| **coordinator 主账户/订单 stream 顺序** `:118/:236/:321/:342/:351/:377` | `record.venue === "binance"/"juplend"` | 主 stream 顺序按 `accountCapabilities.updates`（`"websocket"` → 先 ensureStream 后 bootstrap；`"polling"` → 先 bootstrap 后 stream）；order 流按 `orderCapabilities.updates === "websocket"` | **最高等价风险**，逐路径核对 |
| **coordinator REST refresh polling** `:319/:341/:381` | `record.venue !== "binance"` gate refresh timer | **按 `typeof adapter.refreshAccount === "function"` 判别**（public capability **无 `refresh` 字段**，用 method 存在性，见 codex #1）；保留 `refreshAccount` 成功后 `{ preserveStatus: true }` 语义 | binance = WS **+** refresh polling 混合，单 `updates` 字段表达不了，必须独立 predicate |
| `coordinator:703` 失败 fallback flavor | `record.venue === "juplend" ? "http_failed" : "auth_failed"` | `const adapter = this.getAdapter(record.venue); transportReason(error, adapter.accountCapabilities.credentialsRequired ? "auth_failed" : "http_failed")` | 等价。注意 `transportReason` 是 **fallback**：`kind==="rate_limited"` 时仍返回 `"rate_limited"`（优先级**必须保留**，勿写成覆盖），否则用 fallback（codex #3） |
| `coordinator.startStream():492` credential 预检 | `!credentials && record.venue !== "juplend"` | `adapter.accountCapabilities.credentialsRequired && !credentials` | 仅等价替换，**不在此处引入完整 validator**（codex #4） |
| `adapters/types.ts:213` `PrivateStreamOptions.juplendPollIntervalMs` | 通用类型被污染 | 见 Commit 3 目标形状（**不**新增 `venueOptions` map） | 纯内部；验收 = `PrivateStreamOptions` 不再出现 `juplend` 字样 |

### 对外面已是好状态（无需动）

- 公共 `AccountRuntimeOptions`（`src/types/shared.ts:91`）**已 venue 命名空间化**：`binance?:{riskPollIntervalMs}` / `juplend?:{pollIntervalMs,rpcUrl,jupApiKey}`。路线图 §4「`shared.ts:34` 写死」表述已过时。
- §4 表中 `rate_limited`(shared.ts) 与签名 `Date.now()`(private-adapter) 两行已被 **Step 3** 消化。

## Assumptions (temporary)

- 暂无第二个 cex 落地；本任务以 **capability 接线 + 用 binance/juplend 现状回归** 为主，默认**不改对外行为**。
- OKX passphrase（roadmap §2.2）本质是 **Step 5** 接 OKX 时的需求，非本任务硬前置。

## Open Questions（仅 blocking / preference）

- ~~**Q1** per-adapter credential validator 深度~~ → **已定：方案 1（轻量）**。只用 `accountCapabilities.credentialsRequired` 清 juplend 特判（`credentialsRequired ? Boolean(apiKey&&secret) : true`）；**不**引入 per-adapter validator 接口，OKX passphrase 校验延后到 Step 5 随 OKX adapter 落地（与 Step 3 延后 server-time 校准同一克制，roadmap §2.1 先例）。
- ~~**Q2** coordinator:703 失败 code 差异~~ → **已定（codex 复核修正对象来源）**：`transportReason(error, adapter.accountCapabilities.credentialsRequired ? "auth_failed" : "http_failed")`，其中 `adapter = this.getAdapter(record.venue)`（`RegisteredAccountRecord` 无 `credentialsRequired` 字段）。`transportReason` 为 fallback，`rate_limited` 优先级保留。对 binance/juplend 逐字节等价、去字面量。
- ~~**Q3** 交付粒度~~ → **已定**：单任务，**3 顺序 commit + 一次 PR**（非 3 个独立 PR）。整体行为等价、属同一逻辑单元；3 commit 保留逐步审查粒度。
- ~~**Q4** 谁实现 / 复核分工~~ → **已定**：**codex 实现** 3 commit，**Claude 独立复核**（重点 PR2 coordinator 逐路径等价 + 全程对外行为不漂移），复核过再开 PR。PRD 本身也先经 codex 复核一轮。

## Requirements (evolving)

- private 下单命令（`!orderCapabilities.supported`）/ `subscribeOrders`（`orderCapabilities.updates === "unsupported"`）/ credential 存在性（`credentialsRequired`）判别改为 capability 驱动，删除 `runtime.ts` / `order-manager.ts` / `context.ts` 对应 venue 字面量。
- 为 `OrderManager.subscribeOrders` 提供内部 capability 查询入口（`ClientContext` 方法或 runtime 窄接口），避免让 manager 直接依赖 adapter registry；同步更新测试 stub。
- coordinator 改为 **两个独立 predicate**：①主账户/订单 stream 顺序按 `accountCapabilities.updates` / `orderCapabilities.updates`；②REST refresh polling 按 `typeof adapter.refreshAccount === "function"`（非 `updates`），保留 `{ preserveStatus: true }` 与 `closeIfUnused` 回滚语义。逐路径等价。
- 内部 `PrivateStreamOptions.juplendPollIntervalMs` 收口（Commit 3 目标形状），公共 `AccountRuntimeOptions` 不变。
- **对外可观测输出（`AcexError` code + message + metadata、拒绝集合、错误时机、polling vs WS 路径）逐条等价**——message 也不增强（回归测试覆盖）。

## Acceptance Criteria (evolving)

- [ ] `runtime.ts` / `order-manager.ts` / `context.ts` / `coordinator.ts` 不再出现 `=== "binance"` / `=== "juplend"` 的**业务分派**（注册/构造期 venue→adapter 映射、adapter 自身 `readonly venue`、`SUPPORTED_VENUES`、register discriminated union、public namespaced options 等**合理保留**，见 codex 确认清单）。
- [ ] `PrivateStreamOptions` 不再出现 `juplend` 字样。
- [ ] **新增** Juplend `createOrder` / `cancelOrder` / `cancelAllOrders` 拒绝测试：仍抛 `VENUE_NOT_SUPPORTED`、且发生在 adapter command 之前（现仅有 `subscribeOrders` 拒绝测试 `tests/integration/order.test.ts:683`）。
- [ ] 缺 cred 仍抛 `CREDENTIALS_MISSING`；message / metadata / 时机不变。
- [ ] **新增** coordinator 单测：websocket-like adapter → 先 ensureStream 后 bootstrap 且继续 refresh polling；polling-like adapter → 先 bootstrap 后 stream；无 `refreshAccount` 方法 → 不调度 refresh timer；失败回滚不残留 timer / listenKey。
- [ ] 失败 reason：binance 非 rate-limit → `auth_failed`、juplend → `http_failed`、rate-limit → `rate_limited`（三组 reason 锁死）。
- [ ] 公共类型 / 公共选项无变更（非破坏）；含 patch changeset（无公共 API 变更，但内部 src 重构按仓库约定仍打 patch、随下次 beta 发布，见 release-publishing §3.7 + market-ws-connection-multiplexing 先例）。
- [ ] lint / type-check / test 全绿。

## Definition of Done

- 回归测试覆盖等价拒绝路径（下单 / subscribeOrders / 缺 cred / juplend polling vs binance WS）。
- lint / type-check / CI 全绿。
- `adapter-contract.md` 补"capability 驱动分派"段；`docs/multi-venue-roadmap.md` 进度表更新（Step 3 ✅ / Step 4）。

## Decision (ADR-lite)

- **D1（capability 接线）** 内部分派直接读 adapter 实例上的 `.orderCapabilities` / `.accountCapabilities`（runtime/coordinator/order-manager 本就持有 adapter）；**不**走 `getVenueCapabilitiesSnapshot`（那是对外快照、会 clone）。
- **D2（credential validator 延后）** 仅用 `accountCapabilities.credentialsRequired` 清 juplend 特判；per-adapter validator 接口 + OKX passphrase 留到 Step 5（YAGNI，同 Step 3 延后 server-time 之克制）。
- **D3（失败 flavor）** `coordinator:703` fallback 改为 `adapter.accountCapabilities.credentialsRequired ? "auth_failed" : "http_failed"`（adapter 经 `getAdapter(record.venue)` 取，record 无此字段）；`transportReason` 的 `rate_limited` 优先级保留。对现有两 venue 逐字节等价。
- **D4（交付）** 单任务、3 顺序 commit、一次 PR；codex 实现 + Claude 复核。
- **核心不变量**：对外可观测行为（拒绝的 venue/操作集合、`AcexError` code、错误时机、polling vs WS 路径）逐条等价；无公共 API / 数值 / 错误码契约变更，**含 patch changeset**（无公共 API / 数值 / 错误码契约变更；内部 src 重构按仓库约定仍打 patch）。

## Implementation Plan（3 commit → 1 PR，按等价风险升序）

- **Commit 1 — 离散判别点（**非纯机械**，含一处内部接口新增）**：`runtime.ts` 下单命令（`!orderCapabilities.supported`）、`order-manager.ts` `subscribeOrders`（`orderCapabilities.updates === "unsupported"` + 新增 capability 查询入口）、`hasPrivateCredentials`（改签名收 `credentialsRequired`，调用方传入）、`coordinator:703` 失败 fallback（D3）、`startStream:492` credential 预检等价替换。**先补测试再改实现**：锁 Juplend 三下单命令拒绝 + `VENUE_NOT_SUPPORTED` / `CREDENTIALS_MISSING` / `auth_failed`·`http_failed`·`rate_limited`。
- **Commit 2 — coordinator stream 分派（绕、高风险）**：两个独立 predicate——①主 stream 顺序按 `accountCapabilities.updates`（`subscribeAccountFeed:118` 等）/ `orderCapabilities.updates`；②REST refresh polling 按 `typeof adapter.refreshAccount === "function"`（`:319/341/381`），保留 `{ preserveStatus: true }`。逐路径核对 + 新增 coordinator 单测（ws-like vs polling-like 顺序、refresh 调度、失败回滚不残留 timer/listenKey）。
- **Commit 3 — 内部 options 收口 + 文档**：`PrivateStreamOptions.juplendPollIntervalMs` 收口——**不**在通用类型加 `venueOptions` map；倾向 coordinator 内按 `adapter.venue` 解析、只把通用 stream knobs 传 adapter，Juplend poll interval 走 `accountOptions` 或专门内部 carrier。验收 = `PrivateStreamOptions` 无 `juplend` 字样。更新 `adapter-contract.md`（capability 驱动分派段）+ `docs/multi-venue-roadmap.md` 进度表（Step 3 ✅ / Step 4 + §4 表勘误）。

## Out of Scope

- 接第一个新所（Step 5）。
- OKX passphrase 的实际校验实现（Q1 已定延后）；**per-adapter credential validator 接口本身也不在本任务**，留到 Step 5。
- symbol encode/decode 共享边界、下单 catalog 校验（§2.4，未排期）。
- `AsyncEventBus` 背压（§2.6，未排期）。
- 任何公共 API / 数值 / 错误码契约的破坏性改动。

## Technical Notes

- capability 聚合：`src/client/venue-capabilities.ts`；adapter 取值：`binance/private-adapter.ts:575-598`、`juplend/private-adapter.ts:670-694`。
- 字面量点：见上表（行号 @ 分支 head，实现时以实际代码为准）。
- 错误码契约：adapter 抛 transport/裸 error、manager/runtime 归一到 `AcexError`（`adapter-contract.md`，Step 3 已沿用）；`OrderManager` 对 runtime 抛的 `AcexError` 原样返回、不包成 `ORDER_*_FAILED`（`order-manager.ts:661/674`），故 runtime 拒绝条件 capability 化后只要 code 不变、对外不漂移。
- **实现者提醒（codex 复核）**：
  - `hasPrivateCredentials()` 是 `context.ts` 纯 helper、无 adapter registry → 改签名收 `credentialsRequired`，**勿在 helper 内反向 import adapter/capability**（避免层级反转）。
  - `getPrivateCommandAccount()` 已持 adapter，是读 `orderCapabilities.supported` 的最佳位置。
  - `subscribeOrders()` 仅能经 `ClientContext` 拿 account → 需新增内部 capability 查询入口并同步 `StubContext` 等测试 stub。
  - `transportReason()` 的 `rate_limited` 优先级必须保留，勿写成覆盖。
  - `closeIfUnused()` 失败回滚敏感：改 stream 顺序后须保证失败不残留 Juplend poll timer / Binance listenKey。
- **Step 5 交接（D2 延后的代价）**：public `AccountCredentials` 已有 `password` / `extra`（`shared.ts:117`），OKX passphrase 可经 `password` 或 `extra.passphrase` 表达；但 **Step 5 接 OKX 时必须补 per-adapter credential validator / schema**——`credentialsRequired: boolean` 只能表达"需要某些凭证"，不能表达"需要 apiKey+secret+passphrase"。
- **PRD 复核**：见 [`codex-prd-review.md`](codex-prd-review.md)（codex 进代码逐条核实；本 PRD 已折入其 8 点修正 + 实现提醒）。
