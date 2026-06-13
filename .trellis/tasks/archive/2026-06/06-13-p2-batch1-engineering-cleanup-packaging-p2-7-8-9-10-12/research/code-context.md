# Code context: engineering cleanup + packaging P2 batch

Read-only survey date: 2026-06-13.

## 1. `src/internal/async-event-bus.ts` async iterator pending `next()`

Conclusion: the reported bug still exists. Each stream has a single `pendingResolve` slot, so two concurrent `next()` calls while both queues are empty overwrite each other. The first promise can dangle forever, including across `close()`, because only the last stored resolver is retained.

Current references:

- `src/internal/async-event-bus.ts:47` stores one resolver:

```ts
let pendingResolve: ((result: IteratorResult<U>) => void) | undefined;
```

- `src/internal/async-event-bus.ts:139-152` `next()` dequeues first, then overwrites the single slot:

```ts
const queued = dequeue();
if (queued !== undefined) {
  return { done: false, value: queued };
}

return await new Promise<IteratorResult<U>>((resolve) => {
  pendingResolve = resolve;
});
```

- `src/internal/async-event-bus.ts:121-126` `dispatch()` resolves only the current slot and bypasses queues:

```ts
if (pendingResolve) {
  const resolve = pendingResolve;
  pendingResolve = undefined;
  resolve({ done: false, value: typedEvent });
  return;
}
```

- `src/internal/async-event-bus.ts:107-110` `close()` also resolves only the current slot:

```ts
if (pendingResolve) {
  const resolve = pendingResolve;
  pendingResolve = undefined;
  resolve(doneResult<U>());
}
```

Exact mechanism:

1. `next()` call A sees no queued event and assigns `pendingResolve = resolveA`.
2. `next()` call B runs before a matching event arrives, sees no queued event, assigns `pendingResolve = resolveB`.
3. A's resolver is no longer referenced.
4. A future `publish()` resolves B only; A remains pending. If the stream is later closed, `close()` also only sees the current slot, not A.

Interaction with recent `buffer` / `conflate` modes:

- Both modes only matter when no `pendingResolve` exists. `enqueue()` either writes to the conflate `Map` or to `bufferQueue` (`src/internal/async-event-bus.ts:59-80`).
- `dequeue()` reads from the conflate `Map` first entry or `bufferQueue.shift()` (`src/internal/async-event-bus.ts:82-97`).
- If any `next()` is pending, `dispatch()` resolves it directly and does not enqueue, so neither buffer overflow nor conflate latest-wins logic protects against multiple pending readers.
- `conflate` is naturally bounded for queued values, but it still has the same single pending-reader bug when the conflate queue is empty.

## 2. `src/managers/market-manager.ts` `resumeStreams()` serial behavior

Conclusion: `resumeStreams()` is serial. It iterates `records.values()` and awaits each missing stream before moving to the next stream / record. A slow or timing-out stream ready barrier blocks later resubscriptions.

Current references:

- `onClientStarted()` fire-and-forgets resume: `src/managers/market-manager.ts:495-517`

```ts
void this.resumeStreams();
```

- Serial loop: `src/managers/market-manager.ts:1298-1328`

```ts
for (const record of this.records.values()) {
  ...
  if (record.l1BookSubscribed && !record.l1BookStream) {
    try {
      ...
      await this.ensureL1BookStream(record, market);
    } catch {
      // Errors are already published through the runtime error bus.
    }
  }

  if (record.fundingRateSubscribed && !record.fundingRateStream) {
    try {
      ...
      await this.ensureFundingRateStream(record, market);
    } catch {
      // Errors are already published through the runtime error bus.
    }
  }
}
```

- `ensure*Stream()` waits for `StreamHandle.ready`: `src/managers/market-manager.ts:834-868` and `src/managers/market-manager.ts:871-910`.

Parallelizing would need to preserve the current per-stream error isolation: each stream attempt currently catches and swallows after publishing runtime errors. A parallel form should create one task per `(record, stream)` and use per-task `try/catch` or `Promise.allSettled()` so one failed subscription does not reject the whole resume batch. It also needs to keep per-record mutations (`l1Freshness`, `fundingRateFreshness`, status recompute) local to each task and avoid double-starting a stream if another path has already assigned `record.*Stream`.

## 3. `src/managers/order-manager.ts` local client order id generation

Conclusion: the generated id is process-local and time/counter based: `acex-<Date.now base36>-<sequence base36>`. There is no process id, random suffix, account id, or persistence. Two separate SDK processes creating their first generated order in the same millisecond can generate the same `clientOrderId`.

Current references:

- Sequence starts at zero per `OrderManagerImpl` instance: `src/managers/order-manager.ts:116`

```ts
private localOrderSequence = 0;
```

- Prefix and Binance-safe regex: `src/managers/order/identity.ts:3-4`

```ts
export const SDK_CLIENT_ORDER_ID_PREFIX = "acex-";
export const VENUE_CLIENT_ORDER_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,32}$/;
```

- Generation scheme and local collision checks: `src/managers/order-manager.ts:1139-1155`

```ts
const candidate = `${SDK_CLIENT_ORDER_ID_PREFIX}${this.context.now().toString(36)}-${(this.localOrderSequence++).toString(36)}`;
if (
  (options?.record &&
    options.avoidOpenClientOrderId &&
    isVenueClientOrderIdInUseForOpenOrder(options.record, candidate)) ||
  options?.record?.pendingClientOrderIdIndex.has(candidate) ||
  !VENUE_CLIENT_ORDER_ID_PATTERN.test(candidate)
) {
  continue;
}
```

Collision risk:

- Within one manager instance, `localOrderSequence++` differentiates multiple orders in the same millisecond.
- Within one account record, the generator checks open orders and pending claims.
- Across two processes or two independent clients with fresh `OrderManagerImpl` instances, both sequences can be `0` and both clocks can return the same millisecond, producing the same `acex-<ts>-0`. The local open/pending indexes cannot see the other process.
- Binance's own rule says the client order id is unique among open orders; a cross-process duplicate can therefore collide at the venue if the first order remains open.

## 4. `src/types/order.ts` `OrderSnapshot.type` and Binance passthrough

Conclusion: `CreateOrderInput.type` is narrowed to `"limit" | "market"`, but `OrderSnapshot.type` and `RawOrderUpdate.type` are plain `string`. Binance adapter writes raw venue uppercase strings into `RawOrderUpdate.type`, and `createSnapshot()` passes them through unchanged to public `OrderSnapshot.type`.

Current references:

- Public create input type: `src/types/order.ts:41`

```ts
export type CreateOrderType = "limit" | "market";
```

- Public snapshot is wide string: `src/types/order.ts:98-106`

```ts
export interface OrderSnapshot {
  ...
  side: OrderSide;
  type: string;
  status: OrderStatus;
```

- Raw adapter boundary is also wide string: `src/adapters/types.ts:270-276`

```ts
export interface RawOrderUpdate {
  ...
  side: OrderSide;
  type: string;
  status: OrderStatus;
```

- Snapshot constructor does not normalize type: `src/managers/order/snapshot.ts:23-31`

```ts
return {
  ...
  side: input.side,
  type: input.type,
  status: mergeOrderStatus(input, previous),
```

- SDK-created orders encode only `LIMIT` / `MARKET`: `src/adapters/binance/private-adapter.ts:283-287`

```ts
function encodeOrderType(
  value: CreateOrderRequest["type"],
): "LIMIT" | "MARKET" {
  return value === "market" ? "MARKET" : "LIMIT";
}
```

- Binance runtime capability also advertises only public create types `["limit", "market"]`: `src/adapters/binance/private-adapter.ts:822-830`.

- REST open orders pass through `input.type`: `src/adapters/binance/private-adapter.ts:489-520`

```ts
type: input.type ?? "unknown",
```

- WS `ORDER_TRADE_UPDATE` passes through payload `o`: `src/adapters/binance/private-adapter.ts:614-647`

```ts
type: payload.o ?? "unknown",
```

Venue strings that can appear in public snapshots today:

- From SDK-created PAPI UM regular orders: `LIMIT`, `MARKET`.
- From `/papi/v1/um/openOrders` and `ORDER_TRADE_UPDATE`: any non-empty string Binance returns in `type` / `o`, because local interfaces type these fields as `string` (`src/adapters/binance/private-adapter.ts:89-95`, `src/adapters/binance/private-adapter.ts:145-152`).
- Current Binance PAPI UM regular order and user-stream docs list regular order types as `LIMIT` and `MARKET`. PAPI UM algo/conditional docs list conditional order types such as `STOP`, `STOP_MARKET`, `TAKE_PROFIT`, `TAKE_PROFIT_MARKET`, and `TRAILING_STOP_MARKET`; if those strings ever arrive through the currently consumed open-orders or user-stream fields, the SDK will pass them through unchanged.
- If Binance omits the field, the SDK emits `"unknown"`.

## 5. `src/managers/account-manager.ts` mutable getter references

Conclusion: `AccountManager` getters return internal mutable object references. This contrasts with `MarketManager`'s current pattern of storing frozen shared snapshots/status objects and returning those shared frozen objects.

Current AccountManager references:

- Internal state is `records: Map<string, AccountRecord>`; each record holds `snapshot?: AccountSnapshot`: `src/managers/account-manager.ts:43-49`, `src/managers/account-manager.ts:120-124`.
- Getters return direct internal refs: `src/managers/account-manager.ts:197-225`

```ts
getAccountSnapshot(accountId: string): AccountSnapshot | undefined {
  return this.records.get(accountId)?.snapshot;
}

getBalance(accountId: string, asset: string): BalanceSnapshot | undefined {
  return this.records.get(accountId)?.snapshot?.balances[asset];
}

getBalances(accountId: string): BalanceSnapshot[] {
  const balances = this.records.get(accountId)?.snapshot?.balances;
  return balances ? Object.values(balances) : [];
}
```

- `getPositions()` returns a new array, but the elements are the same internal `PositionSnapshot` objects: `src/managers/account-manager.ts:216-221`.
- `getRiskSnapshot()` returns the internal `risk` object directly: `src/managers/account-manager.ts:224-225`.
- `getAccountStatus()` does clone status only: `src/managers/account-manager.ts:228-230`.

Internal mutation / replacement pattern:

- Bootstrap replaces `record.snapshot` with a newly built snapshot: `src/managers/account-manager.ts:303-314`.
- Incremental updates shallow-copy `previous.balances`, build a `Map` from previous positions, and assign a new `record.snapshot` only when something applied: `src/managers/account-manager.ts:348-457`.
- Reconcile also creates new container objects and then replaces `record.snapshot`: `src/managers/account-manager.ts:477-585`.
- The created `BalanceSnapshot`, `PositionSnapshot`, and `RiskSnapshot` objects are plain objects; no `Object.freeze()` is used in `createBalance()`, `createPosition()`, or `createRisk()` (`src/managers/account-manager.ts:717-872`).
- Unchanged nested objects can be reused into the next snapshot container. For example, update starts with `{ ...previous.balances }` and only replaces touched assets (`src/managers/account-manager.ts:348-377`).

Risk: callers can mutate `AccountSnapshot.balances`, `positions`, individual balances/positions/risk objects, or event `snapshot` payloads. Those mutations can affect current manager state and may be carried into later snapshots for untouched nested entries.

MarketManager contrast:

- Freeze helpers: `src/managers/market-manager.ts:105-145`

```ts
function freezeMarketStatus(status: MarketDataStatus): MarketDataStatus {
  return Object.freeze({ ...status });
}
function freezeL1Book(book: L1Book): L1Book {
  return Object.freeze(book);
}
function freezeFundingRate(snapshot: FundingRateSnapshot): FundingRateSnapshot {
  return Object.freeze(snapshot);
}
```

- Market getters return shared record objects directly (`src/managers/market-manager.ts:457-490`), but those objects are produced through freeze helpers in `createL1Book()`, `createFundingRate()`, status recompute, and stream status sync (`src/managers/market-manager.ts:1033-1087`, `src/managers/market-manager.ts:1133`, `src/managers/market-manager.ts:1155-1189`, `src/managers/market-manager.ts:1192-1210`).

## 6. `src/client/runtime.ts` `stop()` current behavior

Conclusion: `stop()` is a synchronous shutdown sequence wrapped in an async signature. It does not honor `StopOptions.graceful` or `timeoutMs`, does not await in-flight order commands, does not await in-flight private reconcile/refresh requests, and does not remove the client from `activeClients`. It does call lifecycle `stop()`, coordinator stopping, and manager `onClientStopping()`.

Current `StopOptions`:

- Public type: `src/types/shared.ts:376-379`

```ts
export interface StopOptions {
  graceful?: boolean;
  timeoutMs?: number;
}
```

- Runtime accepts but ignores it via `_options`: `src/client/runtime.ts:421`.
- Public docs already describe it as reserved: `docs/api.md:262-269`.

Current `stop()` behavior:

- `start()` does not await adapter lifecycle startup; it calls `void lifecycle.start()` then moves to `running`: `src/client/runtime.ts:404-419`.
- `stop()` early returns for `stopped`/`idle`, otherwise sets `stopping`, records `now`, calls lifecycle stops, stops coordinator/managers, then sets `stopped`: `src/client/runtime.ts:421-440`.

```ts
this.setClientStatus("stopping");

const now = this.now();
for (const lifecycle of this.adapterLifecycles) {
  lifecycle.stop();
}
this.privateCoordinator.onClientStopping();
this.marketManager.onClientStopping(now);
this.accountManager.onClientStopping(now);
this.orderManager.onClientStopping(now);

this.setClientStatus("stopped");
```

In-flight commands / reconcile:

- Order commands are direct adapter promises; runtime does not register them anywhere: `src/client/runtime.ts:518-565`.
- Private coordinator tracks refresh/reconcile in-flight promises (`src/client/private-subscription-coordinator.ts:37-49`) but `onClientStopping()` only stops timers and closes streams: `src/client/private-subscription-coordinator.ts:320-325`.
- Account refresh stop increments generation and clears the timer / in-flight pointer, but does not await or cancel the actual adapter promise: `src/client/private-subscription-coordinator.ts:593-600`.
- Refresh completion checks generation after await and drops stale results: `src/client/private-subscription-coordinator.ts:631-649`, `src/client/private-subscription-coordinator.ts:784-819`.
- Private reconcile stop increments generation and clears scheduling flags, but does not clear/await `privateReconcilePromise`: `src/client/private-subscription-coordinator.ts:691-701`.
- Reconcile checks `privateReconcileGeneration` after await before applying account/order results: `src/client/private-subscription-coordinator.ts:873-921`, `src/client/private-subscription-coordinator.ts:957-1015`, with the shared guard at `src/client/private-subscription-coordinator.ts:538-560`.
- `onClientStopping()` does not set `accountSubscribed` / `ordersSubscribed` false. It pauses streams/timers; a later `start()` can resume subscribed records via `onClientStarted()` / `resumeRecord()` (`src/client/private-subscription-coordinator.ts:296-317`, `src/client/private-subscription-coordinator.ts:356-440`).

`activeClients`:

- Set declared: `src/client/runtime.ts:71`.
- Client added in constructor: `src/client/runtime.ts:249-250`.
- Test helper clears the whole set before best-effort stopping: `src/client/runtime.ts:187-195`.
- No ordinary `stop()` path calls `activeClients.delete(this)`. A stopped client remains in the set until `stopAllClientsForTests()` clears all clients.

Dispose / close surface called or not called:

- `VenueAdapterLifecycle` only has `start()` / `stop()` (`src/client/runtime.ts:73-76`). Currently it is only used for the default Binance `SyncingTimeProvider` lifecycle (`src/client/runtime.ts:127-168`).
- `MarketManager.onClientStopping()` closes active L1/funding stream handles and marks status inactive/stale: `src/managers/market-manager.ts:519-540`.
- `AccountManager.onClientStopping()` only marks account statuses stopped; it does not own streams directly: `src/managers/account-manager.ts:237-250`.
- `OrderManager.onClientStopping()` only marks order statuses stopped; it does not own streams directly: `src/managers/order-manager.ts:436-449`.
- `PrivateSubscriptionCoordinator.onClientStopping()` closes private stream handles and polling timers: `src/client/private-subscription-coordinator.ts:320-325`.
- Binance market adapter has no adapter-level `close()` / `dispose()`; it only returns per-subscription handles (`src/adapters/binance/adapter.ts:48-221`). Runtime does not call any global market adapter disposal.
- Binance private stream handle `close()` clears recovery/symbol-mapping timers, empties quarantine, closes current session, clears keepalive timer, and fire-and-forgets listenKey DELETE: `src/adapters/binance/private-adapter.ts:1337-1368`, `src/adapters/binance/private-adapter.ts:1555-1568`.
- Juplend private stream handle `close()` clears the next poll timer but cannot cancel an in-flight poll: `src/adapters/juplend/private-adapter.ts:755-807`.

Clock / timer lifecycle:

- If no user `clock` is provided, Binance adapter group creates a `SyncingTimeProvider` and exposes it as lifecycle `start/stop`: `src/client/runtime.ts:127-168`.
- `SyncingTimeProvider.start()` sets `started`, queues startup sampling, then schedules periodic resync: `src/internal/syncing-time-provider.ts:73-98`.
- `SyncingTimeProvider.stop()` flips `started` false, increments `runId`, clears periodic and debounce timers: `src/internal/syncing-time-provider.ts:100-111`.
- Existing sample promises are not aborted, but `isActive(runId)` checks prevent applying samples after stop (`src/internal/syncing-time-provider.ts:138-244`).
- Periodic/debounce timer cleanup is at `src/internal/syncing-time-provider.ts:261-275` and `src/internal/syncing-time-provider.ts:319-340`.

## 7. `src/adapters/binance/private-adapter.ts` `parsePrivateMessage` and missing private events

Conclusion: `parsePrivateMessage()` currently admits only `ACCOUNT_UPDATE`, `ORDER_TRADE_UPDATE`, and `listenKeyExpired`. `MARGIN_CALL` and `ACCOUNT_CONFIG_UPDATE` are dropped before adapter dispatch. Dropped messages also do not count as ManagedWebSocket business-message activity.

Current references:

- Message union only includes three shapes: `src/adapters/binance/private-adapter.ts:183-186`.
- Parser allow-list: `src/adapters/binance/private-adapter.ts:568-575`

```ts
function parsePrivateMessage(data: string): BinancePrivateMessage | undefined {
  const parsed = JSON.parse(data) as BinancePrivateMessage;
  return parsed.e === "ACCOUNT_UPDATE" ||
    parsed.e === "ORDER_TRADE_UPDATE" ||
    parsed.e === "listenKeyExpired"
    ? parsed
    : undefined;
}
```

- ManagedWebSocket drops `undefined` parse results before `noteConnectionActivity()` and before `onMessage`: `src/internal/managed-websocket.ts:408-428`.
- Private dispatch then routes account updates, listen-key expiry, or falls through to order update mapping: `src/adapters/binance/private-adapter.ts:1180-1235`.

Current adapter callback surface:

- `RawAccountUpdate` has only balances, positions, risk, exchangeTs, receivedAt: `src/adapters/types.ts:249-255`.
- `PrivateStreamCallbacks` has `onAccountSnapshot`, `onAccountUpdate`, `onOrderUpdate`, freshness/disconnect/reconnect/reconcile/error hooks; no raw/private alert callback: `src/adapters/types.ts:322-330`.
- `PrivateAccountDataConsumer` accepts bootstrap/update/reconcile/stream-state only: `src/client/context.ts:83-107`.

Current public event surface:

- Account public events are `balance.updated`, `position.updated`, `risk.updated`, and `account.snapshot_replaced`: `src/types/account.ts:127-159`.
- `account.events.updates()` and `account.events.status()` expose those account events and status changes: `src/types/account.ts:161-169`.
- Client health events are only client/market/account/order status changes: `src/types/client.ts:44-64`.
- Client errors stream carries `AcexInternalError` from `publishRuntimeError()` (`src/client/runtime.ts:567-578`), but a margin call is a domain alert, not necessarily an SDK error.

Candidate passthrough channels for `MARGIN_CALL`:

- Best-aligned public channel: add a new account-domain event under `client.account.events.updates()`, e.g. `account.margin_call` carrying a normalized margin-call payload. That requires a new adapter raw type such as `RawMarginCallEvent` / `RawMarginCallUpdate`, a `PrivateStreamCallbacks.onMarginCall(...)`, a `PrivateAccountDataConsumer.onPrivateMarginCall(...)`, and a public `MarginCallEvent` in `src/types/account.ts`.
- Lower-fidelity alternative: publish to `client.events.errors()` as an internal/runtime warning. This would require an `AcexError` or ordinary `Error` and metadata, but it would conflate a venue risk event with SDK failure semantics.
- Health stream is not currently suitable without extending `HealthEvent`, because it only carries status change events.
- `ACCOUNT_CONFIG_UPDATE` likely needs a separate raw type, e.g. `RawAccountConfigUpdate`, if the SDK wants to expose leverage/config changes rather than trying to fit them into `RawAccountUpdate`.

## 8. Packaging / publish current state

Conclusion: the package is published to npm, but this repo currently publishes TypeScript source directly (`exports` points to `./index.ts`) with no build step and no declaration emit. The docs and scripts strongly imply Bun-first consumption, but package metadata does not declare `engines` or a Node/browser support matrix.

`package.json`:

- Name/version/type/exports: `package.json:2-13`

```json
"name": "@imbingox/acex",
"version": "0.4.0-beta.20",
"module": "index.ts",
"type": "module",
"exports": {
  ".": "./index.ts"
}
```

- Publish config and files: `package.json:14-23`

```json
"publishConfig": { "access": "public" },
"files": ["index.ts", "src/", "docs/api.md", "README.md", "CHANGELOG.md"]
```

- Scripts: `package.json:24-52`. Quality/publish scripts are Bun-based (`bun run lint`, `type-check`, `test`, `pack:check`, `release`).
- Dev dependencies: `package.json:53-59`. Present: Biome, Changesets, Trellis, `@types/bun`, TypeScript. No `tsup`, Rollup, esbuild, Vite library build, or declaration bundler.
- Runtime dependencies: `package.json:60-64`: `@jup-ag/lend-read`, `@solana/web3.js`, `bignumber.js`.
- No `types`, `main`, `bin`, `engines`, or `sideEffects` field found in current `package.json`.

Entry point:

- `index.ts:1`

```ts
export * from "./src/index.ts";
```

`tsconfig.json`:

- Bun types and bundler mode: `tsconfig.json:4-16`

```json
"lib": ["ESNext"],
"target": "ESNext",
"types": ["bun-types"],
"module": "Preserve",
"moduleResolution": "bundler",
"allowImportingTsExtensions": true,
"verbatimModuleSyntax": true,
"noEmit": true
```

- There is no declaration emit config (`declaration`, `emitDeclarationOnly`, `outDir`) because `noEmit: true` is set.

Changesets:

- `.changeset/config.json:1-18` sets public access, `baseBranch: "main"`, changed file patterns for `src/**`, `index.ts`, `package.json`, `README.md`, `docs/api.md`, and `updateInternalDependencies: "patch"`.

CI / release:

- `.github/workflows/ci.yml:1-64` runs on PR and main push, installs with Bun, checks Changesets status on PRs, runs lint/type-check/unit/integration tests.
- `.github/workflows/release.yml:1-161` has automatic beta release on `main` push, with trusted publishing permissions (`contents`, `pull-requests`, `id-token`), Bun install, lint/type-check/test, Changesets action, `pack:check`, `NPM_CONFIG_PROVENANCE=true`, `NPM_CONFIG_TAG=beta`, npm publish, git tag, GitHub prerelease.
- `.github/workflows/release.yml:163-348` has manual stable release via `workflow_dispatch`, main-branch guard, prerelease exit/versioning, `pack:check`, stable npm publish with provenance, tag/release creation, and optional re-enter beta mode.

Pack check:

- `scripts/check-npm-pack.ts:12-20` runs `npm pack --dry-run --json` and requires `README.md` and `CHANGELOG.md`.
- It does not validate compiled JS, `.d.ts`, `exports`, or consumer runtime compatibility.

npm publish state:

- `npm view @imbingox/acex name version dist-tags --json` succeeded during this survey.
- Registry result: package exists; `latest` is `0.3.0`, `beta` is `0.4.0-beta.21`.
- Current working tree `package.json` is `0.4.0-beta.20`, so this branch is behind the current npm beta tag.

Consumer/runtime docs:

- README install command is `bun add @imbingox/acex`: `README.md:7-11`.
- README development commands are Bun-only: `README.md:171-178`.
- API docs install command is `bun add @imbingox/acex`: `docs/api.md:31-37`.
- API docs state `stop(options?)` options are reserved and do not provide drain semantics: `docs/api.md:262-269`.
- API docs mention default signing-clock sampler/timer behavior and custom `clock`: `docs/api.md:825`.
- No README/API section found that explicitly promises Node.js, browser, Deno, or non-Bun consumption. The source imports `.ts` extensions and package exports point to `.ts`, so non-Bun consumers likely need a runtime/bundler that can consume TypeScript source with `.ts` import specifiers.

## Open questions for design

1. Should `AsyncEventBus` explicitly reject concurrent `next()` calls, queue multiple pending resolvers, or serialize readers with a documented single-reader contract?
2. If `resumeStreams()` is parallelized, should it be unbounded per subscription, bounded by venue/connection, or reuse existing multiplexer backpressure only?
3. Should generated client order ids include process-level entropy or an optional user-configured prefix to avoid cross-process same-ms collisions?
4. Should public `OrderSnapshot.type` stay as raw venue string, add a normalized field, or narrow to a union plus `rawType` for conditional/venue-specific order types?
5. Should account getters follow the market frozen-shared-snapshot pattern, return clones, or document mutable references as intentional?
6. Should `stop({ graceful, timeoutMs })` become real drain semantics for commands/reconcile, or should `StopOptions` be removed/kept explicitly reserved until needed?
7. Should stopped clients be removed from `activeClients`, and should `stopAllClientsForTests()` await client stops instead of fire-and-forget?
8. For `MARGIN_CALL`, should the public channel be `account.events.updates()` with a new typed event, `client.events.health()`, or `client.events.errors()` as an operational alert?
9. For packaging, is the intended consumer contract Bun-only source distribution, or should the package ship built JS plus `.d.ts` and declare supported Node/Bun versions?
