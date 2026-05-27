---
"@imbingox/acex": minor
---

Add venue-based account registration and Juplend read-only lending account support. `Exchange` is renamed to `Venue`, account risk now uses unified `riskRatio`, and `RegisterAccountInput` is venue-specific so Juplend requires `credentials.apiKey` plus `options.walletAddress` with optional `positionId` filtering. Juplend account polling exposes lending balance/risk facets, replaces full snapshots to clear closed positions, and includes live smoke coverage.
