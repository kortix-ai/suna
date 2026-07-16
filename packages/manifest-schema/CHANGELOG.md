# Changelog

All notable changes to `@kortix/manifest-schema` are documented here. Format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- `validateTriggerAgentRefsV2` is now exported from the package root
  (`@kortix/manifest-schema`), not just from `./index.v2`. It already ran
  internally for both v2 and v3 manifests; this is an additive export so
  external callers (e.g. `apps/api`'s trigger extraction) can reuse the same
  cross-reference check instead of re-deriving it (`packages/manifest-schema/src/index.ts`).
- `harness-source.test.ts` — a drift-guard test asserting `V3_HARNESS_VALUES`
  stays exactly equal to `@kortix/shared`'s `HARNESS_IDS` tuple.
- `json-schema.conformance.test.ts` and additional coverage in
  `validator.coverage.test.ts` bringing v3 fuzz/conformance testing to parity
  with the existing v1/v2 suites.

### Changed

- `V3_HARNESS_VALUES` (`packages/manifest-schema/src/constants.ts`) is now
  derived from the canonical `@kortix/shared` harness descriptor
  (`HARNESS_IDS`, `packages/shared/src/harnesses.ts`) instead of being
  redeclared locally — `export const V3_HARNESS_VALUES = [...HARNESS_IDS] as const;`.
  No behavior change (the value is still `['claude', 'codex', 'opencode',
  'pi']`); this removes a place the two lists could silently drift.

### Fixed

- The published, served schema files under `apps/web/public/schema/` (
  `kortix.schema.json`, `kortix.v1.schema.json`, `kortix.v2.schema.json`,
  `kortix.v3.schema.json`) were regenerated to match the current
  `json-schema.ts` output after a `main` merge left them stale; `src/__tests__/json-schema.sync.test.ts`
  guards against this recurring.
