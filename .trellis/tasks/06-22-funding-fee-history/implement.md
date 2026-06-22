# Account funding fee history API Implementation Plan

## Preconditions

- Active task: `.trellis/tasks/06-22-funding-fee-history`
- Status must be moved to `in_progress` with `task.py start` before code changes.
- Before editing code, load `trellis-before-dev` and the relevant SDK specs:
  - `.trellis/spec/sdk/index.md`
  - `.trellis/spec/sdk/architecture.md`
  - `.trellis/spec/sdk/public-api.md`
  - `.trellis/spec/sdk/managers.md`
  - `.trellis/spec/sdk/adapters.md`
  - `.trellis/spec/sdk/client-runtime.md`
  - `.trellis/spec/sdk/docs.md`
  - `.trellis/spec/sdk/release-packaging.md`
  - `.trellis/spec/sdk/venues/index.md`
  - `.trellis/spec/sdk/venues/binance.md`
  - `.trellis/spec/sdk/testing.md`

## Implementation Checklist

1. Public types
   - Add funding fee history input/result/entry types to `src/types/account.ts`.
   - Add `fetchFundingFeeHistory()` to `AccountManager`.
   - Add `fundingFeeHistory` to `VenueAccountCapabilities` in `src/types/client.ts`.
   - Ensure root exports still flow through `src/types/index.ts`.

2. Error model
   - Add `ACCOUNT_INPUT_INVALID`.
   - Add `ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED`.
   - Update `docs/errors.md` and any public type docs.

3. Adapter SPI
   - Add `FetchFundingFeeHistoryRequest`, `RawFundingFeeHistoryEntry`, `RawFundingFeeHistoryResult` to `src/adapters/types.ts`.
   - Add optional `fetchFundingFeeHistory()` to `PrivateUserDataAdapter`.

4. Runtime context
   - Add `ClientContext.fetchFundingFeeHistory()` signature.
   - Implement `AcexClientImpl.fetchFundingFeeHistory()`:
     - `assertStarted()`
     - account lookup
     - private adapter lookup
     - capability/hook check
     - private credentials check
     - forward to adapter with account options

5. Account manager
   - Implement input validation:
     - `page` positive integer, default 1
     - `limit` positive integer, default 1000, max 1000
     - `startTs` / `endTs` non-negative safe integers when present
     - `startTs <= endTs` when both present
   - Normalize symbols by trimming? Follow existing symbol conventions; do not invent case conversion for unified symbols.
   - Dedupe symbols while preserving deterministic order.
   - Implement query paths:
     - `symbols === undefined`: account-scan
     - `symbols.length === 0`: empty result
     - `symbols.length <= 5`: per-symbol loop
     - `symbols.length > 5`: account-scan + filter
   - Canonicalize decimal output with `toCanonical()`.
   - Sort by `fundingTime`, `symbol`, `venueTransactionId ?? ""`.
   - Wrap adapter errors with `ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED`.

6. Binance capability
   - Set Binance private adapter `accountCapabilities.fundingFeeHistory = "supported"`.
   - Set Deribit/Juplend/unsupported fallback capabilities to `"unsupported"`.
   - Update venue capability clone/composition tests as needed.

7. Binance adapter
   - Add `BinancePapiUmIncomeEntry` type.
   - Implement `fetchFundingFeeHistory()` in `src/adapters/binance/private-adapter.ts`.
   - Use `toUsdmVenueIdForCommand()` for single symbol outbound mapping.
   - For account-scan, ensure UM catalog is available before mapping response symbols.
   - Request `GET /papi/v1/um/income` with:
     - `incomeType: "FUNDING_FEE"`
     - optional `symbol`
     - optional `startTime`
     - optional `endTime`
     - `page`
     - `limit`
   - Map response array and reject malformed entries.
   - Preserve `raw` shallow copy.

8. Rate limiter
   - Add `papiUmIncomeHistory` plan id.
   - Add request-weight plan cost 30 in PAPI request-weight bucket.
   - Route `GET /papi/v1/um/income` to that plan.

9. Docs
   - Update `docs/managers.md` AccountManager section with API signature and examples.
   - Update `docs/types.md` for new types and capability field.
   - Update `docs/capabilities.md` for Binance support.
   - Update `docs/errors.md` for new error codes.
   - Update README only if manager overview or quick example should mention the feature.

10. Changeset
   - Add a changeset for the public API addition.

## Test Plan

Run before final handoff:

```bash
bun run lint
bun run type-check
bun run test
```

Focused tests to add/update:

- Unit: AccountManager validation rejects invalid page, invalid limit, `limit > 1000`, invalid time range without remote calls.
- Unit: `symbols: []` returns empty result and no context fetch.
- Unit: `symbols.length <= 5` invokes per-symbol context calls; aggregate `truncated` is true when any child result is truncated.
- Unit: per-symbol page 2 can return empty for symbols whose page 1 was not truncated, without duplicating page 1 data.
- Unit: `symbols.length > 5` invokes account-scan once and filters locally; if raw account page is truncated but filtered result is small, public `truncated` is still true.
- Unit: manager canonicalizes `amount`, sorts entries, and carries optional `venueTransactionId`.
- Unit: manager wraps adapter failures as `ACCOUNT_FUNDING_FEE_HISTORY_FETCH_FAILED` with details.
- Unit: runtime unsupported venue / missing hook returns `VENUE_NOT_SUPPORTED`; missing credentials returns `CREDENTIALS_MISSING`.
- Unit: venue capabilities clone includes `account.fundingFeeHistory`.
- Unit: rate limiter maps `GET /papi/v1/um/income` to 30 weight PAPI plan.
- Unit/integration: Binance adapter request includes `incomeType=FUNDING_FEE`, signed timestamp/recvWindow/signature, optional symbol only for per-symbol path.
- Unit/integration: Binance adapter maps `tranId` to `venueTransactionId`, maps venue symbol to unified symbol, preserves raw, and treats `response.length >= limit` as truncated.
- Docs/type tests: public types import from package root.

## Review Gates

- Confirm no public method exposes internal strategy.
- Confirm account-scan docs do not claim per-symbol truncated semantics.
- Confirm no SDK synthetic id is generated.
- Confirm `limit` docs state it is underlying request page size, not merged result max.
- Confirm all public decimal outputs are strings and canonical.

## Rollback Points

- Public API changes are centralized in `src/types/account.ts`, `src/types/client.ts`, and `src/errors.ts`.
- Adapter SPI changes are centralized in `src/adapters/types.ts`.
- Binance runtime changes are isolated to `src/adapters/binance/private-adapter.ts` and rate-limit topology.
- If capability field proves too broad during implementation, revert capability field and keep support detection via `VENUE_NOT_SUPPORTED`; update PRD/design before proceeding.
