# State Management

> The repository has no frontend state store. Stateful data lives inside SDK managers.

---

## Overview

Current state ownership is part of the SDK design:

- runtime lifecycle state lives in `src/client/runtime.ts`
- market snapshots and subscriptions live in `src/managers/market-manager.ts`
- account state lives in `src/managers/account-manager.ts`
- order state lives in `src/managers/order-manager.ts`

This is domain state for the SDK, not UI state for a frontend app.

---

## Current Rules

- Do not introduce Redux, Zustand, React Query, or similar frontend state libraries into this package.
- Do not duplicate manager-owned state in a second cache layer inside the SDK.
- Keep UI-specific derived state in the consuming application, not in this repository.

---

## If A Frontend Package Is Added Later

- Treat the SDK as the source of market, account, and order data.
- Keep view state such as selected tabs, filters, dialog visibility, and layout preferences in the frontend package.
- Convert SDK events into render-friendly state at the app boundary, not inside SDK internals.

---

## Evidence From The Current Repo

- `src/client/runtime.ts`
- `src/managers/market-manager.ts`
- `src/managers/account-manager.ts`
- `src/managers/order-manager.ts`

---

## Common Mistakes To Avoid

- Re-implementing manager state in a UI-style store inside the SDK package.
- Mixing transport state with presentation state.
- Letting UI needs dictate changes to adapter internals without a public API reason.
