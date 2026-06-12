结论：`VenueHeartbeat { intervalMs, frame(), isPong(msg) }` 可以表达 OKX、Bybit、Gate 的“应用层文本 ping”帧与 pong 识别，但不足以完整表达调度语义和连接保活策略；建议至少补 `mode`（idle-triggered vs fixed-interval）、`pongTimeoutMs`，并把“任意入站消息是否算活性”和“WebSocket 协议层 ping/pong 是否由库处理”显式化。

| 交易所 | 是否需客户端 ping | ping 帧格式 | 间隔 | 服务端空闲阈值 | pong 形态 | 任意消息是否重置空闲 |
|---|---|---|---|---|---|---|
| OKX | 需要在无入站消息时主动发应用层 ping | 纯文本字符串 `ping`，不是 JSON；不需要时间戳/req_id | 文档要求定时器 `N < 30s`；无消息达到 N 秒才发 | 订阅未建立或超过 30s 没有数据推送会断开 | 纯文本字符串 `pong` | 是。文档明确说每次收到 response message 都重设 N 秒定时器 |
| Bybit | 官方“推荐”每 20s 发 heartbeat；SDK 应按需主动发 | JSON 文本帧 `{"op":"ping"}`；`req_id` 可选 | 推荐每 20s | 默认：无 ping-pong 且无服务端 stream data 时 10 分钟断开；private/order entry 可用 `max_active_time=30s..600s` 配置 | USDT 永续 Linear/Inverse 公有流：`{"success":true,"ret_msg":"pong","conn_id":"...","req_id":"","op":"ping"}`；Spot 类似但可无 `req_id`；Option/Spread 是 `{"op":"pong","args":[...]}` | 是。文档明确用“no ping-pong and no stream data”和“last update or ping-pong”描述活性 |
| Gate.io Futures | 不强制应用层客户端 ping；服务端使用 WebSocket 协议层 ping，客户端必须 pong（通常由 ws 库自动处理）。应用层 `futures.ping` 只用于主动探测 | 可选应用层 JSON 文本帧 `{"time": <unix seconds>, "channel": "futures.ping"}`；可带通用 `id`，但 ping 示例不需要 | Futures 文档未给强制应用层间隔；示例 app 使用 `run_forever(ping_interval=5)`，但不是应用层规范要求 | Futures 文档未给具体秒数；只说服务端协议层 ping 若客户端不回复会断开 | 可选应用层 pong：`{"time":...,"time_ms":...,"channel":"futures.pong","event":"","result":null}` | Futures 文档未说明任意消息重置；Spot 文档明确 `spot.ping` 会重置客户端 timeout timer，但这不是 Futures 文档要求 |

## OKX

官方文档链接：[OKX API v5 - WebSocket Connect](https://www.okx.com/docs-v5/en/#overview-websocket-connect)

文档明确写了：

- 连接断开条件：订阅未建立，或“data has not been pushed for more than 30 seconds”。
- 保活算法：收到 response message 时设置 `N < 30` 秒定时器；定时器触发表示 N 秒内没有新消息，此时发送字符串 `ping`。
- pong：期待收到 `pong`；如果 N 秒内没有 pong，应报错或重连。

关键引述（短摘）：`N is less than 30`、`send the String 'ping'`、`Expect a 'pong'`。

关键影响：

- OKX 是应用层纯文本 ping/pong，不能发送 JSON，例如 `{"op":"ping"}`。
- OKX 的调度不是“严格每 N 秒发一次”，而是“收到任意 response message 后重置 idle timer；只有连接空闲时才发 ping”。
- `frame(): string` 足够表达 `ping`；`isPong(msg)` 应精确匹配文本 `pong`。
- `intervalMs` 如果被 multiplexer 实现成固定间隔，会与 OKX 文档建议不完全一致；应支持 idle-triggered。

## Bybit

官方文档链接：[Bybit V5 WebSocket - Connect](https://bybit-exchange.github.io/docs/v5/ws/connect)

文档明确写了：

- 公有 USDT/USDC perpetual 与 USDT Futures endpoint 是 `wss://stream.bybit.com/v5/public/linear`。
- 心跳发送示例：`ws.send(JSON.stringify({"req_id": "100001", "op": "ping"}));`，其中 `req_id` 是自定义且可选。
- Linear/Inverse 公有流 pong 示例包含 `success: true`、`ret_msg: "pong"`、`req_id`、`op: "ping"`。
- 文档建议每 20 秒发送 `ping` heartbeat packet。
- 连接活性描述：如果没有 ping-pong 且服务端没有 stream data，连接一般会在 10 分钟后断开；文档还用“last update or ping-pong”说明扫描断开时间。

关键引述（短摘）：`req_id is a customised ID, which is optional`、`ret_msg": "pong"`、`every 20 seconds`。

关键影响：

- Bybit 对 Linear/Inverse（USDT 永续优先目标）应发送 JSON 文本帧，最小可为 `{"op":"ping"}`；`req_id` 不必强制生成。
- `isPong(msg)` 对 Linear/Inverse 应匹配 JSON：`success === true && ret_msg === "pong" && op === "ping"`；不要只匹配 `op === "pong"`，因为 Linear/Inverse 公有流 pong 示例的 `op` 仍是 `ping`。
- Bybit Spot pong 形态与 Linear/Inverse 接近，但可能没有 `req_id`；Option/Spread pong 形态不同，是 `op: "pong"` 加 `args`。如果未来统一覆盖全部产品，`isPong` 需要按 endpoint/product family 分支。
- Bybit 的 `req_id` 对心跳不是必需；即使用动态 req_id，`frame()` 和闭包状态也能表达，不要求额外字段。

## Gate.io

官方文档链接：

- [Gate Futures WebSocket v4.0.0 - Ping and Pong](https://www.gate.com/docs/developers/futures/ws/en/)
- [Gate Spot WebSocket v4.0.0 - Application ping pong](https://www.gate.com/docs/developers/apiv4/ws/en/)

Futures 文档明确写了：

- Gate futures 使用 WebSocket 协议层 ping/pong；服务端主动发 ping，如果客户端不回复会断开。
- 如果客户端想主动检测连接状态，可以发送应用层 ping 并接收 pong。
- 应用层 futures ping 示例：`{"time": 123456, "channel": "futures.ping"}`。
- 应用层 pong 示例：`channel` 为 `futures.pong`，`event` 为空字符串，`result` 为 `null`，并带 `time` / `time_ms`。
- 通用请求格式包含可选 `id`，服务器会回传用于识别响应；但 futures ping 示例没有使用 `id`。

关键引述（短摘）：`protocol layer ping/pong message`、`application layer ping message`、`futures.pong`。

Spot 文档明确写了：

- `spot.ping` 是额外的连接可达性检查，服务端使用协议层 ping/pong 检查客户端是否连接，并“不强制”使用应用层 ping。
- 知名 WebSocket 客户端库通常不需要关心这个 API。
- 服务端收到客户端 `spot.ping` 会重置客户端 timeout timer。
- Spot 应用层 ping/pong 分别是 `spot.ping` / `spot.pong`，格式与 futures 类似。

关键影响：

- 对 Gate Futures 公有行情流，真正必须满足的是协议层 pong；这通常应交给 WebSocket 库，而不是 `VenueHeartbeat.frame(): string`。
- `futures.ping` 可以作为主动探测，但官方 futures 文档没有给强制发送间隔，也没有明确说任意行情消息会重置应用层 timeout。
- 如果 SDK 要对 Gate 实现主动文本心跳，`frame()` 可生成 `JSON.stringify({ time: Math.floor(Date.now()/1000), channel: "futures.ping" })`，`isPong` 匹配 `channel === "futures.pong"` 即可。
- Gate 的坑是不要把应用层 ping 当作唯一必需保活；协议层 ping/pong 才是 futures 文档里的断开条件。

## 对我们钩子形状的影响

### 够用的部分

当前三字段对“应用层文本 ping”本身够用：

- OKX：`intervalMs = 25000`（或其他 `< 30000`）、`frame() => "ping"`、`isPong(msg) => msg === "pong"`。
- Bybit Linear/Inverse：`intervalMs = 20000`、`frame() => JSON.stringify({ op: "ping" })`，或加可选 `req_id`；`isPong` 解析 JSON 后匹配 `ret_msg === "pong" && op === "ping"`。
- Gate Futures 主动探测：`frame()` 可以动态带秒级 `time`，`isPong` 解析 `channel === "futures.pong"`。`frame()` 是函数这一点足够支持时间戳。

`req_id`/`id` 不需要变成通用字段：Bybit `req_id` 是可选；Gate 通用 `id` 也是可选。若未来希望关联心跳请求与 pong，具体 venue heartbeat 实例可以用闭包保存 last id，但这不是 OKX/Bybit/Gate 公有行情的必需能力。

### 不够用的部分

当前形状不足以完整表达官方文档里的调度和断线判断：

- 缺少调度模式。OKX 明确是 idle-triggered：任意 response message 重置定时器，空闲 N 秒才发 `ping`。Bybit 推荐固定 20 秒，但也明确 stream data 算连接活性。单个 `intervalMs` 无法区分“固定间隔发”与“空闲超过 interval 才发”。
- 缺少 `pongTimeoutMs`。OKX 明确要求发出 `ping` 后 N 秒内没有 `pong` 就报错或重连；只靠 `isPong` 无法表达等待窗口。
- 缺少入站活性策略。OKX/Bybit 文档都把普通消息作为活性来源；Gate Futures 主要是协议层 ping/pong，Spot 文档只明确 `spot.ping` 会重置 timeout。multiplexer 需要知道“任意消息是否刷新心跳/连接活性”。
- 缺少协议层 ping/pong 建模。Gate Futures 与 Binance 公有流都依赖 WebSocket 协议层 ping/pong；如果 ws 库不会自动 pong，三字段文本帧接口无法表达 opcode 10 pong。即便当前库自动处理，也应在协议配置里明确 `transportPingPong: "auto"` 或类似语义，避免把 Gate 错接成必须应用层 ping。

### 建议修订

建议把心跳配置从单一文本 ping 钩子扩成连接级保活策略，例如：

```ts
interface VenueHeartbeat {
  intervalMs: number;
  mode?: "fixed-interval" | "idle-timeout";
  pongTimeoutMs?: number;
  frame(): string;
  isPong(msg: string): boolean;
  countAnyInboundAsActivity?: boolean;
  transportPingPong?: "auto" | "manual" | "none";
}
```

推荐默认：

- OKX：`mode: "idle-timeout"`，`intervalMs < 30000`，`pongTimeoutMs` 同 N 或略小，`countAnyInboundAsActivity: true`，应用层 text ping。
- Bybit Linear/Inverse：`mode: "fixed-interval"`，`intervalMs: 20000`，`countAnyInboundAsActivity: true`，应用层 JSON ping；也可接受 idle watchdog 但应仍按 20s 发 heartbeat。
- Gate Futures：不配置应用层 heartbeat，或仅作为可选 active probe；必须确认底层 ws 库自动响应协议层 ping，配置 `transportPingPong: "auto"`。如果启用应用层探测，使用 `futures.ping` / `futures.pong`，但不要把它当官方强制保活。

区分文档与推断：

- 文档明确：OKX idle timer + `ping`/`pong` 文本、Bybit 20s JSON heartbeat 与 Linear/Inverse pong 形态、Gate Futures 协议层 server ping/client pong 与可选 `futures.ping`。
- 社区/SDK 经验推断：Gate 应用层 ping 的固定间隔、Gate Futures 任意行情消息是否重置 timeout、以及是否必须用应用层 ping 保活；这些不能作为通用层硬编码依据。
