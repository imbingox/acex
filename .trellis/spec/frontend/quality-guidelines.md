# Quality Guidelines

> There is no frontend package to lint or test today. Quality checks focus on preventing accidental UI code from leaking into the SDK package.

---

## Repository Quality Gates

The current project-level checks are defined in `package.json`:

- `bun run lint`
- `bun run type-check`
- `bun test`

These validate the SDK package. They do not establish a frontend framework stack.

---

## Forbidden Patterns

- Adding frontend files directly under the SDK `src/` tree.
- Adding frontend-only tooling to the root package without an explicit workspace or app plan.
- Importing private SDK internals into demos, dashboards, or future UI code.
- Treating generic examples in `CLAUDE.md` as project-approved frontend architecture.

---

## Required Patterns

- Keep frontend work in a dedicated package or app once it exists.
- Consume the SDK through public exports only.
- Update this frontend spec directory as soon as real frontend code is introduced.

---

## Review Checklist

When a change mentions UI, demo screens, dashboards, or browser rendering:

1. Does the change introduce a dedicated frontend boundary instead of modifying the SDK `src/` tree?
2. Does the code depend only on public SDK exports?
3. Are `BigNumber` values formatted at the presentation boundary rather than truncated earlier?
4. Are frontend conventions documented here before the pattern spreads?

---

## Evidence From The Current Repo

- `package.json`
- `README.md`
- `src/index.ts`
- `tests/client.test.ts`
