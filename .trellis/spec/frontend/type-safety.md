# Type Safety

> There is no frontend type layer in this repository today. The relevant rule is where future UI code may import types from.

---

## Overview

The SDK already exposes public contracts through `src/types/*` and `src/index.ts`. Any future frontend code must depend on those public contracts instead of reaching into implementation details.

---

## Current Rules

- Import SDK-facing types from public exports or `src/types/*`.
- Do not import from `src/internal/*`, `src/client/*`, or adapter-private files in UI code.
- Preserve `BigNumber` values until the presentation boundary. Format them for display there instead of converting early to `number`.

---

## Current Type Sources

- `src/types/client.ts` defines client-facing contracts.
- `src/types/market.ts` defines market-facing public data structures.
- `src/types/account.ts` and `src/types/order.ts` define account and order contracts.

---

## If A Frontend Package Is Added Later

- Treat the SDK public API as the only stable import surface.
- Add package-local view models only when the raw SDK contract is not directly renderable.
- Document runtime validation choices here if UI input parsing is introduced.

---

## Forbidden Patterns

- Importing implementation details from `src/internal/managed-websocket.ts`.
- Using `any` to paper over exchange payload differences in UI code.
- Converting precise money and quantity values to floating-point numbers before formatting.

---

## Evidence From The Current Repo

- `src/index.ts`
- `src/types/client.ts`
- `src/types/market.ts`
- `README.md`
