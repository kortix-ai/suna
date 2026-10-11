---
recorded: 2026-10-11T17:40:10Z
incident_date: 2026-10-11
---
# Keep regenerating the content-timestamp manifest in the same PR: the check excuses only the squash commit that carries the manifest

**Rule:** The rule of the 2026-10-09 entry stands: a PR that touches `apps/web/content/**` or a `MARKETING_SOURCES` page runs `node apps/web/scripts/build-content-timestamps.mjs` and commits the regenerated `apps/web/src/lib/seo/content-timestamps.json` in the same PR. The check now tolerates exactly one consequence of a PR that follows it. The squash commit carries content and manifest together and gets a committer date the manifest could not know.

**Trigger surface:** Editing docs or marketing pages in `apps/web`, and reading a red `apps/web/scripts/build-content-timestamps.test.mjs` on `dev`.

**Incident:** 2026-10-11, `dev` went red three times on the `core` and `package-quality` lanes. Two squash merges carried content plus a regenerated manifest, and the strict comparison failed on the squash commit's committer date. One squash merge carried content and no manifest, which breaks the rule. Each time the next PR to regenerate the manifest turned `dev` green.

**Enforcement:** `staleContentTimestamps` in `apps/web/scripts/build-content-timestamps.mjs` skips an entry only when the content file and the manifest share their last commit. Content whose last commit is newer than the manifest's still fails. `apps/web/scripts/build-content-timestamps.test.mjs` proves both cases on a temporary git repository.
