# 多交易所内置扩展基建（P1-C2 / C3 / C4 + 内部 adapter 注册表）

## Goal

打好"新增内置交易所（OKX/Bybit/Gate 等）"的基建，让后续接入新 venue 的改动集中在 adapter 层、尽量不动通用层；一次铺三处扩展点 + 修一个现存正确性 bug。定位：crypto 多交易所量化 SDK（HFT+LFT），热路径按 HFT 标准。

> 本 PRD 已经过 codex **三轮**独立 review（共 12 个 blocker 核实并落实）：轮1（6）=C4 重连/raw-pong、C3 预热/family-load、C1 时钟生命周期、C2 类型；轮2（3）=C2 全仓迁移面、C3 miss 状态污染、catalog 错误通道；轮3（3）=miss 丢 trade/fee 不可 REST 补回、catalog single-flight、工厂 deps 不足以构造 Juplend。

## Requirements

- **C3（正确性，非协商）**：私有链路 symbol 归一化改走权威共享 catalog（exchangeInfo），删掉后缀 hack（`normalizeUmSymbol`/`encodeUmSymbol`），修交割合约错配。**本次只实现 UM（usdm）**，但 catalog 查找 API family-scoped，后续接 spot/CM 只扩 family。
- **C1-内部 registry**：runtime 构造改成 venue→工厂映射，每工厂构造该 venue 的 adapter 组（Binance 工厂顺手造共享 catalog + 持有 SyncingTimeProvider 生命周期资源回交 runtime）。**不导出公开第三方 SPI**。
- **C2**：所有 venue 专属配置统一收进 `account.venues.<venue>`（含原 `account.binance`、`account.juplend`、顶层 `listenKeyKeepAliveMs`），协调器/构造按 venue 取值。**直接删旧 `account.binance` + `account.juplend`**（pre-1.0 + 仅自有下游，不留别名），同步迁移 README/docs/测试夹具/runtime juplend 构造点。
- **C4**：给流层加可选**应用层心跳保活**能力。research 证实简单 ping 不够，且实现要**动 managed-websocket 状态机**（不是只加接口字段）。Binance/Gate-futures 靠 ws 库协议层 pong，行为不回归。

## Acceptance Criteria

- [ ] **C3 映射**：单测覆盖交割合约（USDM `BTCUSDT_250627` → `BTC/USDT:USDT-20250627`，**需新增 USDM delivery fixture**，现有只有 COINM `BTCUSD_250627`）、多 quote、`1000SHIBUSDT`、**spot↔usdm 同名 `BTCUSDT` family-scoped 不串**；正反向（`toUnified`/`toVenueId`）均带 family。
- [ ] **C3 加载边界**：所有归一化 symbol 的 async 私有入口先 `await catalog.ensureLoaded("usdm")`——含订单命令（create/cancel/cancelAll/fetchOrder/bootstrapOpenOrders/fetchOpenOrders）**与账户路径**（bootstrapAccount/refreshAccount/reconcileAccount，经 `mapUmPosition`）；私有流预热须在**建立底层 WS（createSession）之前**完成，确保首条 WS `ORDER_TRADE_UPDATE`/`ACCOUNT_UPDATE` 到达 catalog 已就绪；WS 同步回调只 lookup。`ensureLoaded("usdm")` **只依赖 UM exchangeInfo**，spot/coinm 故障不阻塞；reload 原子 swap、失败保留旧 map；**`ensureLoaded`/refresh 按 family single-flight 合并并发首次加载**（参 market-manager.ts:591 同 venue reload coalesce），并发 create/fetch/refresh/stream 只打一发 USDM exchangeInfo。
- [ ] **C3 miss 安全（不污染状态、不丢成交）**：`toVenueId` miss（命令）→ 抛 typed `SymbolMappingError`（拒绝用未知 symbol 下单）。`toUnified` miss（入站 order/position）→ **不写主状态**（order 按 `symbol` 建 location key，store.ts:355；写 raw id 会分裂 openOrders/claim/reconcile）→ **bounded raw quarantine → 立即触发 catalog refresh（single-flight）→ refresh 后 replay 原始帧；仍 miss 才 drop + 去重 runtime error**。⚠不能简单 drop 靠周期 reconcile 补：miss 的若是带 trade/fee/realizedPnl 的 FILLED，REST `fetchOrder` 补不回逐笔成交（order-execution.md:426 / B5），且 C2 允许 `privateReconcileIntervalMs:0`——故 miss 同时**触发一次 immediate private reconcile**，不依赖周期。单测覆盖 quarantine→replay 成功 与 replay 仍 miss→drop 两条路径。
- [ ] **registry + 时钟**：集成测试走通经 registry 构造的 Binance 组 + 共享 catalog；`options.clock` 注入时**不创建** SyncingTimeProvider/sampler/timer（保持现状语义）；client `start()/stop()` 正确启停工厂回交的时钟资源。
- [ ] **C2 迁移（grep-gate，精确旧路径）**：`rg 'account\.binance|account\.juplend|account\??\.listenKeyKeepAliveMs'` **全仓归零**（注意：`listenKeyKeepAliveMs` 裸词仍合法存在于新 `venues.binance` 类型与 internal `PrivateStreamOptions`，故只门禁**顶层 account.* 旧路径**）。实测迁移面 = 11 文件、约 60+ 处（src/coordinator、README、docs/api.md 含 109/636 Juplend 块、`scripts/live-{order,juplend-account}-smoke.ts`、`tests/unit/private-subscription-coordinator.test.ts`、`tests/integration/{account,order}.test.ts`）；`lint`/`type-check`/`test` 全绿。
- [ ] **C2 行为**：新 `account.venues.<venue>.*` 生效、两 venue 不同 interval 互不影响；`privateReconcileIntervalMs:0` = 关闭周期 reconcile；**Juplend 不吃 CEX reconcile/riskPoll 默认**（仅 adapter polling）。
- [ ] **C4**：fake 协议单测覆盖 idle-timeout 与 fixed-interval 两 mode、`countAnyInboundAsActivity` 重置 idle、命中 `isPong` 的 raw 帧**在 parse 之前被消费**、`pongTimeoutMs` 到期触发**重连并 replay 订阅**（含多 subscriber 用例）、**timer 生命周期**（idle/pong timer 在 close/close-event/reconnect 前清理、callback 校验 activeSocket、pong 不清 initialMessageTimeout、pending pong 期间不重复发 ping、重连不泄漏 timer）；未配 heartbeat 的 Binance 路径零行为变化。

## Definition of Done

- 单测/集成测试覆盖（含 C3 回归 + collision + USDM delivery fixture）。
- `bun run lint` / `type-check` / `test` 绿。
- **本任务新增 1 个 minor changeset**（C2 改公开配置属破坏性，pre-1.0 计 minor；changesets 已在 pre 模式）。
- 回写 spec：adapter-contract（symbol 归一化来源 + 心跳契约）、order-execution（miss/trade 语义）、**venue-lending.md**（含 `account.juplend.rpcUrl` 旧引用 :94/:134）、docs/api.md + README（per-venue 配置）。

## Technical Approach

**交付：单任务、单 PR、3 组 commit、1 个 minor changeset。**

### Commit 1（正确性优先：registry + 共享 catalog + C3）

- **内部 registry**（runtime.ts:171-188）：venue→工厂映射。工厂签名约 `(deps:{rateLimiter, signingClock?, publishRuntimeError, venueOptions}) => { marketAdapter?, privateAdapter?, lifecycle?: { start(); stop() } }`（`publishRuntimeError` 由 runtime 透传供 catalog/adapter 上报 load-fail/miss；`venueOptions` = `account.venues.<venue>`，Juplend 工厂需 `rpcUrl/jupApiKey/pollIntervalMs` 才能构造，见 runtime.ts:178 / juplend private-adapter.ts:695；**每个 commit 须独立 type-check**）。Binance 工厂内：构造共享 `BinanceMarketCatalog`、注入 market + private 两 adapter；按 `options.clock` 决定**是否**创建 `SyncingTimeProvider`（注入时不建，保持 runtime.ts:146/312/338 现状语义），并把 provider 作为 `lifecycle` 资源回交 runtime 统一 `start()/stop()`。**不加** `CreateClientOptions.adapters` 公开入口。
- **`BinanceMarketCatalog`**（从 adapter 内 `definitions` Map 抽出）：
  - 存储 `Map<family, Map<venueId, def>>` + 反向 `Map<family, Map<unified, venueId>>`（嵌套，热路径零 composite-key 分配）。
  - `ensureLoaded(family)`：**family-scoped + single-flight**——重构 `loadBinanceMarkets`（market-catalog.ts:304 现 `Promise.all([spot,usdm,coinm])` 全挂）为按 family 加载，UM 只需 `usdm` 不被 spot/coinm 故障阻塞；已加载 no-op；维护 `inFlightByFamily` 合并并发首次加载/refresh（参 market-manager.ts:591）。
  - reload 原子 swap：新 map 成功才替换，失败保留旧 map + 经注入 `publishRuntimeError` 上报（去重 `family+venueId`）。**reverse map 对 delivery 合约保留 bounded tombstone**（新 exchangeInfo 移除已到期合约后仍可能来 late terminal update；保留到该合约无 open orders 再清）。
  - 同步 `toUnified(family, venueId)` / `toVenueId(family, unified)`；**miss 不回退后缀 hack、不透传 raw id**：命令 `toVenueId` miss 抛 typed `SymbolMappingError`；入站 `toUnified` miss 走 quarantine→refresh→replay→(仍 miss 才 drop) + immediate reconcile（详见 miss 安全 AC）。
- **私有适配器**：删 `normalizeUmSymbol`/`encodeUmSymbol`（255-272），改查 catalog（UM 即 `family="usdm"`，硬编码对本范围成立，见 private-adapter.ts:714/840）。预热点：所有 async REST 命令入口（create/cancel/cancelAll/fetchOrder/bootstrapOpenOrders，441/503/869/898/941/964）+ **账户入口**（bootstrapAccount/refreshAccount/reconcileAccount，经 `mapUmPosition` 归一化 position symbol，756/798）先 `await ensureLoaded("usdm")`；私有流预热须在 `createSession()`/socket open **之前**（`createPrivateStream` 同步返 handle，故在建连前 await）。`mapOrderUpdate`(611)/`ACCOUNT_UPDATE`(548) 等 WS 同步热路径只 lookup。

### Commit 2（C2 per-venue 配置）

- 新公开类型（删旧 `account.binance` + `account.juplend`，统一进 `venues`）：
  ```ts
  interface BinanceAccountRuntimeOptions {
    riskPollIntervalMs?: number;
    privateReconcileIntervalMs?: number;   // 0 = 关闭周期 reconcile
    privateStreamStaleAfterMs?: number;    // 私有流 freshness 超时(非调度 interval)
    listenKeyKeepAliveMs?: number;         // Binance 专属,从顶层迁入
  }
  interface JuplendAccountRuntimeOptions {
    pollIntervalMs?: number;
    rpcUrl?: string;
    jupApiKey?: string;
  }
  interface AccountRuntimeOptions {
    streamOpenTimeoutMs?: number;          // 跨 venue 私有流传输默认,留顶层
    streamReconnectDelayMs?: number;
    streamReconnectMaxDelayMs?: number;
    venues?: {                             // 异构 per-venue
      binance?: BinanceAccountRuntimeOptions;
      juplend?: JuplendAccountRuntimeOptions;
      // okx?/bybit?/gate? 后续
    };
  }
  ```
- 协调器（coordinator.ts:98-142、调度循环 585/687）：扁平私有字段改按 `options.venues?.[record.venue]` 取值 + per-venue 默认；**周期 reconcile/riskPoll 调度 gate 在该 venue 定义了对应 interval（或具备 capability）**——Juplend 只走 adapter polling、不吃 Binance reconcile 默认（coordinator:588 现为泛化调度，需收紧）。runtime juplend 构造点（runtime.ts:178-184）改读 `account.venues.juplend.*`；按 grep-gate 删旧引用 + 迁移夹具/文档/live 脚本。

### Commit 3（C4 应用层心跳，研究已落地）

- 接口（`VenueStreamProtocol` 加可选）：
  ```ts
  interface VenueHeartbeat {
    intervalMs: number;
    mode?: "fixed-interval" | "idle-timeout";  // 默认 idle-timeout
    pongTimeoutMs?: number;                     // 发 ping 后超时未 pong → 重连
    frame(): string;                            // 应用层 ping 帧(OKX "ping"/Bybit {"op":"ping"}/Gate futures.ping)
    isPong(raw: string): boolean;               // ⚠Bybit linear pong 的 op 仍是 "ping",须匹配 ret_msg==="pong"
    countAnyInboundAsActivity?: boolean;        // 默认 true
  }
  ```
  - **去掉 research 建议的 `transportPingPong` 字段**：协议层 ping/pong（opcode 9/10）由 Bun WebSocket（uWebSockets server `sendPings` + 标准 client 自动回 pong，per RFC6455 §5.5.2）处理，Gate-futures/Binance 据此不需 heartbeat 配置（不设即可），无需建模为接口字段；仅在 adapter-contract spec 文档化此假设（含一个 Bun client 自动 pong 的回归探针）。`frame` 因此只在"需应用层 ping"时出现（heartbeat 存在即必填），解决"frame 必填 vs 不发 ping"冲突。
- **实现放进 `managed-websocket`**（它独有 raw 帧 + watchdog + 重连）：
  - raw message 层（managed-websocket.ts:222-241，现状 `parseMessage` 返 undefined 即丢、不计活性）前置 heartbeat 处理：命中 `isPong` → 消费（不进 parseMessage、清 pong 等待、计活性）；`countAnyInboundAsActivity` 时任意 raw 帧重置 idle。
  - 调度：idle-timeout（空闲 `intervalMs` 才发 `frame()`）/ fixed-interval；`pongTimeoutMs` 到期 → 对 **raw socket 调 `close()`**（复用 :203/:288→:159 现有 close→reconnect 路径，**非** session 级 `close()`，后者置 `closed=true` 禁重连），重连后 multiplexer replay 订阅。
  - **timer 生命周期**（managed-websocket 现仅清 initial/stale/reconnect，:99/:270）：idle/pong timer 纳入 `clearTimers`、close-event 与重连前全清；timer callback 校验 `activeSocket===socket`；`readyWhen:"message"` 下 pong **不得**清 initialMessageTimeout；pending pong 未结清不重复发 ping。

## Decision (ADR-lite)

- **MVP 边界**：全做 C3+C2+C4+内部 registry；C1 公开第三方 SPI 排除（YAGNI，待真实需求）。均内部改动无 semver 债。
- **C3 映射来源**：共享 catalog 注入（单一来源），根治"两份目录漂移"，零重复 REST。family-scoped 加载/查找以隔离 UM 与 spot/coinm 故障 + 防同名串。
- **C3 miss/错误通道**：miss 不透传 raw id（命令抛 typed `SymbolMappingError` / 入站 quarantine→refresh→replay→仍 miss 才 drop + immediate reconcile，防 order 状态 key 分裂且不丢 trade/fee）；catalog `single-flight` + delivery 合约 bounded tombstone；经注入 `publishRuntimeError` 上报（去重 family+venueId）。
- **C2 兼容**：直接删旧 `account.binance` + `account.juplend`，统一进 `venues`，不留别名（pre-1.0 + 仅自有下游）；迁移以 grep-gate 验收；Juplend 不继承 CEX reconcile/riskPoll 默认。
- **C4 落点**：心跳实现在 managed-websocket（非仅 multiplexer 接口）；复用既有 socket.close→reconnect 路径而非新增公开 API；去掉 `transportPingPong`（协议层 pong 交 ws 库）。
- **交付**：单 PR / 3 commit / 1 minor changeset。

## Decision: 配置统一进 venues（已定）

所有 venue 专属配置统一收进 `account.venues.<venue>`（含 `listenKeyKeepAliveMs` 与整个 juplend 块）；只有真正跨 venue 的私有流传输默认（`streamOpenTimeoutMs`/`streamReconnectDelayMs`/`streamReconnectMaxDelayMs`）留 `account` 顶层。规则：**venue-specific → `venues.<venue>`，generic → 顶层**。注意 `venues` 是**异构 per-venue 类型**（juplend 的 rpcUrl/jupApiKey 与 binance 调度 knob 形状不同），非 `Record<Venue, 同一类型>`。

## Out of Scope

- C1 公开第三方 adapter SPI 导出（YAGNI，待真实需求；本任务只内部 registry）。
- 实际接入 OKX/Bybit/Gate 任一 venue。
- 私有链路 CM/spot 符号归一的**实现**（仅留 family-scoped 扩展点）。
- C4 协议层 ping/pong 的手动处理（交 ws 库）；B8 双连接冗余热备。

## Technical Notes

- 关键文件：`src/client/runtime.ts`、`src/client/private-subscription-coordinator.ts`、`src/adapters/binance/private-adapter.ts`、`src/adapters/binance/market-catalog.ts`、`src/adapters/binance/adapter.ts`、`src/internal/subscription-multiplexer.ts`、`src/internal/managed-websocket.ts`、`src/types/shared.ts`、`src/adapters/types.ts`。
- 已核实事实：版本 `0.4.0-beta.20`；`SUPPORTED_VENUES` 已声明 okx/bybit/gate；`loadBinanceMarkets` 为 `Promise.all` 全挂（304）；managed-websocket `close()` 置 `closed` 禁重连（303）、`parseMessage` 返 undefined 即丢不计活性（239）、watchdog `onStale` 只通知不重连（149-156）；当前公开配置是 `account.binance.{risk/reconcile/stale}`（shared.ts:292），coordinator 内部才是扁平私有字段；公开 `AcexErrorCode`（errors.ts:4）无 symbol-mapping code——实现期定（新增 public `SYMBOL_MAPPING_FAILED` 或内部 `SymbolMappingError`）并补测试。
- 迁移面（C2，grep-gate）：`rg 'account\.binance|account\.juplend|listenKeyKeepAliveMs'` 实测 11 文件、约 60+ 处（src/coordinator、README:63、docs/api.md:109/242/636、scripts/live-order-smoke.ts、scripts/live-juplend-account-smoke.ts、tests/unit/private-subscription-coordinator.test.ts、tests/integration/{account,order}.test.ts、src/types/shared.ts、src/adapters/types.ts、src/adapters/binance/private-adapter.ts）。
- 来源：docs/improvement-todo.md 批次⑧（C1+C2+C3+C4）；C5 已完成。

## Research References

- [`research/venue-heartbeat-protocols.md`](research/venue-heartbeat-protocols.md) — OKX/Bybit/Gate 客户端心跳协议（codex 调研）。结论：三字段不够，须连接级保活；OKX 文本 ping/pong + idle(<30s)；Bybit JSON 固定 20s、**linear pong 的 op 仍是 "ping"**；Gate-futures 靠协议层 server-ping/client-pong（ws 库自动）。
