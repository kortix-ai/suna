---
recorded: 2026-10-11T20:32:39Z
incident_date: 2026-10-11
---
# A PR into dev that renames a visible label or accessible name, or folds UI away, updates every browser journey that reads it in the same PR

**Rule:** Before you merge a PR that changes a visible string, an accessible name, or what a settled view shows without a click, search `tests/e2e/specs` for the old text (`rg -n '<old text>' tests/e2e`) and update every journey that reads it in the same PR. If a journey reads it, add the `test` label once before the merge, because a PR into `dev` runs no browser lane.

**Trigger surface:** Changing copy, `aria-label`s or accessible names, folds or disclosures, or default open/closed state in `apps/web`.

**Incident:** 2026-10-11, staging promotion #9595 for v0.13.54. Two PRs merged into `dev` with green local `pnpm test` runs, and both broke browser journeys that only CI runs: #9558 folded a settled turn's work behind a "Worked for" row (journey 34: 3 tests, 3/3 attempts), and #9566 renamed the mobile sidebar toggle from "Collapse sidebar" to "Open sidebar" (journey 27). The staging PR's browser lanes caught both. The fix and re-promotion cost one more local suite run plus one more staging CI cycle (~35 min each).

**Enforcement:** The browser lanes on the PR into `staging` (`.github/workflows/tests.yml`) catch it, but only at release time. No check runs earlier: a pre-merge check that maps changed strings to the journeys that read them does not exist yet.
