---
recorded: 2026-09-17T16:14:47Z
incident_date: 2026-09-17
commit: b825c69964
---
# A branch migration's timestamp is re-checked at MERGE time, not at write time

**Rule:** before merging a branch that adds a migration, confirm its file sorts
after every migration on `main` at that moment; if `main` grew a newer one,
rename yours to a fresh timestamp. A persistent preview DB that already ran the
old name will then refuse (`Not run migration … is preceding already run
migration …`) — recycle the `preview` label so it rebuilds from scratch; do not
hand-edit `pgmigrations`. **When:** a long-lived branch (days) with a migration,
or any merge of `main` into it. *Near-miss:* `connector-creds` wrote
`20260916182954570_…` on day 1; by merge day `main` had `20260916194914446_…`,
and the PR's preview died in `kortix-migrate` on the first redeploy after the
merge. *Enforcer:* none yet — `packages/db` has no "newest on branch > newest on
main" check; until it exists, `ls packages/db/migrations | sort | tail` against
`git ls-tree origin/main` is the check.
