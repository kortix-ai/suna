---
recorded: 2026-10-21T03:07:10Z
incident_date: 2026-10-20
---
# Run the release suite's fast tripwires on dev HEAD before every Promote dispatch

**Rule:** Before each Promote to Production dispatch, run the seconds-long tripwires the release suite fails on against the `dev` HEAD you are promoting: `apps/api` eslint, `tests/unit` (vitest), route coverage (`runCoverage()`), kortixd `architecture-boundaries.test.ts`, the api tripwires (`unit-request-primitives-tripwire`, `mcp/cli`, `unit-audit-route-labels`, `unit-mock-module-targets`, `sql-correlated-subquery-guard`), `packages/sdk` `public-type-surface.test.ts`, `packages/ui` `gen-exports.mjs --check` / `gen-i18n-catalog.mjs --check` / `stylesheet-coverage` / module layers, `i18n-catalogs.mjs check`, and `packages/db` `scripts/generate.ts` (must say "No schema changes"). Fix what is red on `dev` first; then dispatch.

**Trigger surface:** dispatching `promote.yml`, or re-promoting after a red release suite.

**Incident:** v0.14.4 (release PR #10489, 2026-10-20 13:40 → 2026-10-21 03:02 UTC) took 10 Promote dispatches. About 40 PRs merged into `dev` during the day; each one-hour gate cycle found a fresh batch of breakage that nothing on `dev` runs: stale generated files (audit doc, SDK type snapshot, `@kortix/ui` deep exports and `styles.css`, drizzle snapshot), tripwires (UUID regex, unqualified outer SQL column, MCP CLI decisions, module layers), test stubs pinned to moved files, and two real regressions the release suite caught: #10459 made every project reload show "Opening your project" (fixed in #10584), and #10566 dropped the configured default from `GET /model-access` (fixed in #10596). Once the tripwires above ran locally before each dispatch, the next two runs had no contract-lane failure from them. Drata (`compliance-as-code-action`) also became advisory in the release gate by owner decision (#10601) after #10547 surfaced a CRITICAL IaC finding visible only in the Drata dashboard; restore it to blocking when that finding is fixed.

**Enforcement:** none yet: a `dev` pre-promote job that runs exactly this list in under 5 minutes and that `promote.yml` waits on.
