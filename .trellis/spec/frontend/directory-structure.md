# Directory Structure

> There is no frontend directory structure in this repository today. The only documented rule is where frontend code must not go.

---

## Overview

This repo is a single-package SDK. The root `src/` tree is reserved for SDK runtime code and shared public types.

Current layout:

```text
src/
├── adapters/
├── client/
├── internal/
├── managers/
└── types/
tests/
docs/
```

---

## Current Rules

- Do not add `src/components`, `src/hooks`, `app/`, `pages/`, or browser assets to this package.
- Do not mix demo UI code with SDK runtime code under `src/`.
- If the project gains a frontend, create a dedicated top-level package or app first, then document its real structure here.

---

## Naming Conventions

- Current source names describe SDK roles: `runtime`, `manager`, `adapter`, `types`, `internal`.
- UI-oriented names such as `Button.tsx`, `Dashboard.tsx`, or `useMarkets.ts` do not belong in this package today.
- If a future frontend package is introduced, keep its naming rules local to that package instead of reusing SDK folder names blindly.

---

## Evidence From The Current Repo

- `src/client/runtime.ts` shows orchestration code living under `client/`, not a UI shell.
- `src/managers/market-manager.ts` shows domain state living under `managers/`.
- `tests/client.test.ts` shows the repository tests SDK behavior, not rendered components.

---

## Common Mistakes To Avoid

- Adding a quick demo screen directly under the SDK `src/` tree.
- Treating the repository root as both a library package and an application package.
- Creating frontend folders before the project has decided on a real app boundary.
