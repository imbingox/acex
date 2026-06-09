# Research: Binance clientOrderId behavior (USD-M Futures / Portfolio Margin UM)

- **Query**: Is `clientOrderId` a viable sole primary key for an order store that must also track externally-placed (app/web/other-system) orders on Binance futures? Auto-generation, app/web population, uniqueness/stability, format constraints, spot-vs-UM differences.
- **Scope**: external (Binance official docs) + internal mapping to acex decision
- **Date**: 2026-06-09
- **Venue focus**: USD-M Futures (`/fapi/v1/order`) and Portfolio Margin UM (`/papi/v1/um/order`), `ORDER_TRADE_UPDATE` user-stream event, UM `openOrders`.

## TL;DR decision answer

**No — `clientOrderId` is NOT a safe sole primary key.** Binance documents it as "**A unique id among open orders**" and explicitly allows **reuse** of the same id once the prior order is no longer open ("Orders with the same newClientOrderID can be accepted only when the previous one is filled"). It is therefore unique only within the set of currently-open orders, not over the lifetime of order tracking. The **exchange `orderId` is the only field that is always present, always exchange-assigned, and stable/unique per symbol for the order's lifetime** — it is the natural primary key. `clientOrderId` is always populated (auto-generated when not supplied, and present on app/web/liquidation/ADL/settlement orders too), so it is a useful **secondary lookup key**, but not a sufficient primary key on its own.

---

## Findings

### Q1 — Auto-generation when `newClientOrderId` is omitted

**Documented (official).** Both USD-M and PAPI UM new-order endpoints state for `newClientOrderId`:

> "A unique id among open orders. **Automatically generated if not sent.** Can only be string following the rule: `^[\.A-Z\:/a-z0-9_-]{1,N}$`"

So Binance **does auto-generate** a `clientOrderId` server-side when you don't supply one. The new-order REST response (and the user-stream `ORDER_TRADE_UPDATE` `c` field) is therefore **never empty for normal orders** — it carries either your supplied value or the exchange-generated value.

- The exact format of the auto-generated value is **not documented** as a fixed prefix. Reported by users (secondary, not in the spec): auto-generated futures ids are typically a long alphanumeric token (commonly observed prefixed with `web_`, `android_`, `ios_`, or an opaque random string depending on the originating surface). Treat the *specific* shape as observed-behavior, not contractual.

Sources:
- USD-M New Order: `https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order` — param `newClientOrderId ... A unique id among open orders. Automatically generated if not sent. ... ^[\.A-Z\:/a-z0-9_-]{1,36}$`; response example includes `"clientOrderId": "testOrder"`.
- PAPI UM New Order: `https://developers.binance.com/docs/derivatives/portfolio-margin/trade/New-UM-Order` — same wording, `^[\.A-Z\:/a-z0-9_-]{1,32}$`; response example includes `"clientOrderId": "testOrder"`.

### Q2 — Orders placed via app / website / other sources

**Documented (official).** The `clientOrderId` (`c`) field is part of every order object returned by REST (`openOrders`, query order) and every `ORDER_TRADE_UPDATE` event, regardless of how the order was created. Because Binance auto-generates the value when none is supplied (Q1), **app/web/other-system orders also carry a `c` value** — it is the exchange-generated id for those surfaces.

For **system-generated orders** (liquidation / ADL / settlement), the `c` field carries documented **special prefixes** rather than being empty. From the USD-M `ORDER_TRADE_UPDATE` spec, the `c` field comment:

> `"c": "TEST",  // Client Order Id`
> `// special client order id:`
> `// starts with "autoclose-": liquidation order`
> `// "adl_autoclose": ADL auto close order`
> `// "settlement_autoclose-": settlement order for delisting or delivery`

And the event-behavior notes:

> "If user gets liquidated due to insufficient margin balance: `c` shows as `autoclose-XXX`, X shows as `NEW`. If user has enough margin balance but gets ADL: `c` shows as `adl_autoclose`, X shows as `NEW`."

**Conclusion for Q2:** the `c` field is effectively always populated for futures orders. There is **no documented case where `c` is an empty string** for a live order on USD-M / UM. (Caveat: this is not the same as a *uniqueness* guarantee — see Q3; `adl_autoclose` in particular is a fixed literal, so multiple ADL orders can share the identical `c` value.)

Source: `https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams/Event-Order-Update` (USD-M `ORDER_TRADE_UPDATE`). The PAPI UM order-update event mirrors this `o.c` structure.

### Q3 — Uniqueness & stability (the load-bearing question)

**Documented (official).** `newClientOrderId` is described as "**A unique id among open orders**" — i.e. uniqueness scope is **the set of currently-open orders for the account/symbol, not the account's full history and not time-unbounded.**

The spot endpoint states the reuse rule explicitly (and the futures wording "unique id among open orders" carries the same semantics):

> "A unique id among open orders. Automatically generated if not sent. **Orders with the same `newClientOrderID` can be accepted only when the previous one is filled, otherwise the order will be rejected.**"

Implications:
- **Reuse IS allowed** once the prior order with that id is no longer open (filled or canceled). So the same `clientOrderId` can map to multiple distinct exchange orders over time.
- **Special ids are not unique even concurrently** — `adl_autoclose` is a fixed literal; multiple ADL orders carry the identical `c`.
- Therefore `clientOrderId` is **NOT a stable unique primary key for the lifetime of order tracking.** It is unique only among open orders at a given moment.

By contrast, the exchange **`orderId`** (LONG, e.g. `22542179`) is exchange-assigned, present on every order/event, and unique & stable per symbol for the order's lifetime — the proper primary key. Lookups by `clientOrderId` use the `origClientOrderId` param on query/cancel, and Binance notes that querying a filled/canceled order by `origClientOrderId` yields `"Order does not exist"` once it ages out, reinforcing that `clientOrderId` is an open-order-scoped handle.

Sources:
- Spot trading endpoints (explicit reuse rule): `https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints`
- USD-M / PAPI UM New Order (the "unique id among open orders" wording) — URLs above.
- PAPI UM Query Current UM Open Order (`origClientOrderId` param; "Either orderId or origClientOrderId must be sent"): `https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Query-Current-UM-Open-Order`

### Q4 — `newClientOrderId` format / length constraints (futures)

**Documented (official), and the limits differ by venue:**

| Venue | Regex | Max length |
|---|---|---|
| USD-M Futures (`/fapi/v1/order`) | `^[\.A-Z\:/a-z0-9_-]{1,36}$` | **36** |
| Portfolio Margin UM (`/papi/v1/um/order`) | `^[\.A-Z\:/a-z0-9_-]{1,32}$` | **32** |
| Spot | (no fixed prefix-style regex shown on the trading-endpoints page; documented as "unique id among open orders") | — |

Allowed characters (futures): uppercase/lowercase letters, digits, and `.`, `:`, `/`, `_`, `-`.

> Note the venue difference: a 33–36 char id valid on plain USD-M would be **rejected by PAPI UM** (32-char cap). If acex generates client ids, keep them ≤ 32 to be safe across both surfaces.

### Q5 — Spot vs Futures (UM) differences

- **Reuse rule wording**: spot spells out the reuse-after-fill rule verbatim; futures uses the terser "unique id among open orders" but the open-order-scoped semantics are the same.
- **Length cap**: USD-M = 36, PAPI UM = 32 (see Q4).
- **Special-prefix taxonomy** (`autoclose-`, `adl_autoclose`, `settlement_autoclose-`) is a **futures** `ORDER_TRADE_UPDATE` concept; spot has its own broker/prefix conventions (e.g. `x-` broker tags) and different system-order handling.
- Both venues auto-generate `clientOrderId` when omitted and always return it in responses/streams.

---

## Mapping back to the acex store decision

Current internal keying (observed in code):
- `src/managers/order-manager.ts:64-65` builds a snapshot key `symbol:${symbol}:client:${clientOrderId}` **when a clientOrderId is present**, with a separate orderId-based path otherwise. Lookup helpers also match on either `orderId` or `clientOrderId` (`order-manager.ts:73-99`, `314-333`).
- `src/adapters/binance/private-adapter.ts:573-574` maps `ORDER_TRADE_UPDATE` `payload.i → orderId` and `payload.c → clientOrderId`; `:474` echoes `input.clientOrderId` on placement; cancel/query use `origClientOrderId`/`newClientOrderId` (`:770, :808, :842`).

Given the official facts:
1. **`orderId` is the only lifetime-stable, always-present, exchange-unique field** → it is the correct primary key for a store that must also hold externally-placed (app/web/liquidation/ADL/settlement) orders.
2. **`clientOrderId` is always populated but reusable and only open-order-unique** → safe as a *secondary index* for placement-time correlation (before `orderId` is known) and for user-facing lookups, but it must not be the sole identity. Keying solely on `symbol:client:<clientOrderId>` risks collisions across a reused id and cannot distinguish two ADL orders sharing `adl_autoclose`.
3. A robust scheme: **primary key = `(symbol, orderId)`**; maintain a secondary `clientOrderId → orderId` map that is only authoritative while the order is open, and reconcile/replace the client-id-only provisional record once the first `ORDER_TRADE_UPDATE` (or REST response) supplies the real `orderId`.

## Caveats / Not Found

- The **exact format of the auto-generated `clientOrderId`** (whether `web_`/`android_` prefixes, length, charset) is **not specified** in the official docs — only that one is generated. Any specific shape is observed-behavior-reported-by-users, not contractual; do not parse it.
- The MCP web-search tools referenced in the task brief (`mcp__exa__*`) were **not available** in this environment; findings were gathered by fetching the official `developers.binance.com` doc pages directly (server-rendered HTML) and quoting them. No third-party secondary source was independently fetched here — the user-observed prefix detail is flagged accordingly.
- Binance does not publish a hard statement that `orderId` is globally unique across *all* symbols; the safe, documented guarantee is unique **per symbol**. Hence the recommended primary key `(symbol, orderId)`.
