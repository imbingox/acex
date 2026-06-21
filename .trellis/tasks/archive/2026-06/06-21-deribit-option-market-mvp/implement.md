# Deribit 期权行情 MVP 实施计划

## 执行顺序

1. Public type foundation
   - Update `src/types/shared.ts`:
     - add `deribit` to `SUPPORTED_VENUES`
     - add `option` to `MarketType`
     - add top-level `CreateClientOptions.venues?: Venue[]`
     - add `DeribitMarketRuntimeOptions` with `underlyings?: string[]`
   - Update `src/types/market.ts`:
     - introduce `BaseMarketDefinition`, `StandardMarketDefinition`, `OptionMarketDefinition`, and `MarketDefinition` union
     - add option discovery filters and `OptionPair`
     - add `listOptionMarkets()` / `listOptionPairs()` to `MarketManager`
     - add `no_quote` to market status reason union
   - Update `src/types/index.ts` exports only if needed; keep existing barrel style.

2. Runtime venue selection and capability aggregation
   - Refactor `src/client/runtime.ts` adapter factory registration so top-level `venues` can select runtime-supported venues.
   - `venues` omitted selects all runtime-supported venues.
   - Empty `venues` and type-only venues are configuration errors.
   - Add Deribit factory, wired with `market.venues.deribit`.
   - Update `src/client/venue-capabilities.ts` so market-only read-only adapters can report `readOnly: true` and `order.reason: "read_only"` without a private adapter.

3. Deribit adapter
   - Add `src/adapters/deribit/adapter.ts`.
   - Add `src/adapters/deribit/market-catalog.ts`.
   - Add `src/adapters/deribit/stream-protocol.ts`.
   - Implement Deribit catalog loading with fixture/fake-transport friendly boundaries.
   - Normalize option definitions per PRD and design.
   - Keep SDK symbol to Deribit `instrument_name` mapping for stream subscription.
   - Implement `createL1BookStream()` using public `quote.<instrument>` channel.
   - Implement unsupported defensive `createFundingRateStream()` because `MarketAdapter` currently requires it, but Deribit capability must remain `fundingRate: "unsupported"`.

4. Subscription multiplexer / no_quote plumbing
   - Extend `src/internal/subscription-multiplexer.ts` with status-only route support that does not resolve ready.
   - Extend `src/adapters/types.ts` with `RawL1NoQuoteUpdate` and `L1BookStreamCallbacks.onNoQuote`.
   - Update Binance adapter code only as needed for signature compatibility; behavior must stay unchanged.
   - Update `src/managers/market-manager.ts`:
     - track per-channel last input timestamps
     - handle `onNoQuote`
     - keep last complete L1 top-level fields/version unchanged on no_quote
     - update snapshot and aggregate status `lastReceivedAt`
     - publish `market.status_changed`, not `l1_book.updated`

5. Option discovery manager methods
   - Implement `listOptionMarkets()` and `listOptionPairs()` in `src/managers/market-manager.ts`.
   - Keep methods pure read-only over currently loaded catalog.
   - Add sorting/filter helpers, preferably local to market manager unless a reusable helper is clearly justified.

6. Type fallout and fee defaults
   - Update Binance internal `BinanceMarketDefinition` to extend `StandardMarketDefinition` or `BaseMarketDefinition`.
   - Fix all `MarketType` exhaustive records and branches.
   - Explicitly handle `option` in fee defaults or convert defaults to partial with a safe fallback.

7. Tests
   - Add unit tests for Deribit catalog normalization and stream protocol.
   - Add market manager tests for option filters, pair grouping, stable sorting, and no_quote behavior.
   - Add runtime/capability tests for top-level `venues` default and narrowed runtime.
   - Ensure default tests use fixtures/fakes only; no live Deribit network.

8. Docs and specs
   - Update `docs/api.md` and README with Deribit option usage.
   - Update backend specs touched by new contracts:
     - `adapter-contract.md`
     - `venue-capabilities.md`
     - optionally `market-subscription-leases.md` if ready/no_quote wording changes
   - Add a changeset because public types and runtime capabilities change.

## Validation

Run before reporting implementation complete:

```bash
bun run lint
bun run type-check
bun run test
```

If full `bun run test` is too slow during iteration, narrower unit tests are acceptable mid-run, but final implementation must run the full command or report exactly why it could not.

## Risk Points

- Do not make no_quote a normal multiplexer data event; that would incorrectly resolve `lease.ready`.
- Do not expose Deribit `ticker` Greeks / IV / mark price as stable public fields.
- Do not make Deribit option L1 price look like USDT; document that it is in `premiumCurrency`.
- Do not make `underlyings` a generic acex currency concept; it is a Deribit market config mapped to Deribit `currency` internally.
- Do not let `venues` omitted mean `SUPPORTED_VENUES`; it means runtime-supported venues only.
- Do not require a Deribit private adapter just to report read-only public market capability.
- Preserve existing Binance symbol, catalog, L1 and funding behavior.

## Suggested Implementation Slices

1. Types/runtime/capabilities with tests.
2. Deribit catalog with tests.
3. Option discovery API with tests.
4. Multiplexer no_quote + Deribit L1 stream with tests.
5. Docs/specs/changeset and full validation.
