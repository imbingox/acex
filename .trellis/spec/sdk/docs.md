# Documentation Contract

## Scope

This spec covers user-facing documentation in `README.md`, `docs/*.md`, and non-user-facing task tracking in `todo/`.

## Current Structure

- `README.md`: concise package entry, current runtime-supported venue scan, install command, minimal demo, and docs entry links.
- `docs/api.md`: documentation index, not a long single-file manual.
- `docs/quickstart.md`: setup and common usage flows.
- `docs/capabilities.md`: current runtime-supported venue capability matrix.
- `docs/managers.md`: Client / manager API behavior.
- `docs/types.md`: public type and field quick reference.
- `docs/errors.md`: `AcexError`, error codes, and capability boundaries.
- `todo/improvement-todo.md`: internal improvement backlog; keep it out of `docs/` so user docs stay clean.

## Rules

- Public docs must describe current runtime behavior from code, not roadmap or exchange website completeness.
- README capability tables should list only currently runtime-supported venues. Type-only venues may appear in type reference where they are part of the public `Venue` union.
- When public types or manager APIs change, update `docs/types.md`, `docs/managers.md`, and the relevant capability/error docs in the same change.
- When docs are split or renamed, update README links, relative markdown links, `package.json.files`, and `.changeset/config.json.changedFilePatterns`.
- npm package docs must include every file linked from `README.md` or `docs/api.md`.
