# Claude Code Compatibility Instructions

This file is kept only as a compatibility shim for Claude Code.

Authoritative project instructions live here:
- `AGENTS.md`
- `.trellis/workflow.md`
- `.trellis/spec/`
- `.trellis/workspace/`

For Claude Code sessions:
- Start with `/trellis:start`
- Follow `AGENTS.md` first
- Treat `.trellis/workflow.md` as the canonical workflow
- Read the relevant `.trellis/spec/...` docs before making changes
- Use the active Trellis task context when one exists
- Default to Chinese when talking to the user and when writing human-facing project docs such as `prd.md`, task notes, design docs, review summaries, and session journals
- Technical terms, commands, code identifiers, and API names may remain in English

If this file conflicts with `AGENTS.md` or anything under `.trellis/`, those files win.

Project command defaults:
- `bun run lint`
- `bun run type-check`
- `bun run test`
