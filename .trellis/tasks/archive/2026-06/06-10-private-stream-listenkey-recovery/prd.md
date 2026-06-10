# P0-3 private stream listenKey recovery

## Goal

修复 Binance PAPI 私有数据流在 listenKey 失效或长时间无消息时静默死亡的问题。目标是让 SDK 在 `listenKeyExpired`、listenKey keepalive 失败、私有 WS 静默三类场景下主动恢复实时账户/订单流，并通过 reconnect 触发既有 reconcile，避免订单/账户状态只退化到 60s REST 对账而无明确恢复动作。

## What I Already Know

* `docs/improvement-todo.md` 将该问题列为 P0-3，P0-1/P0-2 已完成。
* 当前 `src/adapters/binance/private-adapter.ts` 的 `parsePrivateMessage()` 只放行 `ACCOUNT_UPDATE` / `ORDER_TRADE_UPDATE`，`listenKeyExpired` 会被丢弃。
* 当前 `createPrivateStream()` 获取一次 listenKey 后，把 URL 固定传给 `createManagedWebSocket()`；普通 reconnect 会复用旧 listenKey URL。
* 当前 listenKey keepalive 定时器失败后只调用 `callbacks.onError()`，不会重建 listenKey 或重建 WS。
* `src/internal/managed-websocket.ts` 已支持 `messageWatchdog`，但 Binance private stream 未配置。
* `PrivateSubscriptionCoordinator` 已在 `onReconnected()` 后触发 account/order reconcile，本任务应复用该路径，不在 adapter 内重复做领域对账。

## Requirements

* `parsePrivateMessage()` 必须识别并放行 Binance 私有流 `listenKeyExpired` 事件；未知 event 仍按现有 contract 跳过。
* 收到 `listenKeyExpired` 后，Binance private adapter 必须轮换 listenKey，并用新 listenKey URL 建立新的 WS。
* listenKey keepalive（PUT）重试耗尽后必须走同一套 listenKey 轮换 / WS 重建路径，并向上层上报错误原因。
* Binance private stream 必须配置连接级 `messageWatchdog`。长时间没有任何有效私有消息时，必须上报 `heartbeat_timeout` 语义并主动进入重建路径。
* listenKey 轮换必须关闭旧 WS，并尽力关闭旧 listenKey；旧资源清理失败只上报错误，不阻断新 listenKey 建立。
* 重建成功后必须触发既有 `callbacks.onReconnected()`，让 `PrivateSubscriptionCoordinator` 执行 account/order reconcile。
* `close()` 必须保持幂等，关闭后不得再触发新 listenKey 请求、WS 重连或 keepalive。
* 不改变 public 方法签名、订单/账户事件模型、REST 命令语义；允许新增可选 runtime 调优项控制私有流 watchdog 阈值。

## Acceptance Criteria

* [x] fake WS 推送 `listenKeyExpired` 后，adapter 发起新的 `POST /papi/v1/listenKey`，建立新 WS URL，并触发 reconnect/reconcile 路径。
* [x] fake keepalive `PUT /papi/v1/listenKey` 失败后，adapter 发起新的 listenKey 并重建 WS；错误被上报但 stream 不静默死亡。
* [x] 私有流超过 watchdog 静默阈值后，adapter 主动重建 listenKey/WS，并向上层暴露 `heartbeat_timeout` 相关状态或错误。
* [x] 旧 listenKey 在轮换或 close 时被尽力 `DELETE`。
* [x] 现有账户与订单私有流集成测试继续通过。
* [x] `bun run lint`、`bun run type-check`、`bun run test` 通过。

## Technical Approach

采用 adapter 内部的统一恢复函数：

* 扩展 Binance private message union，增加 `listenKeyExpired` 消息类型与类型守卫。
* 在 `createPrivateStream()` 中将“启动 listenKey + 启动 WS + 启动 keepalive”封装为可重复执行的 private stream session。
* `listenKeyExpired`、keepalive 失败、watchdog stale 三个入口调用同一条恢复路径：标记当前 session 失效，关闭当前 WS，清理 keepalive，关闭旧 listenKey，重新 `POST listenKey`，用新 URL 建 WS。
* 为避免重复恢复，恢复过程需要有 in-flight guard；关闭后的异步恢复结果必须被丢弃。
* Watchdog 阈值按长周期默认值接入（默认 65 分钟），并通过 `account.binance.privateStreamStaleAfterMs` 暴露可选 runtime 调优入口，避免测试和特殊运行环境等待长时间。Binance private user data stream 是事件驱动的，不能把 5 分钟无账户/订单消息当作默认 stale。

## Decision (ADR-lite)

**Context**: 私有流的 listenKey 生命周期是 Binance adapter 细节；上层 coordinator 只负责订阅状态、reconcile 与 public runtime status。

**Decision**: 在 `BinancePrivateAdapter.createPrivateStream()` 内部处理 listenKey 轮换，不扩展 public `PrivateStreamOptions` 或 coordinator contract。本任务只用 `onReconnected()` 通知上层恢复完成。

**Consequences**: Binance 相关恢复逻辑留在 adapter 层，符合现有 layer contract；未来其他交易所如有 token/session 轮换，可在各自 adapter 中实现相同 `StreamHandle` 语义。

## Out of Scope

* 不改 public 方法签名或事件模型。
* 不改 `PrivateSubscriptionCoordinator` 的 reconcile 语义。
* 不新增真实 live 凭证依赖测试；live soak 只保留为人工验证建议。
* 不处理 P1-A/P1-B 中的幽灵订单驱逐、pending claim TTL、事件背压等后续项。

## Technical Notes

* 主要实现文件：`src/adapters/binance/private-adapter.ts`。
* 可能涉及底层能力：`src/internal/managed-websocket.ts`，目前已有 `messageWatchdog` 和 reconnect 机制。
* 主要测试入口：`tests/integration/account.test.ts`、`tests/integration/order.test.ts`、`tests/support/exchanges/binance.ts`。
* 相关规范：`.trellis/spec/backend/adapter-contract.md`、`.trellis/spec/backend/order-execution.md`、`.trellis/spec/backend/quality-guidelines.md`。
