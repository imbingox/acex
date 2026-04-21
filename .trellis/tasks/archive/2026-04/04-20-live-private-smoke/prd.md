# Add Live Private Smoke Scripts

## Goal
Expose runnable live smoke-test entry points for private account and order flows, and add a dedicated live order smoke script.

## Requirements
- Add package scripts for the existing live account smoke workflow.
- Add a new live order smoke script that exercises order subscription, snapshot access, and reconnect recovery.
- Reuse shared live-private smoke helpers instead of duplicating websocket tracking and polling utilities.
- Keep the scripts limited to read-only private flows that work with existing SDK APIs and Binance PAPI credentials.

## Acceptance Criteria
- [ ] `package.json` exposes `test:live:account` and convenience smoke/soak variants.
- [ ] `package.json` exposes `test:live:order` and convenience smoke/soak variants.
- [ ] `scripts/live-order-smoke.ts` runs with `BINANCE_PAPI_API_KEY` / `BINANCE_PAPI_SECRET`.
- [ ] Account and order live smoke scripts share common helper code for websocket tracking and polling.
- [ ] Lint and type-check pass after the script changes.

## Technical Notes
- This task touches `package.json` and `scripts/`.
- Prefer extracting shared helper code over copying the tracked-websocket/polling logic from `live-account-smoke.ts`.
- The order smoke script should be read-only and validate subscription state, cached open orders, and reconnect semantics.
