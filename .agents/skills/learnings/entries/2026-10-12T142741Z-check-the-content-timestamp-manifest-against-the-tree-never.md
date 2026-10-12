---
recorded: 2026-10-12T14:27:41Z
incident_date: 2026-10-12
---
# Check the content-timestamp manifest against the tree, never against git committer dates

**Rule:** A check on `apps/web/src/lib/seo/content-timestamps.json` reads the tree only: the entry keys equal the content sources on disk and every value is an ISO instant. It never compares dates to `git log`. Supersedes the 2026-10-09 and 2026-10-11 rules to regenerate the manifest in the same PR. `next build` regenerates the manifest in any full-history checkout anyway.

**Trigger surface:** Editing docs or marketing pages in `apps/web`, and reading a red `apps/web/scripts/build-content-timestamps.test.mjs` on `dev`, `staging` or a promotion branch.

**Incident:** 2026-10-09 to 2026-10-12: committer dates change on every squash merge and differ between `dev` and `staging`. The history-dependent check turned `core` and `package-quality` red on `dev` and on promotion branches, three times in four days.

**Enforcement:** `invalidContentTimestamps` in `apps/web/scripts/build-content-timestamps.mjs`, asserted by `apps/web/scripts/build-content-timestamps.test.mjs` in the `core` and `package-quality` lanes.
