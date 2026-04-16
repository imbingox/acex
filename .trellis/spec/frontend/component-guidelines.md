# Component Guidelines

> No component system exists in this repository today.

---

## Overview

`acex` is a programmatic SDK, not an application. There are no React, Vue, or HTML component files in the repo, so agents must not invent component conventions.

---

## Current Rules

- Do not add component files to the current SDK package.
- Do not introduce a UI layer as part of an SDK feature unless the task explicitly requires a new frontend package.
- If a first-party frontend package is created later, define component rules from that codebase and update this file immediately.

---

## Props And Composition

No props conventions are defined because no component boundary exists yet.

If a frontend package is introduced later:

- Keep component props typed inside that package.
- Consume the SDK via public exports instead of passing adapter internals through props.
- Document composition patterns after there are at least two real component examples.

---

## Accessibility

No repository-level accessibility standard is documented yet because there is no UI surface to audit.

The first frontend task must define:

- semantic markup expectations
- keyboard interaction requirements
- screen-reader expectations for trading data displays

---

## Evidence From The Current Repo

- `package.json` exports a library entrypoint instead of an app entrypoint.
- `README.md` documents programmatic SDK usage only.
- `src/index.ts` exposes TypeScript APIs, not UI primitives.

---

## Common Mistakes To Avoid

- Hiding a product decision inside a "small component" commit.
- Importing from `src/internal/*` to feed a UI.
- Building docs or demos on private SDK internals instead of public exports.
