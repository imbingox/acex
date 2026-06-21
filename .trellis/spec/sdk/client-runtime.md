# Client Runtime

## Scope

Client runtime rules cover `createClient()`, venue runtime selection, lifecycle, account registration, health snapshots, and cross-manager coordination.

## Required Reads

- [architecture.md](./architecture.md) for layer boundaries and `ClientContext` ownership.
- [public-api.md](./public-api.md) for venue capability snapshots, errors, and public type changes.
- [adapters.md](./adapters.md) when runtime changes adapter registration or transport behavior.

## Core Rules

- `src/client/runtime.ts` remains the orchestration layer: lifecycle, account registry, adapter registry, capability aggregation, health aggregation, and manager/coordinator dispatch. Domain state stays in managers.
- `CreateClientOptions.venues` is the only runtime venue selection entry point. Venue-specific `market.venues.*` / `account.venues.*` options configure selected venues; they do not enable venues by themselves.
- `createClient()` does not establish network connections. Subscription APIs require `start()`; catalog/fetch/capability queries may run before `start()` where public contracts allow it.
- `stop(options?)` must respect the public `StopOptions` contract and avoid writing stale in-flight results after generation changes.
- Runtime capability queries must be clone-safe and must not expose mutable adapter-owned arrays.
