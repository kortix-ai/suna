---
recorded: 2026-09-29T16:05:24Z
incident_date: 2026-09-29
---
# Promote current main to staging; the staging PR's own checks are the gate; fix forward

**Rule:** When cutting a release, promote `origin/main`'s CURRENT HEAD to
`staging` immediately — never wait for a green push run on `main` first. Open
the promotion PR (`promote/main-<sha10>` → `staging`, ordinary merge, never
squash), then treat that PR's own checks (six `Tests` lanes, CodeQL, Trivy,
`Migrations are sequential`, translation-catalog order, secret scans,
typecheck/builds) as the gate: merge only when every one has finished and
passed and every review thread is resolved. Fix every red check at the root on
`main` (one green-main PR per round, test-first, `test` label), then open a
fresh promotion at the new `main` HEAD and close the stale one with a pointer.
Repeat until the staging PR is green. Full flow: the **kortix-release** skill.

**Trigger surface:** Cutting a release; a promotion PR stuck red; deciding
whether to wait for `main` to go green before promoting; reviewing or
resolving a CodeQL/Trivy/migration-order finding on a `staging` PR.

**Incident:** 2026-09-28/29. Promotion PRs into `staging` were titled "(fully
green)" and waited for a clean `main` push run before opening (#8025, #8154 —
closed unmerged when `main` went red again before it could merge). Three
things kept making that wait a moving target in the same 24 h window: PR
#8010 fixed two migrations merged (#7445) with a timestamp older than one
already applied on dev, so `Migrations are sequential` (`checkOrder`) failed
Deploy Dev on every `main` commit until the rename landed; PR #8148 (KRTX-668,
logout session revocation) merged without running its own black-box flows and
broke `AUTH-1`/`AUTH-3` on `main`, reverted by #8153 six hours later; PR #8159
fixed a CodeQL finding (a config-archive race) that a large diff surfaced in
code the diff did not intend to touch. Each fix reopened the window for a new
red commit to land before the wait finished. The owner's decision (2026-09-29):
stop waiting for a green `main` SHA. Promote current `main` on every cut and
let the staging PR's own checks be the gate instead — visible in practice from
PR #8194 onward, whose title and body dropped "(fully green)" for "Promotes
current main `<sha>` to staging... This PR's checks are the gate: anything red
is fixed on main and this promotion is refreshed until every check passes."

**Enforcement:** `staging`'s branch protection sets
`required_conversation_resolution: true`, so GitHub blocks the merge button on
an unresolved review thread (a CodeQL finding included). No status check on
`staging` is a required check — merging on a pending or failing check is a
human error, not something GitHub blocks; the **kortix-release** skill's
Step 3 checklist is the enforcer until a required-check ruleset exists.
