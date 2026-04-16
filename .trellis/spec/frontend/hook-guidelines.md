# Hook Guidelines

> No React-style hooks exist in this repository today.

---

## Overview

This SDK has stateful logic, but it is implemented with managers and infrastructure primitives rather than framework hooks.

---

## Current Patterns

Stateful reuse currently lives in:

- `src/client/runtime.ts` for lifecycle orchestration
- `src/internal/managed-websocket.ts` for connection management
- `src/internal/async-event-bus.ts` for async event delivery

These are not hooks and should not be wrapped in React naming or semantics inside the SDK package.

---

## Current Rules

- Do not add files named `use*.ts` or `use*.tsx` to this package.
- Do not move SDK lifecycle logic into framework-specific abstractions.
- If consumers want hooks such as `useL1Book`, they should implement them in their own frontend package on top of the public SDK API.

---

## Naming Guidance For Future UI Code

If a frontend package is introduced later:

- Reserve `use*` names for real framework hooks only.
- Keep hook responsibilities thin: subscribe through the SDK, then adapt values for rendering.
- Document data fetching and subscription cleanup patterns here once they exist in code.

---

## Evidence From The Current Repo

- `src/client/runtime.ts`
- `src/internal/managed-websocket.ts`
- `src/internal/async-event-bus.ts`

---

## Common Mistakes To Avoid

- Adding React hooks to a package that has no React dependency.
- Coupling websocket lifecycle to component mount state inside the SDK.
- Letting a UI abstraction leak back into manager or adapter layers.
