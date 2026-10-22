---
recorded: 2026-10-11T16:10:47Z
incident_date: 2026-10-11
---
# A test of catalog-driven behavior pins a fixture or derives its expectation; it never asserts one day's live catalog data

**Rule:** `packages/llm-catalog/src/catalog.generated.json` is regenerated daily by `catalog-refresh.yml` from live models.dev data. A test that runs on the bundled `CATALOG` must not assert an exact model id, host or key the catalog happened to hold on the day the test was written. Pin the test to a fixture catalog and pass it in. Or keep the real catalog and assert the behavior (for example, a heal result is an invokable inference profile) with the exact id derived from the rule under test. A separate smoke assertion against the real catalog may check only the invariant.

**Trigger surface:** Writing or editing a test that imports `CATALOG` or reads the generated catalog, in `apps/api/src/llm-gateway/models`, `packages/sdk/src/react` or `packages/llm-catalog`. Also reading a red `Catalog refresh` run or a red packages lane right after a `chore(catalog): refresh model seeds` commit.

**Incident:** 2026-10-09 to 2026-10-11, two classes. (1) `provider-registry.test.ts` asserted a provider that models.dev later removed and a host it later moved; the daily `Catalog refresh` run failed on each run until #9572 moved those tests to a fixture catalog. (2) Refresh #9573 added `global.xai.grok-4.6` to the Bedrock list. `packages/sdk/src/react/bedrock-invokable.test.ts` asserted `global.anthropic.claude-opus-5` for a pinned `xai.grok-4.6`; the heal now returns the model's own `global.` twin, which is correct. The test failed on a clean `dev` checkout, so every branch that merged `dev` recorded a red packages lane and a red attestation. The fix derives the expected id from the heal rule (own `global.` twin, else regional twin, else catalog default) and keeps the three intent assertions.

**Enforcement:** `catalog-refresh.yml` ("Run the seed-dependent unit tests") runs `packages/llm-catalog`, `apps/api/src/llm-gateway/models` and two `apps/web` test paths on the regenerated catalog, and fails the refresh before it merges. It does not run `packages/sdk`, so class (2) reached `dev` first and surfaced in the packages lane. Follow-up: add the SDK catalog tests to that step; the step's `pnpm install --filter` list must then include `@kortix/sdk`. No static check detects an exact id in a test. A reviewer checks every new assertion that touches `CATALOG`.
