---
recorded: 2026-09-27T11:36:25Z
incident_date: 2026-09-27
---
# Read every batch of a batched test runner before quoting a pass count

**Rule:** `apps/api/scripts/test.sh` runs the unit suite in 12 batches (939 files) and prints one `N pass / M fail` block per batch. Before quoting a result, check the script's exit code and read every batch's block, for example with `grep -E "^API unit batch|^ *[0-9]+ (pass|fail)$"`. Never quote the last block (`tail`) as the suite.

**Trigger surface:** writing a test count into a PR description, a commit message or a handoff after running a batched or sharded runner (`scripts/test.sh`, `pnpm test` lanes, Playwright shards).

**Incident:** 2026-09-27, latency PRs #7801, #7811 and #7818 each claimed "`scripts/test.sh` 407–435 pass / 0 fail". Those were only batch 12 of 12. The full run was 12,016 pass / 1 fail, and the script exited 1. The failure (`unit-account-state-revenuecat`, a timeout) is pre-existing on `main` and was not caused by those PRs; their CI `core` and `packages` lanes ran the full suite green. The descriptions were wrong, and corrections were posted on each PR.

**Enforcement:** none yet. The enforcer to build: `scripts/test.sh` prints one aggregate `TOTAL pass / fail` line at the end, so the last line is the whole suite.
