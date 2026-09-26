---
recorded: 2026-08-19T01:34:31Z
incident_date: 2026-08-19
commit: 8260a5f68b
---
# A frontend deploy job that `needs:` an unrelated edge job ships a half-deployed staging, and the release gate then blames the code

**When:** `deploy-staging.yml` for `044d99480d` (v0.13.0 candidate),
run 32149212400, 2026-08-18 14:34 UTC.

The job `Wire Cloudflare staging DNS and Worker` failed at
`Deploy staging API router Worker`: Cloudflare returned **403** on
`PUT …/workers/scripts/staging-api-kortix-router` (credential rejected; the
same step passed on 2026-08-12 run 31635834664). Because `deploy-web-vercel`,
`verify` and `promote-staging-channel` all `needs:` that job, they were
**skipped** — while `Apply DB migrations`, `Deploy API + gateway (ECS)` and
`Deploy staging web to ECS` had already succeeded. Staging ended up with the
new API and the OLD Vercel frontend, and nothing failed loudly: the workflow
was red, but the API `/health` reported the right SHA and the release PR kept
re-running `tests-release` against it. Every attempt then lost 15/21 browser
journeys to "heading/control not found" (`Admin overview`, `Billing`,
`Sandbox templates`, `Apps`, `Feature flags`, `Switch workspace`, …) — strings
that all exist on `staging` — plus `LOGIN-2`, which drives `$WEB/cli/authorize`.
Ten attempts and two learnings entries were spent reading those as
capacity/flake before anyone opened the deploy-staging run.

**The rule:** before re-running a release gate, open the *deploy* run for the
`RELEASE_SOURCE_SHA` and confirm every job is green — an API `/health` SHA
match proves the API only. When a gate fails with many "element not found"
browser assertions at once and the API lane is mostly green, suspect a stale
frontend deploy first. Structurally: the Vercel/frontend deploy must not
`needs:` the Cloudflare DNS/Worker job (they are independent), and `verify`
must fail loudly on a frontend/API SHA mismatch instead of being skipped along
with its dependency. And rotate the Cloudflare credential used by
`deploy-staging.yml`; it stopped working between 2026-08-12 and 2026-08-18.
*Incident:* v0.13.0 release (PR #6520), run 32151213430 ×10; frontend deploy
skipped since 2026-08-18 14:34 UTC.
