# P2-4 observability context survey

范围：只读调查 `src/` 当前实现，用于规划最小 `onMetric` hook 与延迟打点。未修改源码。

## 1. logger/logLevel 预留位

结论：`logger` / `logLevel` 只在 public type 中声明，未在 runtime、managers、adapters、internal 中读取或使用。它们是纯占位；`logger` / `logLevel` 自身没有注释，附近只有 `clock` 的注释。

检索命令：`rg -n "logger|logLevel|LogLevel" src`

命中：

```ts
// src/types/shared.ts:18-25
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

// src/types/shared.ts:316-327
export interface CreateClientOptions {
  sandbox?: boolean;
  /** Request/signing clock override; local receivedAt/freshness clocks stay independent. */
  clock?: TimeProvider;
  rateLimiter?: RateLimiter;
  rateLimit?: RateLimitOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  market?: MarketRuntimeOptions;
  account?: AccountRuntimeOptions;
  order?: OrderRuntimeOptions;
}
```

## 2. CreateClientOptions 与 hook 注入路径

### Public options 类型全量摘录

```ts
// src/types/shared.ts:18-32
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

export interface TimeProvider {
  /** Millisecond timestamp used for outbound request/signing timestamps. */
  now(): number;
  /** Optional signal that a venue rejected the timestamp and the clock should resync. */
  requestResync?(): void;
}

// src/types/shared.ts:204-206
export interface RateLimitOptions {
  utilizationTarget?: number;
}

// src/types/shared.ts:240-278
export interface RateLimiter {
  beforeRequest(ctx: RateLimitRequestContext): RateLimitBeforeRequestResult;
  afterResponse(
    ctx: RateLimitRequestContext,
    response: RateLimitResponseContext,
  ): Promise<void> | void;
  onTransportError(
    ctx: RateLimitRequestContext,
    error: RateLimitTransportErrorContext,
  ): Promise<void> | void;
  getSnapshot(scope: RateLimitScope): RateLimitSnapshot | undefined;
}

// src/types/shared.ts:280-314
export interface MarketRuntimeOptions {
  l1InitialMessageTimeoutMs?: number;
  l1StaleAfterMs?: number;
  l1ReconnectDelayMs?: number;
  l1ReconnectMaxDelayMs?: number;
}

export interface BinanceAccountRuntimeOptions {
  riskPollIntervalMs?: number;
  privateReconcileIntervalMs?: number;
  privateStreamStaleAfterMs?: number;
  listenKeyKeepAliveMs?: number;
}

export interface JuplendAccountRuntimeOptions {
  pollIntervalMs?: number;
  rpcUrl?: string;
  jupApiKey?: string;
}

export interface AccountRuntimeOptions {
  streamOpenTimeoutMs?: number;
  streamReconnectDelayMs?: number;
  streamReconnectMaxDelayMs?: number;
  venues?: {
    binance?: BinanceAccountRuntimeOptions;
    juplend?: JuplendAccountRuntimeOptions;
  };
}

export interface OrderRuntimeOptions {
  maxClosedOrdersPerSymbol?: number;
  missingOrderEvictionThreshold?: number;
  pendingClaimTtlMs?: number;
}

// src/types/shared.ts:316-327
export interface CreateClientOptions {
  sandbox?: boolean;
  /** Request/signing clock override; local receivedAt/freshness clocks stay independent. */
  clock?: TimeProvider;
  rateLimiter?: RateLimiter;
  rateLimit?: RateLimitOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  market?: MarketRuntimeOptions;
  account?: AccountRuntimeOptions;
  order?: OrderRuntimeOptions;
}
```

备注：`CreateClientOptions` 没有 public `adapters` 选项。adapter 注入由 runtime 内部 factory 完成。

### `options.clock` 当前流向

入口：

```ts
// src/client/create-client.ts:4-5
export function createClient(options?: CreateClientOptions): AcexClient {
  return new AcexClientImpl(options);
}
```

runtime 构造期装配：

```ts
// src/client/runtime.ts:271-285
constructor(options: CreateClientOptions = {}) {
  const rateLimiter =
    options.rateLimiter ??
    new ReactiveRateLimiter({
      utilizationTarget: options.rateLimit?.utilizationTarget,
    });
  const adapterGroups = createVenueAdapterGroups(
    {
      rateLimiter,
      signingClock: options.clock,
      publishRuntimeError: this.publishRuntimeError.bind(this),
    },
    options.account?.venues,
  );
```

adapter factory deps：

```ts
// src/client/runtime.ts:82-90
interface VenueAdapterFactoryDeps {
  readonly rateLimiter: RateLimiter;
  readonly signingClock?: TimeProvider;
  readonly publishRuntimeError: (
    source: AcexInternalError["source"],
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ) => void;
}
```

Binance adapter group：

```ts
// src/client/runtime.ts:143-185
function createBinanceAdapterGroup(
  deps: VenueAdapterFactoryDeps,
): VenueAdapterFactoryResult {
  const marketCatalog = new BinanceMarketCatalog({
    rateLimiter: deps.rateLimiter,
    publishRuntimeError: deps.publishRuntimeError,
  });
  const signingTimeProvider = deps.signingClock
    ? undefined
    : new SyncingTimeProvider({ ... });
  const signingClock = deps.signingClock ?? signingTimeProvider;

  return {
    marketAdapter: new BinanceMarketAdapter({
      rateLimiter: deps.rateLimiter,
      marketCatalog,
    }),
    privateAdapter: new BinancePrivateAdapter({
      signingClock,
      rateLimiter: deps.rateLimiter,
      marketCatalog,
    }),
    lifecycle: signingTimeProvider ? { ... } : undefined,
  };
}
```

Binance private adapter 使用 signing clock：

```ts
// src/adapters/binance/private-adapter.ts:948-955
constructor(
  private readonly options: {
    readonly fetchFn?: FetchLike;
    readonly httpTimeoutMs?: number;
    readonly signingClock?: TimeProvider;
    readonly rateLimiter?: RateLimiter;
    readonly marketCatalog?: BinanceMarketCatalog;
  } = {},
) { ... }

// src/adapters/binance/private-adapter.ts:1862-1868
params.set(
  "timestamp",
  `${
    getNumberOption(accountOptions, "timestamp") ??
    this.options.signingClock?.now() ??
    Date.now()
  }`,
);
```

### Managers/adapters 的 callbacks/hook 形态

当前没有用户通过 `CreateClientOptions` 注入的 callback。对用户开放的是 AsyncIterable 事件流：

```ts
// src/types/client.ts:57-65
export interface ClientEventStreams {
  health(
    filter?: HealthEventFilter,
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<HealthEvent>;
  errors(
    options?: BufferedEventStreamOptions,
  ): AsyncIterable<AcexInternalError>;
}
```

内部 stream callback 模式：

```ts
// src/adapters/types.ts:138-146
export interface L1BookStreamCallbacks {
  onUpdate(update: RawL1BookUpdate): void;
  onFreshnessChange(
    freshness: "fresh" | "stale",
    reason?: "heartbeat_timeout",
  ): void;
  onDisconnected(): void;
  onError(error: Error): void;
}

// src/adapters/types.ts:337-347
export interface PrivateStreamCallbacks {
  onAccountSnapshot(snapshot: RawAccountBootstrap): void;
  onAccountUpdate(update: RawAccountUpdate): void;
  onRiskLevelChange(event: RawRiskLevelChange): void;
  onOrderUpdate(update: RawOrderUpdate): void;
  onFreshnessChange(freshness: "stale", reason: "heartbeat_timeout"): void;
  onDisconnected(): void;
  onReconnected(): void;
  requestReconcile?(reason: "symbol_mapping_miss"): void;
  onError(error: Error): void;
}
```

Market manager 组装 callbacks 传给 adapter：

```ts
// src/managers/market-manager.ts:917-970
const callbacks: L1BookStreamCallbacks = {
  onUpdate: (update: RawL1BookUpdate) => { ... },
  onFreshnessChange: (freshness, reason) => {
    this.updateConnectionState(record, "l1Book", freshness, reason);
  },
  onDisconnected: () => { ... },
  onError: (error) => {
    this.context.publishRuntimeError("runtime", error, {
      venue: record.venue,
      symbol: record.symbol,
    });
  },
};

return this.getMarketAdapter(market.venue).createL1BookStream(
  market,
  callbacks,
  options,
);
```

PrivateSubscriptionCoordinator 组装 callbacks 传给 private adapter：

```ts
// src/client/private-subscription-coordinator.ts:1327-1458
const stream = adapter.createPrivateStream(
  credentials ?? {},
  {
    onAccountUpdate: (update) => {
      this.accountConsumer.onPrivateAccountUpdate(
        record.accountId,
        record.venue,
        update,
      );
    },
    onOrderUpdate: (update) => {
      this.orderConsumer.onPrivateOrderUpdate(
        record.accountId,
        record.venue,
        update,
      );
    },
    onReconnected: () => {
      this.requestImmediateReconcile(record);
    },
    onError: (error) => {
      this.context.publishRuntimeError("adapter", error, {
        accountId: record.accountId,
        venue: record.venue,
      });
    },
  },
  {
    openTimeoutMs: this.streamOpenTimeoutMs,
    reconnectDelayMs: this.streamReconnectDelayMs,
    reconnectMaxDelayMs: this.streamReconnectMaxDelayMs,
    listenKeyKeepAliveMs: this.getListenKeyKeepAliveMs(record),
    staleAfterMs: this.getPrivateStreamStaleAfterMs(record),
    now: () => this.context.now(),
  },
  { ...account.options, accountId: account.accountId },
);
```

内部 observability callback 的异常隔离先例：

```ts
// src/internal/syncing-time-provider.ts:40-54
export interface SyncingTimeProviderOptions {
  readonly onResync?: (event: SyncingTimeProviderResyncEvent) => void;
  readonly onSampleFailed?: (
    event: SyncingTimeProviderSampleFailedEvent,
  ) => void;
  readonly onDriftWarning?: (
    event: SyncingTimeProviderDriftWarningEvent,
  ) => void;
}

// src/internal/syncing-time-provider.ts:380-405
private notifyResync(event: SyncingTimeProviderResyncEvent): void {
  try {
    this.options.onResync?.(event);
  } catch {
    // Observability callbacks must not break clock updates.
  }
}
```

设计含义：`onMetric` 如果经 `CreateClientOptions` 注入，manager 侧最像 `publishRuntimeError` / `publishHealthEvent`，应走 `ClientContext`；adapter 侧如果也要打点，需要在 adapter factory deps/constructor options 增加 emitter，类似 `publishRuntimeError` 和 `rateLimiter`。

## 3. ClientContext 接口

当前 manager 能访问的 client-level capabilities：

```ts
// src/client/context.ts:30-53
export interface ClientContext {
  now(): number;
  assertStarted(): void;
  getRegisteredAccount(accountId: string): RegisteredAccountRecord;
  getPrivateOrderCapabilities(venue: Venue): VenueOrderCapabilities | undefined;
  normalizeVenueErrorCode(
    venue: Venue,
    code: string,
  ): VenueErrorReason | undefined;
  ensurePrivateCredentials(accountId: string): void;
  subscribePrivateAccountFeed(accountId: string): Promise<void>;
  unsubscribePrivateAccountFeed(accountId: string): void;
  subscribePrivateOrderFeed(accountId: string): Promise<void>;
  unsubscribePrivateOrderFeed(accountId: string): void;
  createOrder(input: CreateOrderInput): Promise<RawOrderUpdate>;
  cancelOrder(input: CancelOrderInput): Promise<RawOrderUpdate>;
  cancelAllOrders(input: CancelAllOrdersInput): Promise<RawOrderUpdate[]>;
  publishRuntimeError(
    source: AcexInternalError["source"],
    error: Error,
    metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
  ): void;
  publishHealthEvent(event: HealthEvent): void;
}
```

建议位置：给 `ClientContext` 增加 `emitMetric(...)` 或 `publishMetric(...)`，让 `MarketManagerImpl`、`AccountManagerImpl`、`OrderManagerImpl`、`PrivateSubscriptionCoordinator` 不直接持有 options。

## 4. 打点候选位置与现有时间数据

### 4.1 下单 RTT

用户 API 层发起点在 `OrderManagerImpl`，已经有 `requestStartedAt`：

```ts
// src/managers/order-manager.ts:235-241
const requestStartedAt = this.context.now();
const update = await this.context.createOrder(commandInput);
const snapshot = this.applyCommandUpdate(
  input.accountId,
  account.venue,
  update,
  { localOrderId, requestStartedAt },
);

// src/managers/order-manager.ts:288-296
const requestStartedAt = this.context.now();
const update = await this.context.cancelOrder(input);
const snapshot = this.applyCommandUpdate(..., {
  requestStartedAt,
});

// src/managers/order-manager.ts:331-339
const requestStartedAt = this.context.now();
const updates = await this.context.cancelAllOrders(input);
const snapshots = this.applyCommandUpdates(..., {
  requestStartedAt,
});
```

runtime 命令发往 adapter，并由 `trackOrderCommand` 做 in-flight 登记：

```ts
// src/client/runtime.ts:549-570
createOrder(input: CreateOrderInput): Promise<RawOrderUpdate> {
  this.assertStarted();
  const account = this.getPrivateCommandAccount(input.accountId);
  const request: CreateOrderRequest = { ... };

  return this.trackOrderCommand(
    this.getPrivateAdapter(account.venue).createOrder(
      account.credentials ?? {},
      request,
      { ...account.options, accountId: account.accountId },
    ),
  );
}

// src/client/runtime.ts:573-604
cancelOrder(...) { ... return this.trackOrderCommand(adapter.cancelOrder(...)); }
cancelAllOrders(...) { ... return this.trackOrderCommand(adapter.cancelAllOrders(...)); }

// src/client/runtime.ts:639-645
private trackOrderCommand<T>(promise: Promise<T>): Promise<T> {
  const tracked = promise.finally(() => {
    this.inFlightOrderCommands.delete(tracked);
  });
  this.inFlightOrderCommands.add(tracked);
  return tracked;
}
```

重要细节：runtime 的 `trackOrderCommand` 当前没有 start timestamp，只登记 Promise。`requestStartedAt` 在 manager 中。

回包处与 `receivedAt` 坑点：

```ts
// src/adapters/binance/private-adapter.ts:1110-1147
async createOrder(...): Promise<RawOrderUpdate> {
  const receivedAt = Date.now();
  const symbol = await this.toUsdmVenueIdForCommand(request.symbol);
  const response = await this.signedRequest<BinancePapiOpenOrder>(...);

  const mapped = await this.mapOpenOrderWithCatalogRefresh(
    response,
    receivedAt,
  );
  ...
}

// src/adapters/binance/private-adapter.ts:1157-1180
async cancelOrder(...): Promise<RawOrderUpdate> {
  const receivedAt = Date.now();
  const symbol = await this.toUsdmVenueIdForCommand(request.symbol);
  const response = await this.signedRequest<BinancePapiOpenOrder>(...);
  const mapped = await this.mapOpenOrderWithCatalogRefresh(
    response,
    receivedAt,
  );
}

// src/adapters/binance/private-adapter.ts:1191-1236
async cancelAllOrders(...): Promise<RawOrderUpdate[]> {
  const symbol = await this.toUsdmVenueIdForCommand(request.symbol);
  const openOrders = await this.signedRequest<BinancePapiOpenOrder[]>(...);
  const response = await this.signedRequest<BinancePapiCancelAllResponse>(...);
  ...
  const receivedAt = Date.now();
  const mappedOrders = await this.mapOpenOrdersWithCatalogRefresh(
    openOrders,
    receivedAt,
  );
}
```

`createOrder` / `cancelOrder` 的 `receivedAt` 在 HTTP 请求前采样，不是响应收到时间；不能用 `update.receivedAt - requestStartedAt` 当准确 RTT。`cancelAllOrders` 的 synthesized updates 在 DELETE response 后采 `receivedAt`，但 open orders 来源是前置 GET。最稳妥的 RTT 打点点位是 `OrderManagerImpl` 中 `await this.context.*` 前后包一层时间，或者增强 runtime `trackOrderCommand` 接收 operation/tags/start time。

`signedRequest` 真正等待 HTTP 的位置：

```ts
// src/adapters/binance/private-adapter.ts:1878-1904
try {
  const response = await httpRequest<T>({
    fetchFn: this.options.fetchFn,
    url,
    method,
    headers: { "X-MBX-APIKEY": apiKey },
    timeoutMs,
    parseAs: "json",
    emptyBody: "empty_object",
    retryPolicy: retryPolicy ?? NO_RETRY_POLICY,
    messages: getBinancePapiHttpMessages(timeoutMs),
  });

  await this.options.rateLimiter?.afterResponse(requestContext, {
    status: response.status,
    headers: response.headers,
    usage: parseBinanceRateLimitUsage(response.headers),
    reservation,
  });
  return response.body;
}
```

### 4.2 WS 消息延迟

Raw update 类型已有 `exchangeTs` + `receivedAt`：

```ts
// src/adapters/types.ts:120-127
export interface RawL1BookUpdate {
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  exchangeTs?: number;
  receivedAt: number;
}

// src/adapters/types.ts:263-269
export interface RawAccountUpdate {
  balances?: RawBalanceUpdate[];
  positions?: RawPositionUpdate[];
  risk?: RawRiskUpdate;
  exchangeTs?: number;
  receivedAt: number;
}

// src/adapters/types.ts:284-302
export interface RawOrderUpdate {
  orderId?: string;
  ...
  exchangeTs?: number;
  receivedAt: number;
  trade?: RawOrderTrade;
}
```

ManagedWebSocket 采集 `receivedAt` 与活性状态：

```ts
// src/internal/managed-websocket.ts:386-428
socket.addEventListener("message", (event) => {
  if (closed || activeSocket !== socket || typeof event.data !== "string") {
    return;
  }

  const raw = event.data;
  const receivedAt = now();
  ...
  parsed = options.parseMessage(raw);
  ...
  noteConnectionActivity(socket, receivedAt, {
    countsAsMessage: true,
    clearInitial: true,
  });
  options.onMessage(parsed, lastMessageAt);
});
```

活性/重连相关点：

```ts
// src/internal/managed-websocket.ts:295-319
const noteConnectionActivity = (...) => {
  if (options.countsAsMessage) {
    hasMessage = true;
  }
  staleNotified = false;
  lastMessageAt = activityAt;
  reconnectAttempts = 0;
  ...
  if (messageWatchdog) {
    scheduleStaleTimeout(socket);
  }
};

// src/internal/managed-websocket.ts:170-186
const scheduleStaleTimeout = (socket: WebSocket) => {
  ...
  staleTimeout = setTimer(() => {
    staleNotified = true;
    messageWatchdog.onStale(now());
  }, messageWatchdog.staleAfterMs);
};
```

Market WS flow：

```ts
// src/internal/subscription-multiplexer.ts:280-287
connection.session = createManagedWebSocket<TMessage>({
  ...
  onMessage: (message, receivedAt) => {
    this.handleMessage(connection, message, receivedAt);
  },
});

// src/internal/subscription-multiplexer.ts:418-466
private handleMessage(..., receivedAt: number): void {
  const routed = this.protocol.routeMessage(message);
  ...
  this.deliverPayload(sub, localSubscriber, routed.payload, receivedAt);
}

private deliverPayload(..., receivedAt: number): void {
  ...
  localSubscriber.callbacks.onPayload(payload, receivedAt);
}

// src/adapters/binance/adapter.ts:100-112
onPayload(payload, receivedAt) {
  if (payload.channel !== "l1book") return;
  callbacks.onUpdate({
    bidPrice: payload.bidPrice,
    bidSize: payload.bidSize,
    askPrice: payload.askPrice,
    askSize: payload.askSize,
    exchangeTs: payload.exchangeTs,
    receivedAt,
  });
}
```

Market manager 可直接用 `update.exchangeTs` 与 `update.receivedAt`：

```ts
// src/managers/market-manager.ts:917-937
onUpdate: (update: RawL1BookUpdate) => {
  record.l1Freshness = "fresh";
  record.l1Reason = undefined;
  record.l1Book = this.createL1Book(..., update, record.l1Book);
  ...
  this.publishMarketEvent(event);
  this.recomputeAndPublishStatus(record);
},

// src/managers/market-manager.ts:1039-1048
return freezeL1Book({
  ...
  exchangeTs: input.exchangeTs,
  receivedAt: input.receivedAt,
  updatedAt: input.receivedAt,
  ...
});
```

Private WS flow：

```ts
// src/adapters/binance/private-adapter.ts:1573-1578
onMessage(message, receivedAt) {
  if (closed || activeSession !== nextSession) {
    return;
  }

  dispatchPrivateMessage(message, receivedAt, false);
},

// src/adapters/binance/private-adapter.ts:1290-1354
const dispatchPrivateMessage = (
  message: BinancePrivateMessage,
  receivedAt: number,
  replaying: boolean,
): boolean => {
  if (isRiskLevelChangeMessage(message)) {
    callbacks.onRiskLevelChange(mapRiskLevelChange(message, receivedAt));
    return false;
  }
  ...
  if (isAccountUpdateMessage(message)) {
    callbacks.onAccountUpdate(
      mapAccountUpdate(this.marketCatalog, message, receivedAt),
    );
    return false;
  }
  ...
  const orderUpdate = mapOrderUpdate(
    this.marketCatalog,
    message,
    receivedAt,
  );
  if (orderUpdate) {
    callbacks.onOrderUpdate(orderUpdate);
  }
};

// src/adapters/binance/private-adapter.ts:683-755
function mapAccountUpdate(..., receivedAt: number): RawAccountUpdate {
  const exchangeTs = message.T ?? message.E;
  return { ..., exchangeTs, receivedAt };
}

function mapOrderUpdate(..., receivedAt: number): RawOrderUpdate | undefined {
  ...
  return {
    ...
    exchangeTs: payload.T ?? message.T ?? message.E,
    receivedAt,
    trade: mapOrderTrade(payload),
  };
}
```

Private manager/coordinator 层有 accountId/venue tag：

```ts
// src/client/private-subscription-coordinator.ts:1342-1376
onAccountUpdate: (update) => {
  if (!record.accountSubscribed) return;
  record.accountReady = true;
  this.accountConsumer.onPrivateAccountUpdate(
    record.accountId,
    record.venue,
    update,
  );
},
onOrderUpdate: (update) => {
  if (!record.ordersSubscribed) return;
  record.orderReady = true;
  this.orderConsumer.onPrivateOrderUpdate(
    record.accountId,
    record.venue,
    update,
  );
},
```

### 4.3 REST 延迟

`http-client.ts` 当前没有 start/end/duration 字段：

```ts
// src/internal/http-client.ts:253-303
export async function httpRequest<T>(
  options: HttpRequestOptions,
): Promise<HttpClientResponse<T>> {
  ...
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    ...
    try {
      return await executeAttempt<T>(
        options,
        fetchFn,
        url,
        redactedUrl,
        attempt,
      );
    } catch (error) { ... }
  }
}

// src/internal/http-client.ts:305-412
async function executeAttempt<T>(...): Promise<HttpClientResponse<T>> {
  ...
  try {
    const response = await fetchFn(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    ...
    const parsed = await parseResponseBody<T>(...);
    return {
      body: parsed.body,
      status: response.status,
      statusText: response.statusText,
      headers,
      rawBody: parsed.rawBody,
      url,
      redactedUrl,
      attempts,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onUpstreamAbort);
  }
}
```

已有 monotonic RTT 参考在 server-time：

```ts
// src/adapters/binance/server-time.ts:55-72
const requestSentAt = now();
const startMono = monotonicNow();
...
const responseReceivedAt = now();
const endMono = monotonicNow();

// src/adapters/binance/server-time.ts:88-93
return {
  serverTime,
  requestSentAt,
  responseReceivedAt,
  roundTripMs: endMono - startMono,
  estimatedOffsetMs: serverTime - (requestSentAt + responseReceivedAt) / 2,
};
```

MVP 若包含 REST latency，可以复用这个模式，但要决定打在泛化 `httpRequest` 层还是 adapter 层。泛化层缺少 venue/account/endpoint semantic tags；adapter 层有这些 tags，但会重复包多个请求函数。

### 4.4 事件点候选

Reconnect：

```ts
// src/internal/managed-websocket.ts:189-214
const scheduleReconnect = () => {
  if (closed || !reconnect || reconnectTimeout || ...) return;
  const baseDelay = Math.min(...);
  const jitter = baseDelay * reconnectJitterRatio * (reconnectRandom() * 2 - 1);
  const delay = Math.min(reconnect.maxDelayMs, Math.max(0, Math.round(baseDelay + jitter)));
  reconnectAttempts += 1;
  reconnectTimeout = setTimer(() => {
    reconnectTimeout = undefined;
    connect();
  }, delay);
};

// src/internal/managed-websocket.ts:442-460
socket.addEventListener("close", (event) => {
  ...
  options.onUnexpectedClose(event);
  scheduleReconnect();
});
```

Market reconnect inference:

```ts
// src/internal/subscription-multiplexer.ts:376-383
private handleOpen(connection: ConnectionState<TDescriptor, TPayload>): void {
  connection.isOpen = true;
  connection.lastControlSentAt = undefined;

  if (connection.hasOpened) {
    this.markAllStale(connection, "heartbeat_timeout");
  }
  connection.hasOpened = true;
```

Private reconnect callback:

```ts
// src/adapters/binance/private-adapter.ts:1562-1571
onOpen() {
  if (closed || activeSession !== nextSession) return;
  if (openedOnce) {
    callbacks.onReconnected();
  } else {
    openedOnce = true;
  }
}

// src/client/private-subscription-coordinator.ts:1426-1428
onReconnected: () => {
  this.requestImmediateReconcile(record);
},
```

Buffer overflow：

```ts
// src/internal/async-event-bus.ts:69-79
bufferQueue.push(event);
if (bufferQueue.length <= maxBuffer) return;

bufferQueue.shift();
if (!overflowNotified) {
  overflowNotified = true;
  options.onOverflow?.({ maxBuffer });
}

// src/client/runtime.ts:624-636
private createOverflowHandler(stream: string): (info: AsyncEventBusOverflowInfo) => void {
  return ({ maxBuffer }) => {
    const error = new AcexError(
      "EVENT_BUFFER_OVERFLOW",
      `Event stream buffer overflow: ${stream}`,
    );
    this.publishRuntimeError("runtime", error, { stream, maxBuffer });
  };
}

// src/managers/market-manager.ts:1283-1294
// src/managers/account-manager.ts:995-1006
// src/managers/order-manager.ts:1391-1403
// 同样构造 EVENT_BUFFER_OVERFLOW 并 publishRuntimeError(source, ..., { stream, maxBuffer })
```

Rate-limit block：

```ts
// src/internal/rate-limiter.ts:142-163
async beforeRequest(ctx: RateLimitRequestContext): Promise<RateLimitReservation | undefined> {
  const plan = this.getKnownPlan(ctx);
  if (!plan) {
    await this.sleepForEndpointBlock(ctx.scope);
    return;
  }
  ...
  const admission = this.tryAdmit(...);
  if (admission.admitted) {
    return admission.reservation;
  }

  await this.sleep(Math.max(0, admission.retryAt - this.now()));
}

// src/internal/rate-limiter.ts:291-325
private tryAdmit(...): AdmissionResult {
  ...
  if (state.blockedUntil !== undefined && state.blockedUntil > now) {
    retryAt = maxOptional(retryAt, state.blockedUntil);
    continue;
  }
  ...
  if (used + bucketCost.cost > limit) {
    retryAt = maxOptional(retryAt, windowEndMs(...));
  }
  ...
  return { admitted: false, retryAt };
}

// src/internal/rate-limiter.ts:591-648
private blockEndpoint(...) { ... state: isBan ? "banned" : "rate_limited" }
private blockBucket(...) { ... state: isBan ? "banned" : "rate_limited" }
```

注意：`RateLimiter` 是 public SPI，用户可传自定义实现。若要对默认 limiter 的 block 打 metric，需要把 emitter 注入 `ReactiveRateLimiter` / `BudgetRateLimiter`，或在 adapter 调用 `beforeRequest` 前后测 wait duration。后者也覆盖 custom limiter，但不能区分内部 block reason。

## 5. 现有可观测性雏形

Client runtime 有两条 client-level event bus：

```ts
// src/client/runtime.ts:256-257
private readonly healthBus = new AsyncEventBus<HealthEvent>();
private readonly errorBus = new AsyncEventBus<AcexInternalError>();

// src/client/runtime.ts:218-246
class ClientEventStreamsImpl implements ClientEventStreams {
  errors(options?: BufferedEventStreamOptions): AsyncIterable<AcexInternalError> {
    return this.errorBus.stream(() => true, {
      maxBuffer: options?.maxBuffer,
    });
  }

  health(filter?: HealthEventFilter, options?: BufferedEventStreamOptions): AsyncIterable<HealthEvent> {
    return this.healthBus.stream(
      (event) => matchesHealthFilter(event, filter),
      {
        maxBuffer: options?.maxBuffer,
        onOverflow: this.onHealthOverflow,
      },
    );
  }
}
```

Error/health 发布：

```ts
// src/client/runtime.ts:607-622
publishRuntimeError(
  source: AcexInternalError["source"],
  error: Error,
  metadata?: Omit<AcexInternalError, "error" | "source" | "ts">,
): void {
  this.errorBus.publish({
    source,
    ts: this.now(),
    error,
    ...metadata,
  });
}

publishHealthEvent(event: HealthEvent): void {
  this.healthBus.publish(event);
}

// src/client/runtime.ts:661-674
private setClientStatus(status: ClientStatus): void {
  ...
  const event: ClientStatusChangedEvent = {
    type: "client.status_changed",
    status,
    ts: this.now(),
  };
  this.healthBus.publish(event);
}
```

没有 metric/counter 雏形：`rg -n "metric|counter|gauge|timing|latency|observability" src` 未发现 metric 类型、计数器、metric bus 或 public metric API。`VenueServerTime.roundTripMs` 是单功能返回字段，不是可观测性通道。

关系建议：按 PRD 的 `onMetric(name, value, tags)`，更像纯同步 callback，而不是 `client.events.metrics()` 第四条流。理由：

- `health()` / `errors()` 是低频状态/错误事件，走 `AsyncEventBus` 有背压语义。
- metric 尤其 market tick latency 是热路径，高频进入 event bus 会引入 event 对象、队列、filter、overflow 等成本。
- `CreateClientOptions` 注入 hook 可以在未配置时只保留 null check，不污染 public event stream surface。
- 如果需要持久订阅式 metrics，可以后续在纯 callback 基础上由用户侧桥接到 Prometheus/StatsD/自建队列。

## 6. 热路径约束

P1-B6 背景：

```md
// docs/improvement-todo.md:139-145
### - [x] P1-B6 行情热路径分配偏重
- 位置：`src/internal/decimal.ts:13`（每字段 new BigNumber + toFixed）、`src/managers/market-manager.ts:969`（每 tick 4× toCanonical + 2 次克隆）、`src/internal/subscription-multiplexer.ts:430`（每消息 `[...sub.subscribers]` 拷贝）
- 修复方案：`toCanonical` 加字符串快速路径；单订阅者时跳过数组拷贝；事件 snapshot 改为冻结对象复用而非每次克隆。
- 状态：... bench `scripts/bench-market-tick.ts` 实测稳态 ≈2.26 bytes/tick。
```

当前源码中的优化痕迹：

```ts
// src/internal/decimal.ts:16-22
export function toCanonical(value: DecimalInput): string {
  if (
    typeof value === "string" &&
    CANONICAL_DECIMAL_STRING_PATTERN.test(value)
  ) {
    return value;
  }
  ...
}

// src/internal/subscription-multiplexer.ts:433-443
if (sub.subscribers.size === 1) {
  const localSubscriber = sub.subscribers.values().next().value;
  if (localSubscriber) {
    this.deliverPayload(sub, localSubscriber, routed.payload, receivedAt);
  }
  return;
}

for (const localSubscriber of [...sub.subscribers]) {
  this.deliverPayload(sub, localSubscriber, routed.payload, receivedAt);
}

// src/managers/market-manager.ts:133-144
function freezeStreamStatus(
  status: MarketDataStreamStatus,
): MarketDataStreamStatus {
  return Object.freeze({ ...status });
}

function freezeL1Book(book: L1Book): L1Book {
  return Object.freeze(book);
}

function freezeFundingRate(snapshot: FundingRateSnapshot): FundingRateSnapshot {
  return Object.freeze(snapshot);
}
```

`onMetric` 未注入时的零/极低开销原则：

- 在 `AcexClientImpl` 构造期缓存 `options.onMetric` 到 private readonly 字段，例如 `private readonly onMetric?: OnMetric`.
- `emitMetric` 第一行做 `const onMetric = this.onMetric; if (!onMetric) return;`，调用点不要先构造 tags。
- 热路径调用点应先判断 emitter 是否存在，再计算 latency / tags；例如 L1 callback 中不要在无 hook 时创建 `{ venue, symbol }`。
- callback 异常应被吞掉或转为 runtime error，需要设计确认。`SyncingTimeProvider` 的注释给了先例：observability callback 不得打断主流程。
- 高基数 tags 要谨慎，尤其 `symbol`、`accountId`、`endpoint`。这不是分配问题，也是下游指标系统 cardinality 问题。

## Open questions for design

- `onMetric` 签名是否就是 `onMetric(name, value, tags)`，还是需要 `type: "counter" | "gauge" | "timing"`？`value` 单位是否统一毫秒/计数？
- metric name 使用自由字符串还是导出固定 union/const？固定名更利于测试和文档，但会扩大 public API。
- callback 异常策略：吞掉、发布 `runtime` error、还是仅开发模式抛出？当前 `SyncingTimeProvider` 倾向吞掉。
- 下单 RTT 使用 wall-clock `context.now()` 还是 monotonic `performance.now()`？现有 `requestStartedAt` 是 wall-clock watermark 字段，不是高精度 duration 字段。
- 下单 RTT 是否覆盖失败请求？若要覆盖失败，应该在 `finally` 打 metric；若只打成功，可在 `await` 后打。
- 命令 response 的 `RawOrderUpdate.receivedAt` 当前对 `createOrder`/`cancelOrder` 在请求前采样，是否应顺手修正？这超出纯 metric 但会影响语义。
- WS 延迟 metric 放在 adapter mapper、coordinator callback、还是 manager callback？adapter 有最早消息信息，coordinator/manager 有 accountId/symbol 等更完整 tags。
- Market reconnect metric 是在 `managed-websocket` 通用层打，还是在 multiplexer/manager 层打？通用层缺少 venue/symbol，manager 层缺少精确 reconnect attempt/delay。
- REST latency 是否进入 MVP？若进入，应选择泛化 `httpRequest` 层还是 adapter 层；前者 tags 不足，后者实现重复。
- Rate-limit block metric 是注入默认 `BudgetRateLimiter`，还是 adapter 前后测 `beforeRequest` wait duration 以覆盖 custom limiter？
- metrics 是否只做 callback，不增加 `client.events.metrics()`？当前热路径和 PRD 都更支持纯 callback，但这是 public API 取舍。
