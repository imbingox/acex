# Venue Specs

Venue specs capture venue-specific behavior that should not be generalized into the SDK-wide adapter or manager contracts.

## Files

| Venue | Spec | Runtime scope |
|---|---|---|
| Binance | [binance.md](./binance.md) | public market data, PAPI account/order, fee, risk limit, rate limits |
| Deribit | [deribit.md](./deribit.md) | public option catalog and L1 Book only |
| Juplend | [juplend.md](./juplend.md) | read-only lending account view |

## Rules

- Adding a runtime venue requires a new `venues/<venue>.md` file.
- Venue specs must stay consistent with `docs/capabilities.md`, adapter capabilities, fixtures in `tests/support/exchanges/`, and live smoke scripts where applicable.
- Common adapter/lifecycle/error rules belong in `../adapters.md`, `../client-runtime.md`, or `../public-api.md`; venue files should only contain exchange- or protocol-specific contracts.
