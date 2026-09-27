---
recorded: 2026-09-26T15:55:49Z
incident_date: 2026-09-08
---
# The Vercel deploy is the only gate on Edge Function size, and it runs after the release candidate is cut

**Rule:** never import a translations bundle or the `@kortix/sdk` barrel from a
Next.js Edge route (`export const runtime = 'edge'`) under `apps/web/src/app`.
A social-preview image route or any other latency-insensitive route belongs on
the Node runtime, which has no size gate. Nothing local, no PR lane, and no
self-host preview (no Vercel) catches an Edge Function over Vercel's 4.02 MB
limit — only the staging/prod Vercel deploy step does, after the release
candidate has already been cut.

**Trigger surface:** adding an import to any `runtime = 'edge'` route, or
routing UI copy through a server-side translation loader from one.

**Incident:** v0.13.12, `deploy-staging` run 34165900416: `api/og/template`
went from under the limit to 5.51 MB after #7160 routed its strings through
`getHardcodedUiServerText` (638 KB `en.json`), failing the Vercel step on
`main → staging` after merge.

**Enforcement:** `apps/web/src/app/(system)/api/og/template/route.tsx` now
pins `export const runtime = 'nodejs'` with a comment naming this incident.
No general check yet asserts Edge Function bundle size in the frontend-build
lane for other routes — that is the TODO.
