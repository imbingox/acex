# Binance private data reconciliation research

## Sources

* Binance Portfolio Margin Trade: Query All Current UM Open Orders — https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Query-All-Current-UM-Open-Orders
* Binance Portfolio Margin Trade: Query UM Order — https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Query-UM-Order
* Binance Portfolio Margin Trade: Query All UM Orders — https://developers.binance.com/docs/derivatives/portfolio-margin/trade/Query-All-UM-Orders
* Binance Portfolio Margin User Data Streams: Event Futures Order Update — https://developers.binance.com/docs/derivatives/portfolio-margin/user-data-streams/Event-Futures-Order-update
* Binance Portfolio Margin Account: Account Balance — https://developers.binance.com/docs/derivatives/portfolio-margin/account/Account-Balance
* Binance Portfolio Margin Account: Account Information — https://developers.binance.com/docs/derivatives/portfolio-margin/account/Account-Information
* Binance Portfolio Margin Account: Query UM Position Information — https://developers.binance.com/docs/derivatives/portfolio-margin/account/Query-UM-Position-Information

## Findings

* `GET /papi/v1/um/openOrders` returns current UM open orders. If `symbol` is omitted, Binance returns open orders for all symbols in an array. Request weight differs materially: single symbol is weight `1`; omitting `symbol` is weight `40`.
* `GET /papi/v1/um/order` checks a single UM order's status by `symbol` plus either `orderId` or `origClientOrderId`. Request weight is `1`.
* `GET /papi/v1/um/allOrders` returns UM orders for a mandatory `symbol`, optionally filtered by `orderId`, `startTime`, `endTime`, and `limit`. Request weight is `5`.
* Futures order stream events use `ORDER_TRADE_UPDATE`; the payload includes order status (`X`), execution type (`x`), symbol (`s`), order id (`i`), client order id (`c`), cumulative filled quantity (`z`), average price (`ap`), and position side (`ps`).
* `GET /papi/v1/balance` returns Portfolio Margin account balances and can be used as the authoritative current balance set for full account reconciliation.
* `GET /papi/v1/account` returns portfolio margin account state including equity, margin, account status, and update time. Request weight is `20`.
* `GET /papi/v1/um/positionRisk` returns UM position state including `positionAmt`, mark price, unrealized PnL, liquidation price, leverage, side, notional, and `updateTime`. Request weight is `5`.

## Implications For This Repo

* The existing `bootstrapOpenOrders()` call already maps `/papi/v1/um/openOrders` into `RawOrderUpdate[]`.
* The existing `OrderManagerImpl.onPrivateOrderBootstrap()` performs full replacement, so it can clear stale local open orders when REST returns an empty array. That is not enough for lifecycle correctness because it drops the final order state from the cache.
* Order reconciliation should treat `openOrders` as current-open-set detection, then use single order query or `allOrders` to backfill terminal states for local orders that disappeared from the open set.
* `allOrders` is symbol-scoped, so a time-window backfill needs a known symbol set. Existing local open orders provide symbols for stale-open cleanup; full external-order discovery may require broader symbol tracking or periodic account-level openOrders.
* Account/risk/position incremental refresh already exists in the current adapter shape via `refreshAccount()`, but full account reconciliation needs a separate authoritative snapshot path that includes balances. For Binance PAPI UM, that means `/papi/v1/balance` + `/papi/v1/account` + `/papi/v1/um/positionRisk`.
* Full account reconciliation can treat the successful all-account balance and all-symbol position responses as the current authoritative balance/UM position set. Missing local balances or positions should be cleared only on this full snapshot path, not on the fast incremental `refreshAccount()` path.
* Market data is intentionally out of scope for this task because the current L1/funding streams already use WS freshness and reconnect semantics; the reconciliation need here is private lifecycle/account state where WS is incremental and REST can provide authoritative correction.
