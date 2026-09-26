---
recorded: 2026-09-25T20:34:23Z
incident_date: 2026-09-25
---
# Gate a preview PR's merge on the tested preview-status for its head, not the deploy job

**Rule:** Before merging a `preview`-labelled PR, read the latest `preview-status`
comment. It must name the current head SHA and report a tested pass. A green
"Deploy full self-host preview and run end-to-end tests" check is not proof: a
push redeploy skips `pnpm test -- --target-full` and still reports success.
After updating a branch from `main`, dispatch the preview again
(`gh workflow run deploy-preview.yml -f pr_number=<n> -f provider=platinum`)
and wait for its tested result.

**Trigger surface:** merging an `@kortix/sdk` or other client-facing runtime
contract PR, or writing any automated merge gate for `preview`-labelled PRs.

**Incident:** 2026-09-25, #7630 (SDK transport seam). An automated merge gate
merged it on green checks after the branch was updated from `main`. The
comment for that head said `Preview environment - live; NOT tested`; the last
tested preview was two commits older. A real-session check on dev after the
merge passed 8 of 8 flows, so nothing reverted, but the preview-before-merge
rule was broken.

**Enforcement:** none yet: make the deploy-preview job report its check as
skipped or neutral when it skips `--target-full`, so a check-only gate cannot
read a redeploy as a tested pass.
