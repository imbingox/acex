# Implement Order Private Stream

## Goal
Implement live order state maintenance for private accounts by wiring Binance private user-data events into the SDK order manager.

## Requirements
- Reuse a single private Binance user-data stream per account instead of opening a separate order websocket.
- Add order adapter contracts for bootstrap and incremental private order updates.
- Bootstrap order state from REST before reporting the order subscription as ready.
- Apply private websocket order updates to the in-memory order cache and emit order events.
- Keep account private streaming behavior compatible with the shared private stream approach.
- Preserve layer boundaries: adapter owns exchange-specific parsing and transport, manager owns normalized snapshots and events, runtime owns orchestration.

## Acceptance Criteria
- [ ] `subscribeOrders()` performs bootstrap + stream wiring instead of marking the subscription healthy immediately.
- [ ] Order snapshots are updated from Binance private events and accessible via `getOrder()` / `getOpenOrders()`.
- [ ] Disconnect/reconnect transitions update order status consistently and recover the stream.
- [ ] Account and order subscriptions can coexist on one private stream per account.
- [ ] Relevant tests cover bootstrap, updates, reconnect handling, and cleanup.

## Technical Notes
- Change spans `types`, `adapters`, `managers`, `client`, and `tests`.
- This is a cross-layer feature and must follow the backend code-organization and type-safety specs plus the cross-layer/code-reuse thinking guides.
- Existing account private stream tests currently fail, so implementation must reconcile current code with intended private-stream behavior before extending order behavior.
