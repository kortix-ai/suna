---
recorded: 2026-10-09T22:29:08Z
incident_date: 2026-10-09
---
# A PR that touches content must regenerate the content-timestamp manifest in the same PR: the squash merge rewrites the committer date the manifest recorded

**Rule:** When a PR edits anything under `apps/web/content/**` or a marketing source page listed in `MARKETING_SOURCES`, run `node apps/web/scripts/build-content-timestamps.mjs` and commit the regenerated `apps/web/src/lib/seo/content-timestamps.json` in the same PR. Never hand-edit the JSON.

**Trigger surface:** Editing docs or marketing pages in `apps/web`, and any branch that merges `dev` after such a PR landed — the next `core`/`package-quality` lane run goes red on `apps/web/scripts/build-content-timestamps.test.mjs`.

**Incident:** 2026-10-09, a fix PR touched four `apps/web/content/docs/*.mdx` files without regenerating the manifest. The manifest records each content file's last commit's **committer** date; the squash merge to `dev` rewrote those dates, so the committed manifest no longer matched `git log -1 -- <file>` on `dev` and the test failed on `dev` itself, red on every branch that merged it (found while re-attesting a pool-ceiling PR after a `dev` merge).

**Enforcement:** `apps/web/scripts/build-content-timestamps.test.mjs` ("matches the current git history when full history is available") in the `core` and `package-quality` lanes. It compares the committed manifest against `git log` dates, so it catches the drift — but only after the squash merge already landed it on `dev`; regenerate in the PR so it never gets there.
