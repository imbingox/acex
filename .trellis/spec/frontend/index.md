# Frontend Development Guidelines

> This repository currently has no frontend or UI package. These documents exist to stop AI agents from inventing one.

---

## Current Reality

- `package.json` defines `@imbingox/acex` as a trading SDK and exports only `index.ts`.
- `src/` contains SDK runtime code only: `client/`, `managers/`, `adapters/`, `internal/`, and `types/`.
- The repository has no `.tsx` files, no `components/`, no `app/`, and no frontend build config.
- `CLAUDE.md` contains generic Bun frontend examples, but they are tool defaults, not established project conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Where future frontend code must live and what must stay out of the SDK package | Active |
| [Component Guidelines](./component-guidelines.md) | Rules for the first component layer, if one is introduced later | Active |
| [Hook Guidelines](./hook-guidelines.md) | Rules for keeping React-style hooks out of the SDK package | Active |
| [State Management](./state-management.md) | Current state ownership in the SDK and boundaries for any future UI state | Active |
| [Quality Guidelines](./quality-guidelines.md) | Quality gates and forbidden patterns for frontend-related changes | Active |
| [Type Safety](./type-safety.md) | Type import boundaries for future UI code | Active |

---

## Pre-Development Checklist

Before writing any frontend code:

1. Confirm the task really requires a frontend surface. Most tasks in this repo are backend SDK work and should follow `backend/` specs instead.
2. Confirm the new UI code will live in a dedicated package or app, not inside the current SDK `src/` tree.
3. Update these frontend spec files with the actual stack and patterns before adding the second frontend module.
4. Keep UI code dependent on public SDK exports only.

---

## Quality Check

When reviewing frontend-related changes:

1. Reject changes that add UI files directly under the SDK `src/` tree.
2. Reject imports from `src/internal/*`, `src/client/*`, or exchange adapter internals into UI code.
3. Reject new frontend tooling in the root package unless the task explicitly converts this repo into a multi-package workspace.
4. Confirm any UI example or demo consumes the SDK through `src/index.ts` exports.

---

## Evidence From The Current Repo

- `package.json`
- `src/index.ts`
- `src/client/runtime.ts`
- `src/managers/market-manager.ts`
- `tests/client.test.ts`

---

**Language**: Write future additions in English and document real code, not aspirational architecture.
