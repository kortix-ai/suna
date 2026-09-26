---
recorded: 2026-08-26T18:29:39Z
incident_date: 2026-08-26
commit: 0ade2e0c9e
---
# A guard that has never fired has never been tested; and an artifact upload path is a publish path

**When:** writing any secret guard in CI (`if grep …; then exit 1`), or
uploading a directory as a workflow artifact on a public repository.
Two facts, one incident. (1) The "Guard test artifacts against secrets" step
in `tests-release.yml` invoked `rg` under `2>/dev/null`; GitHub's ubuntu
images do not ship `rg`, so from its first run (2026-08-19) until the
Blacksmith move (2026-08-25, `grep`) it passed on nothing, every time. A
guard is only evidence after it has been SEEN to fail on a planted value —
plant one in a dry run before trusting it. (2) The moment it ran for real it
found `tests/test-results/deployment-bypass-state.json`: the Playwright
storage state from #6632's bypass exchange, holding the live `_vercel_jwt`
cookie for `staging.kortix.com` (HS256, `aud: staging.kortix.com`, 7-day
expiry). `tests/test-results/**` is uploaded verbatim by every deployed
browser job, and `kortix-ai/suna` is public — so every release-gate run from
2026-08-20 to 2026-08-26 published a valid deployment-protection bypass
cookie; 78 unexpired `tests-release-browser-shard-*` artifacts held one.
Rules: never write a credential-bearing file under a directory that any
workflow uploads (`tests/.state/` now; `web-ecs-workflow.test.ts` pins the
helper path AND a by-name exclusion on all four `tests/test-results/**`
uploads); treat `path: <dir>/**` as "publish everything here"; and when a
new guard first goes red, assume it is telling the truth before assuming it
is noise. Fixed in #6933/#6934; artifacts deleted by hand the same day.
*Incident:* v0.13.6 gate run 32998656515 — all 3 browser shards failed on
the guard after their journeys had passed. No known exploitation; the
cookies themselves cannot be revoked by us — rotating the Vercel
"Protection Bypass for Automation" secret is the operator follow-up.
*Enforcer:* the unit pin above + the (now real) artifact guard.
