# Proactive multi-bucket throttle patterns

Research date: 2026-06-11. Target project: TypeScript/Bun trading SDK at `/workspace/projects/acex`.

Local SPI shape read before writing:

- `src/types/shared.ts`: `RateLimiter` exposes `beforeRequest`, `afterResponse`, `onTransportError`, `getSnapshot`; `RateLimitScope` is `{ venue, accountId?, endpointKey }`; `RateLimitUsage` is `{ weight?: Record<string, number>, orderCount?: Record<string, number> }`.
- `src/internal/rate-limiter.ts`: `ReactiveRateLimiter` is generic and venue-free, but purely reactive. It sleeps only when `blockedUntil` already exists and stores header `usage` without using it for proactive admission control.
- Constraint from task PRD: exchange-specific limits, endpoint weights, and bucket topology must live under `src/adapters/binance/`; core must remain a venue-agnostic budget engine.

## Implementation 1: ccxt throttler

Source checked from GitHub clone on 2026-06-11:

- `ccxt/ts/src/base/functions/throttle.ts` at commit `b453db338c864780a33b9d9b873a4f278eb35b5e`
- `ccxt/ts/src/base/Exchange.ts`
- `ccxt/ts/src/binance.ts`
- Repository: https://github.com/ccxt/ccxt

| Topic | Findings |
|---|---|
| Algorithm | Queue-based throttler with `leakyBucket` default and optional `rollingWindow`. The leaky bucket stores tokens, a refill rate, capacity, and per-request cost. The rolling-window mode stores timestamped costs and admits when the rolling sum fits. |
| Multi-bucket / layered scope | Mostly single exchange-level throttler with per-endpoint `cost`. Binance has a large endpoint cost table and `calculateRateLimiterCost()` supports cost variants such as `noSymbol`, `noCoin`, and `byLimit`. It does not model one request atomically consuming both "IP weight" and "account order count" as separate buckets in the core throttler. |
| Proactive vs reactive | Proactive: `throttle(cost)` queues before the HTTP request. It does not primarily trust exchange used-weight headers for admission control. |
| Cancel / high-priority lane | No general cancel reserve or priority queue found in the base throttler. FIFO queue means a cancel can wait behind lower-value requests. |
| Backoff & jitter | The throttler itself spaces calls; 429/418 handling is elsewhere in exchange error handling. No built-in jitter/reserve pattern in the base throttler. |

Pros on low-latency hot path:

- Very small per-request input: a numeric cost.
- Central queue gives simple concurrency control and predictable spacing.
- Per-endpoint tables are easy to adapt to exchange docs.

Cons for acex PAPI:

- Single cost scalar cannot precisely express PAPI "new order consumes order bucket but not IP weight" while queries consume IP weight, or "this request consumes N from weight and 1 from orders".
- FIFO can be a bad fit for cancels/risk-control requests.
- Pure local ledger drifts when multiple processes share the same IP/account.

## Implementation 2: Hummingbot AsyncThrottler

Source checked from GitHub clone on 2026-06-11:

- `hummingbot/core/api_throttler/data_types.py`
- `hummingbot/core/api_throttler/async_throttler.py`
- `hummingbot/core/api_throttler/async_request_context_base.py`
- `hummingbot/connector/exchange/binance/binance_constants.py`
- Commit `91ff6bfa3c4b0c97f0d4f34eb635ef6f5b772db0`
- Repository: https://github.com/hummingbot/hummingbot

| Topic | Findings |
|---|---|
| Algorithm | Sliding-window ledger. Each admitted task appends `TaskLog(timestamp, rate_limit, weight)`. Before admission, expired logs are flushed and capacity is checked over `time_interval`, with a default safety margin. |
| Multi-bucket / layered scope | Strong model. `RateLimit` has a `limit_id`, `limit`, `time_interval`, own `weight`, and `linked_limits: LinkedLimitWeightPair[]`. A request identified by one limit id can consume capacity from its own rate limit plus linked global pools. Binance constants declare top-level pools like `REQUEST_WEIGHT`, `ORDERS`, `ORDERS_24HR`, `RAW_REQUESTS`, then endpoint entries link to those pools with weights. |
| Proactive vs reactive | Proactive: `async with throttler.execute_task(limit_id)` waits before request until all related limits have capacity. It supports `limits_share_percentage`, useful when multiple bots share an account/IP and this instance should target only part of the exchange limit. |
| Header reconciliation | The inspected throttler is local-ledger driven. It does not appear to reconcile ledger values with Binance `X-MBX-USED-WEIGHT-*` headers in the core throttler. |
| Cancel / high-priority lane | No priority queue or cancel reserve found in the generic throttler. Requests acquire through one lock and wait with a retry interval. |
| Backoff & jitter | The throttler sleeps in fixed retry intervals while waiting for capacity. No jitter was apparent in the core throttler. |

Pros on low-latency hot path:

- `linked_limits` directly represents "request A consumes N from bucket X and M from bucket Y".
- Config table topology keeps exchange knowledge out of the core algorithm.
- `limits_share_percentage` is a practical control for shared external budgets.

Cons for acex:

- Sliding-window log scan can be heavier than an O(1) token bucket if task logs grow; acceptable for SDK traffic but should be bounded/optimized for hot order paths.
- Without header reconciliation, the estimate can be wrong when another process shares the same IP/account.
- No native cancel priority.

## Implementation 3: official Binance connector for JavaScript

Source checked from GitHub clone on 2026-06-11:

- `binance-connector-js/common/src/utils.ts`
- `binance-connector-js/common/src/types.ts`
- Commit `f176c0d21ac028d14d83128a21fac7b3bfd8a44c`
- Repository: https://github.com/binance/binance-connector-js

| Topic | Findings |
|---|---|
| Algorithm | Not a proactive limiter. The common HTTP function sends requests through axios, parses response headers, and returns `rateLimits` metadata. It throws typed errors for HTTP 418 and 429. |
| Multi-bucket / layered scope | It parses `x-mbx-used-weight-*` as `REQUEST_WEIGHT` and `x-mbx-order-count-*` as `ORDERS`, including interval number and unit. It does not appear to use a local multi-bucket admission controller. |
| Proactive vs reactive | Reactive/observability-oriented. `parseRateLimitHeaders()` surfaces authoritative counts after the response. Retry support is generic and does not look exchange-budget-aware. |
| Header reconciliation | Strong header parsing: interval suffixes `[smhd]` are normalized to `SECOND`, `MINUTE`, `HOUR`, `DAY`; `retry-after` is copied to parsed rate-limit objects when present. |
| Cancel / high-priority lane | No cancel reserve/priority lane found. |
| Backoff & jitter | Generic retries use configured linear backoff (`delay(backoff * attempt)`) for retryable methods/statuses. No exchange-specific jitter or proactive delay. |

Pros on low-latency hot path:

- Very cheap: no queue on the happy path.
- Header parser is useful as a source of truth and validates Binance header naming.

Cons for acex:

- By itself it does not prevent 429/418.
- No topology descriptor, no priority, no admission control.

## Implementation 4: Freqtrade

Source checked from GitHub clone on 2026-06-11:

- `freqtrade/exchange/exchange.py`
- `freqtrade/exchange/common.py`
- Commit `890fd8044680124c8ad06c81c077a2aa0cfe710b`
- Repository: https://github.com/freqtrade/freqtrade

| Topic | Findings |
|---|---|
| Algorithm | Freqtrade delegates most exchange throttling to ccxt. Its exchange initialization merges user `ccxt_config`, `ccxt_sync_config`, and `ccxt_async_config`. |
| Multi-bucket / layered scope | No separate multi-bucket limiter found in Freqtrade's exchange layer; it relies on ccxt's exchange-specific cost/rateLimit configuration. |
| Proactive vs reactive | Mostly ccxt proactive throttling plus reactive retry handling around temporary/DDOS errors. |
| Cancel / high-priority lane | No cancel reserve/priority lane found in inspected exchange layer. |
| Backoff & jitter | `calculate_backoff(retrycount, max_retries)` returns a deterministic quadratic-ish delay `(max_retries - retrycount) ** 2 + 1`; wrappers sleep on `DDosProtection` / retryable errors. No jitter found in that helper. |

Pros on low-latency hot path:

- Practical for bot workloads: outsource exchange quirks to ccxt and add coarse retry/backoff.

Cons for acex:

- Not precise enough for an SDK that wants first-class HFT/LFT rate-limit semantics.
- Reactive backoff is useful as a safety net, not a replacement for local budget admission.

## Cross-implementation takeaways

| Design concern | Best observed pattern | Reason |
|---|---|---|
| Endpoint cost declarations | ccxt and Hummingbot use exchange-specific tables | Keeps core generic and lets adapters track doc churn. |
| Multi-bucket topology | Hummingbot `linked_limits` | Directly models one request consuming multiple shared buckets. |
| Proactive admission | ccxt/Hummingbot pre-request queue/wait | Prevents 429 instead of merely reacting. |
| Header feedback | Binance connector parses exact authoritative headers | Required when other processes/API keys share the IP/account. |
| Cancel priority | Not found in inspected SDKs | acex likely needs to add this intentionally; mature bot SDKs do not solve it generically. |
| Backoff | Binance docs require backing off after 429; Freqtrade has deterministic backoff | For exchange bans, deterministic backoff should be combined with `Retry-After` and jitter to avoid synchronized retries. |

## Mapping to acex SPI

Current SPI is too thin for proactive multi-bucket limiting:

- `RateLimitRequestContext` only has `scope`; it does not say request cost, bucket ids, bucket limits, priority, or whether the operation is cancel/risk-control.
- `RateLimitUsage` can carry header counts, but it is not tied to bucket identity. `weight["1m"]` could mean PAPI IP bucket, spot IP bucket, or another venue's bucket unless the limiter infers from `scope`.
- `ReactiveRateLimiter` keys by `venue + accountId + endpointKey`, which is the wrong level for PAPI. A 429/418 from one endpoint should often block a per-IP PAPI bucket shared by other endpoints.

Adapter/core boundary should be:

- Binance adapter owns: endpointKey -> cost vector, bucket ids, intervals, limits, scope dimensions, header mapping, priority classification.
- Core owns: generic bucket state, admission control, queueing/sleep, header reconciliation, error block propagation, snapshots.

## Recommended approaches for acex

### Approach A: bucket topology descriptor plus cost vector

Best general design for PR1/PR2.

Add venue-agnostic types:

```ts
export type RateLimitBucketKind = "request_weight" | "orders" | string;
export type RateLimitScopeDimension = "venue" | "ip" | "account" | "endpoint";
export type RateLimitPriority = "normal" | "cancel" | "risk";

export interface RateLimitBucketDescriptor {
  id: string;
  kind: RateLimitBucketKind;
  limit: number;
  intervalMs: number;
  scope: readonly RateLimitScopeDimension[];
  utilizationTarget?: number;
  reserveForPriority?: Partial<Record<RateLimitPriority, number>>;
}

export interface RateLimitCost {
  bucketId: string;
  cost: number;
}

export interface RateLimitRequestContext {
  scope: RateLimitScope;
  costs?: readonly RateLimitCost[];
  buckets?: readonly RateLimitBucketDescriptor[];
  priority?: RateLimitPriority;
}
```

Binance adapter would translate `POST /papi/v1/um/order` into an account-scoped `ORDERS_1M` cost and `GET /papi/v1/account` into an IP-scoped `REQUEST_WEIGHT_1M` cost. Core does not know Binance constants; it just evaluates descriptors.

Pros:

- Cleanly models "N from IP bucket and 1 from account bucket".
- Backward compatible if `costs`/`buckets` are optional and current reactive behavior remains default.
- Header reconciliation can map `usage.weight["1m"]` to bucket descriptors with `kind=request_weight` and `intervalMs=60000`.

Cons:

- Context grows. Repeating full bucket descriptors on every request is wasteful; use adapter-level registration or shared immutable descriptors if hot-path overhead matters.

### Approach B: adapter-built `RateLimitPlan` registry

Best if we want lower hot-path overhead.

Add a registry object to the limiter or adapter integration:

```ts
export interface RateLimitPlan {
  endpointKey: string;
  costs: readonly RateLimitCost[];
  priority?: RateLimitPriority;
}

export interface RateLimitTopology {
  buckets: readonly RateLimitBucketDescriptor[];
  plans: readonly RateLimitPlan[];
}
```

The Binance adapter exports `BINANCE_PAPI_RATE_LIMIT_TOPOLOGY` and passes only `{ scope, planId: endpointKey }` on each request. Core resolves plan id to bucket costs.

Pros:

- Keeps `beforeRequest` cheap: endpointKey lookup plus bucket checks.
- Encourages tests around a single Binance topology table.
- Avoids putting Binance constants in core while not serializing descriptors every call.

Cons:

- Requires lifecycle/registration plumbing. Need to decide whether limiter is constructed with topologies or adapters register them at runtime.

### Approach C: reserve headroom plus optional priority queue

Best for PR3 cancel priority.

Extend either Approach A or B with:

```ts
export interface RateLimitRequestContext {
  scope: RateLimitScope;
  planId?: string;
  priority?: "normal" | "cancel" | "risk";
  deadlineMs?: number;
}

export interface RateLimitBucketDescriptor {
  id: string;
  limit: number;
  intervalMs: number;
  reserve?: {
    priority: "cancel" | "risk";
    units: number;
  };
  queuePolicy?: "fifo" | "priority";
}
```

Policy:

- Normal requests may only consume up to `limit - reserve.units`.
- Cancel/risk requests may consume the reserve.
- If there is queued work, a priority queue admits `risk` then `cancel` then `normal` when all required buckets have capacity.
- Never make cancels unlimited bypasses; a cancel still consumes documented request weight and can still trigger 418 if abused.

Pros:

- Simple reserve solves the main risk-control requirement.
- Priority queue can be added after reserve without changing adapter cost tables.

Cons:

- Reserve reduces normal throughput. Need a configurable default such as 5-10% of the PAPI IP bucket or a fixed number of cancel units per minute.
- Priority queues need fairness/aging to avoid starving normal traffic during stress.

## Suggested initial Binance PAPI shape

In `src/adapters/binance/`, define something close to:

```ts
const BINANCE_PAPI_BUCKETS = [
  {
    id: "binance:papi:request-weight:1m",
    kind: "request_weight",
    limit: 6000,
    intervalMs: 60_000,
    scope: ["venue", "ip"],
    utilizationTarget: 0.9,
    reserve: { priority: "cancel", units: 50 },
  },
  {
    id: "binance:papi:orders:1m",
    kind: "orders",
    limit: 1200,
    intervalMs: 60_000,
    scope: ["venue", "account"],
    utilizationTarget: 0.9,
  },
] as const;

const BINANCE_PAPI_ENDPOINT_PLANS = {
  "POST /papi/v1/um/order": {
    costs: [{ bucketId: "binance:papi:orders:1m", cost: 1 }],
    priority: "normal",
  },
  "DELETE /papi/v1/um/order": {
    costs: [{ bucketId: "binance:papi:request-weight:1m", cost: 1 }],
    priority: "cancel",
  },
  "GET /papi/v1/account": {
    costs: [{ bucketId: "binance:papi:request-weight:1m", cost: 20 }],
  },
} as const;
```

Use only the official PAPI 1-minute order bucket initially. Add 10s/day order buckets later only after official PAPI verification.

## Backoff and reconciliation recommendations

- `beforeRequest`: reserve capacity in local buckets before the HTTP call. For sliding windows, append a pending/admitted event; for token buckets, deduct tokens. If the request fails before reaching the exchange, `onTransportError` may refund only for local network failures where the request certainly did not leave the process; otherwise do not refund.
- `afterResponse`: reconcile authoritative headers. For a bucket with `kind=request_weight` and interval `1m`, set or raise local used count from `X-MBX-USED-WEIGHT-1M`. For order buckets, do the same with `X-MBX-ORDER-COUNT-1M` when present.
- Shared budgets: allow `utilizationTarget` or `limitsSharePercentage` so users running multiple processes can target, for example, 70-80% of the published limit.
- 429: parse `Retry-After` if present. If absent, delay until the next interval boundary plus jitter for all plausible affected buckets. If the endpoint has both weight and order costs and the response has no disambiguating header, block both conservatively.
- 418: block the IP-scoped request-weight bucket until `Retry-After` if present, otherwise a conservative default. Repeated 418 should extend, never shorten, the block.
- Jitter: add small random jitter to retry wakeups after 429/418 and to scheduled reconnect/listenKey retry loops. Do not add jitter to normal no-delay hot path.
