---
recorded: 2026-09-07T20:33:29Z
incident_date: 2026-09-07
commit: d6213e60ea
---
# Verify a rotated credential with the WRITE it exists for, and every edge worker deploys from the same pipeline as its origin

**When:** rotating any token/key (PAT, App permission, API key) or editing an
`apps/api/.env.<env>` credential; and when changing what fronts an origin
(`infra/cloudflare/workers/api-router`). PR #7063 (2026-08-30) swapped the
managed-kortix classic PAT for a fine-grained one and "verified" it with
`GET /orgs/managed-kortix/repos` = 200 — a read. Repo creation needs
`Administration: write`, which it lacked, and the App fallback (install
140097279) only had `contents:write`. **Every prod project creation failed
for 8 days** (~500/day, 63 users/day), and nobody saw the reason: the prod
`api-kortix-router` worker was a 2026-08-21 build (only `deploy-staging.yml`
and the cutover workflow ever ran `wrangler deploy`), so it rewrote the 502
body into "Kortix is temporarily unavailable" and Better Stack showed a
maintenance page nobody had switched on. **Rules.** (1) A credential swap is
verified by the operation it authorises — for a repo-creating token, a
create+delete probe repo — never by a read. (2) An edge worker is part of the
origin's release: `deploy-prod.yml` now deploys it (`deploy-api-router`) and
asserts the script's `modified_on` moved. (3) A route that returns an error
body without a log line is invisible once an edge or a proxy eats the body;
`provision-core.ts` now logs `create_repo` failures. *Incident:* prod,
2026-08-30 23:15 → 2026-09-07 20:28 UTC (worker) / credential fix pending.
See memory [[prod-provision-dead-fine-grained-pat-2026-08-30]].
*Enforcer:* `deploy-api-router` job in `deploy-prod.yml`; unit
`unit-connector-invalid-source-address.test.ts` for the sibling 500s.
