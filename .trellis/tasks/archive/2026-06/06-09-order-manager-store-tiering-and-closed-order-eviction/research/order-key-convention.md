# Research: How mature trading / OMS frameworks key & index orders (clientOrderId vs exchange orderId)

- **Query**: Should the in-memory order store key/index by clientOrderId, exchange orderId, or both? Is "clientOrderId-as-primary-key" the industry-standard convention?
- **Scope**: external (framework source + docs) + internal (acex mapping)
- **Date**: 2026-06-09

## TL;DR

The "clientOrderId as **sole** primary key" claim is half-right. The genuine mainstream convention among **stateful OMS / strategy frameworks that *originate* orders** (Hummingbot, NautilusTrader, FIX) is to use the **client order id as the primary store key**, *but always backed by a second index keyed on the exchange/venue order id*. It is a **dual / composite identity**, not a single key. Pure feed/connector libraries that mostly *observe* orders rather than originate them (cryptofeed, ccxt's unified `fetchOrder`, freqtrade's persistence) lean on the **exchange order id** as the canonical handle. The deciding factor is *who generates the id first and whether the framework must correlate an ack before the exchange id exists*.

---

## Findings per framework

### 1. Hummingbot — clientOrderId primary, exchange id as secondary index (dual)

`ClientOrderTracker` keys its main dicts by **`client_order_id`**, and maintains parallel **`*_by_exchange_order_id`** views generated on demand.

- Primary stores keyed by client id:
  - `client_order_tracker.py`: `self._in_flight_orders: Dict[str, InFlightOrder] = {}`; `start_tracking_order` does `self._in_flight_orders[order.client_order_id] = order`; `stop_tracking_order(client_order_id)`.
  - Cached + lost orders also keyed by client id (`_cached_orders` TTLCache, `_lost_orders`).
- Secondary index by exchange id, built lazily:
  - `all_fillable_orders_by_exchange_order_id` and `all_updatable_orders_by_exchange_order_id` properties build `{order.exchange_order_id: order ...}` maps.
- Dual lookup API: `fetch_order(client_order_id=None, exchange_order_id=None)` tries client id first, then linear-scans by exchange id. `_process_order_update` accepts an `OrderUpdate` carrying *either* id and resolves via `fetch_order`.
- **Async/WS ack correlation when exchange id not yet known**: `InFlightOrder` carries `exchange_order_id: Optional[str]` plus an `asyncio.Event` `exchange_order_id_update_event`. The order is created and tracked under the client id *immediately* (state `PENDING_CREATE`); `get_exchange_order_id()` `await`s the event, set by `update_exchange_order_id()` when the ack/stream delivers it. This is the canonical reason for client-id-primary: the local handle must exist before the venue id arrives.
- **Rationale (from docstring)**: tracker exists to handle "(2) Cannot retrieve exchange_order_id of an order" among other error cases — i.e. client-id keying survives missing/late exchange ids. Lost-order / order-not-found recovery (`_order_not_found_records`, `_lost_orders`, `CACHED_ORDER_TTL = 30s`) all keyed by client id.
- Source: `hummingbot/connector/client_order_tracker.py`, `hummingbot/core/data_type/in_flight_order.py` (master).
  - https://github.com/hummingbot/hummingbot/blob/master/hummingbot/connector/client_order_tracker.py
  - https://github.com/hummingbot/hummingbot/blob/master/hummingbot/core/data_type/in_flight_order.py

### 2. NautilusTrader — ClientOrderId primary key, VenueOrderId reverse index (explicit dual)

The clearest "dual identity" implementation. The central `Cache`:

- Primary order dict keyed by client id: `self._orders: dict[ClientOrderId, Order] = {}` (`cache.pyx:139`).
- Explicit bidirectional indices:
  - `self._index_venue_order_ids: dict[VenueOrderId, ClientOrderId] = {}` (`:150`)
  - `self._index_client_order_ids: dict[ClientOrderId, VenueOrderId] = {}` (`:151`)
  - plus many secondary `ClientOrderId`-keyed indices (open/closed/inflight/emulated, by venue/instrument/strategy/position/account).
- Lookup helpers: `client_order_id(VenueOrderId)` returns the matching client id via `_index_venue_order_ids.get(...)` (`cache.pyx:4651`); inverse `venue_order_id(ClientOrderId)` (`:4669`); `add_venue_order_id(...)` (`:2110`) links them once the venue id is known.
- **Orders NOT originated by the system (external / manually placed)**: `ExecutionEngine` supports *external order claims*. Strategies register `external_order_claims` instrument IDs; reconciliation assigns/generates a `ClientOrderId` for venue-only orders so they fit the client-id-keyed cache. See `execution/engine.pyx`: `_external_clients`, `_external_order_claims`, `register_external_order_claims`, `get_external_order_claim`.
- **Ack correlation by exchange id**: on an `OrderFilled`/event whose order isn't in cache by client id, the engine does "Search cache for ClientOrderId matching the VenueOrderId" via `self._cache.client_order_id(event.venue_order_id)`, then `self._cache.order(client_order_id)` (`engine.pyx:~1269`). So the venue-id reverse index is the fallback path for correlation.
- Source: `nautilus_trader/cache/cache.pyx`, `nautilus_trader/execution/engine.pyx` (develop).
  - https://github.com/nautechsystems/nautilus_trader/blob/develop/nautilus_trader/cache/cache.pyx
  - https://github.com/nautechsystems/nautilus_trader/blob/develop/nautilus_trader/execution/engine.pyx

### 3. ccxt / ccxt.pro — unified handle is the **exchange `id`**; `clientOrderId` is an optional field

ccxt is a connector layer, not a stateful OMS, and it does NOT keep a long-lived order store. Its unified order structure has both fields but the canonical handle for API calls is the exchange `id`:

- Unified order struct: `'id': '12345-...'` (exchange order id) and `'clientOrderId': 'abcdef-...'` "a user-defined clientOrderId, if any" (Manual.md ~4749).
- `fetchOrder(id, symbol, params)` / `cancelOrder` take the **exchange `id`** as the mandatory argument. Fetching by clientOrderId is exchange-specific, passed via `params` (e.g. `{ 'clientOrderId': ... }`), not a first-class parameter.
- Docs explicitly note clientOrderId is "only available for the exchanges that do support clientOrderId" and is for the user "to later distinguish between own orders" (Manual.md ~4790) — i.e. a dedup/recognition aid, not the library's key.
- ccxt even tells users who need an order *history store* to "store a dictionary or a database of orders in the userland" — it pushes statefulness to the caller (Manual.md ~4612).
- Source: https://github.com/ccxt/ccxt/blob/master/wiki/Manual.md (sections "Order Structure", "By Order Id", "User-defined clientOrderId").

### 4. freqtrade — persists & indexes by **exchange order id** (`order_id`)

freqtrade's SQLAlchemy `Order` model uses the exchange-assigned id as its business key:

- `order_id: Mapped[str]` is `nullable=False, index=True`; uniqueness constraint is `(ft_pair, order_id)` (`trade_model.py:81-99`). Comment: "its likely that order_id is unique per Pair on some exchanges."
- It is populated straight from the ccxt exchange id: `parse_from_ccxt_object(...)` sets `order_id=str(order["id"])` (`:354`); `update_orders` matches by `o.order_id == order.get("id")` (`:332`); `select_order_by_order_id(order_id)` docstring: "param order_id: **Exchange order id**" (`:1321-1327`); `order_by_id` queries `Order.order_id == order_id` (`:373-378`).
- freqtrade does pass a custom client id where the exchange needs it but does not key its store on it; the exchange id is primary.
- Source: https://github.com/freqtrade/freqtrade/blob/develop/freqtrade/persistence/trade_model.py

### 5. cryptofeed — tracks by **exchange `id`** (feed handler, not an OMS)

`cryptofeed/types.pyx`: `OrderInfo` has a single `cdef readonly str id` identifier (set from `data['id']`, the exchange's id); there is no separate client-order-id key. It is an observation/feed layer for order updates, so it naturally keys on what the exchange emits. Good contrast datapoint: pure observers default to exchange id.
  - https://github.com/bmoscon/cryptofeed/blob/master/cryptofeed/types.pyx

### 6. FIX protocol — the origin of "ClOrdID as the client's primary handle"

This is where the "clientOrderId-as-key" intuition comes from, and it is genuinely dual by design:

- **ClOrdID (tag 11)**: "Unique identifier for Order **as assigned by the buy-side** (institution, broker...). Uniqueness must be guaranteed within a single trading day... should ensure uniqueness across days, e.g. by embedding a date." The client owns and chooses it before submission. (FIX 4.4 dictionary.)
  - https://www.onixs.biz/fix-dictionary/4.4/tagNum_11.html
- **OrderID (tag 37)**: "Unique identifier for Order **as assigned by sell-side** (broker, exchange, ECN)." Assigned only after the venue accepts the order.
  - https://www.onixs.biz/fix-dictionary/4.4/tagNum_37.html
- **OrigClOrdID (tag 41)**: used in cancel/replace to reference the *previous* ClOrdID — i.e. FIX expects the ClOrdID to change on amend, and uses a chain of client ids; the client side is expected to maintain the mapping. So even FIX is not a single immutable client key — it's a client-id chain + a venue OrderID.
  - https://www.onixs.biz/fix-dictionary/4.4/tagNum_41.html
- Takeaway: FIX is the source of "client owns the primary handle (ClOrdID)" because in NewOrderSingle the ClOrdID is the *only* id that exists at submission time; OrderID arrives on the ExecutionReport ack. But the working model is **ClOrdID + OrderID together**, with implementations indexing on both.

---

## Synthesis: is "clientOrderId as SOLE primary key" the mainstream?

- **Mainstream = dual / composite identity**, not a single client key:
  - Order-originating OMS frameworks (Hummingbot, NautilusTrader) and FIX **do** make the **client order id the primary handle / primary store key**, because at submission time it is the only id that exists and the local order object must exist before the ack.
  - But every one of them **also keeps an exchange/venue-order-id index** (Hummingbot's `*_by_exchange_order_id`, Nautilus's `_index_venue_order_ids`, FIX's OrderID) to (a) correlate acks/fills that may only carry the venue id, and (b) handle orders not originated by the system.
- Pure connector / observer layers (ccxt unified API, freqtrade persistence, cryptofeed) instead treat the **exchange order id as canonical**, because they primarily *read back* orders the exchange already knows about.
- The decisive variables:
  1. **Does the framework originate orders and need a handle before the exchange id exists?** → client-id-primary makes sense (async/WS entry, idempotency/dedup, reconnect/recovery). 
  2. **Must it correlate acks/fills keyed only by exchange id, and ingest externally-placed orders?** → an exchange-id index is mandatory regardless.
- **Idempotency/dedup**: client id is the standard dedup token on (re)submission (FIX uniqueness rule; ccxt's "distinguish between own orders"). That's an argument for *having* a client id, not for making it the *sole* store key.

## Mapping to acex's constraints

- **Binance always returns an exchange `orderId`** → acex always has a stable exchange id shortly after placement. This weakens the "client-id is the only id we have" argument that drives Hummingbot/Nautilus, except in the brief window before the REST create response / first stream event.
- **Externally / manually placed orders may lack a recognizable client id** (or carry a foreign/auto-generated `newClientOrderId` from Binance). A client-id-*sole* key cannot index these reliably; the exchange-id index can (matches what cryptofeed/freqtrade do, and what Nautilus's external-order-claim path solves). This is the strongest argument against client-id-as-sole-key for acex.
- **No WS order entry yet, but may come later** → the main future-proofing reason for a client-id primary key (correlating an ack before the exchange id is known) is *not yet* in play, but could be. Keeping a client-id index (dual scheme) preserves that option without committing to client-id-only now.
- **acex today already uses a composite key scheme** (observed, descriptive only): `src/managers/order-manager.ts` builds snapshot keys `symbol:${symbol}:order:${orderId}` when an exchange `orderId` is present, falling back to `symbol:${symbol}:client:${clientOrderId}` otherwise (`makeLookupKey`/`upsert` ~lines 57-100, 685-695), and `GetOrderInput`/`cancelOrder` accept *either* `orderId` or `clientOrderId` (`src/types/order.ts:49-53`, order-manager `:314-333`, `:827-833`). This already matches the mainstream dual-identity pattern rather than a single client key.

## Caveats / Not Found

- Did not pull barter-rs, Jesse, or OctoBot source (time/parallelism budget); the 5 frameworks + FIX above are sufficient and span both archetypes (originating OMS vs observer). barter-rs (Rust) and OctoBot can be added on request.
- ccxt does not maintain a persistent order store, so its "key" is really the argument convention of `fetchOrder`/`cancelOrder` (exchange `id`), not an internal index.
- Line numbers are from current master/develop branches as of 2026-06-09 and may drift.
