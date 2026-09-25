---
recorded: 2026-08-22T15:28:14Z
incident_date: 2026-08-22
commit: 65c05bb108
---
# A selective capacity release must include the pool isolation it budgets

**When:** selecting database-capacity commits for a release. Do not ship pool
arithmetic without every pool and writer that arithmetic assumes. Verify the
release tree, not `main`, contains the dedicated pool and its call sites.
*Incident:* staging release `2e01bad2` included the bounded connection budget
but omitted PR #6702. All 6 API shards returned `503` while 14-23 slow audit
inserts occupied the shared pools. *Enforcer:* `database-capacity.test.ts`
reads `audit-db.ts` and every high-volume writer from the release tree.
