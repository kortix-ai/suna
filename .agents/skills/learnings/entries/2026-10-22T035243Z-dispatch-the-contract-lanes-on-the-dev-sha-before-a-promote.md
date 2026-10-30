---
recorded: 2026-10-22T03:52:43Z
incident_date: 2026-10-22
---
# Dispatch the contract lanes on the dev SHA before a Promote when dev moved since the last green nightly run

**Rule:** Before a Promote dispatch, compare the dev SHA with the last green nightly `Tests` run. When PRs merged after it, dispatch `tests.yml` on the dev SHA (the contract lanes, about 15 minutes) and fix every red lane on dev first. Also run a CRITICAL/HIGH `trivy fs` scan of the tree, because advisories published overnight fail the release scanners on code nobody touched.

**Trigger surface:** dispatching `promote.yml`, especially after a day of merges or a default change (a flag default, a refused input, a static list moved to a live source).

**Incident:** v0.14.5, 2026-10-22. The 14 pre-Promote tripwires passed (after PR #10670). The first release suite still failed: `packages-api` 19 tests, `core-db` 12 tests plus 1 SDK test, `packages-rest` (i18n audit, reskin e2e, 2 UI tests), and Trivy/CodeQL. Cause: PRs #10643, #10647, #10664, #10666, #10669 and #10576 merged after the last green nightly. They changed behavior that only release-lane tests read. Fixes: PRs #10676–#10683 and #10679. Cost: 3 Promote dispatches and 2 hours. Deploy Prod attempt 1 then failed at pnpm install (Corepack got npm `503`); rerunning the failed jobs deployed it.

**Enforcement:** none yet. To build: `promote.yml` refuses a dev SHA without a green `tests.yml` run on that SHA, or dispatches one and waits for it.
