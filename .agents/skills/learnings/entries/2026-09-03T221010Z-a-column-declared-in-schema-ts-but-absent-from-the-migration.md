---
recorded: 2026-09-03T22:10:10Z
incident_date: 2026-09-03
commit: 0c02b69013
---
# A column declared in schema.ts but absent from the migration ledger passes every drift gate

*Incident (2026-09-03, ~16:30 UTC onward, every Kortix environment).* Every
session start failed with `The sandbox provider could not start this session.
Try again.` Platinum answered every `POST /v1/sandboxes` that carried an
`Idempotency-Key` with `500 {"error":"column \"expected\" does not exist"}`.
Kortix sends that header on every create (`KORTIX_PLATINUM_CREATE_DEDUP`,
default ON). Local, dev and prod share one Platinum org, so one Platinum
deploy took all three down at once.

Root cause in the Platinum repo: PR #759 (`f9e63339`) added `expected:
jsonb('expected')` to `sandboxIdempotencyKeys` in `apps/api/src/db/schema.ts`
and shipped no migration for it. The create handler does a full-row
`db.select().from(sandboxIdempotencyKeys)`, so the first request after the prod
deploy of `2d752cca` hit the missing column. The migrator printed `[migrate] up
to date`, the PR drift lane passed, and the nightly DB Drift Sentinel passed:
all three compare **migrations against the database**. None compares
**schema.ts against migrations**, which is the only comparison that could have
caught this.

Kortix-side signature, so the next reader recognises the class in one log
read: `[provision-timeline] deliver … total=6ms … outcome: "unreachable"` (a
delivery that never touched the network, because `continueSession` returns
`unreachable` on `project_sessions.status = 'failed'`), then `runtime
unreachable after 3 attempts` dead-letters ~10.5 min later (30 s + 120 s +
480 s ladder). A `POST /v1/sandboxes` WITHOUT the header returning 201 confirms
the class.

**The rules.**

1. **A schema change lands with its migration in the same commit, and CI proves
   the pair agree.** `drizzle-kit generate` (or `drizzle-kit check`) on the PR
   head must emit nothing; a non-empty diff fails the lane. A migrations-vs-DB
   comparison cannot see a column that exists only in code.
2. **A provider outage needs a Kortix-side lever that a person can flip in one
   place.** `KORTIX_PLATINUM_CREATE_DEDUP=0` in `apps/api/.env.local` (local)
   or the deploy env (dev/prod) drops the header and restores session starts
   while the provider ships its fix. Cost: create dedup is off while it is set.
3. **Restart the local API through its supervisor, never with a bare kill.**
   `dev-local.sh` relaunches the API only when `$TUNNEL_URL_FILE.rotated`
   exists; a bare `pkill` ends `pnpm dev`. Env changes need the relaunch
   because `dotenvx run` injects `.env.local` at process start.

*Fix:* Platinum migration `0068_sandbox_idempotency_keys_expected.sql`
(`ADD COLUMN IF NOT EXISTS "expected" jsonb`, expand-only) plus journal idx 68.
*Enforcer:* none yet in Platinum — rule 1 is the CI lane to add there.
