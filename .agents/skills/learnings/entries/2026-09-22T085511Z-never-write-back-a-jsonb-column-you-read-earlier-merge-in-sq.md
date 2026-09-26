---
recorded: 2026-09-22T08:55:11Z
incident_date: 2026-09-22
commit: 4c2dc77638
---
# Never write back a JSONB column you read earlier: merge in SQL

**Rule:** A writer of shared JSONB state (`session_sandboxes.metadata`) never
builds `{ ...row.metadata, key }` from a read and writes the object back. Merge
with `coalesce(metadata,'{}'::jsonb) || $patch::jsonb`, strip with the literal
`-` chain from `stripMetadataKeys`, and put "only if unset" checks in the
WHERE clause, which Postgres re-evaluates on the locked row. **Trigger
surface:** any `.update(sessionSandboxes).set({ metadata: … })`, and any new
lifecycle fence stored in metadata.

**Incident:** SESS-9 failed on every PR preview (restart stuck in
`provisioning` ~350 s). `pinSandboxEgressIp` read metadata; a restart claimed
the row ~0.2 s later (`runtimeRestartId`); the pin wrote its stale copy back.
`ownsRestart()` then returned false and the detached restart returned with no
log line. The audit found the same shape in the restart claim itself and two
`/start` clock writers. **Enforcers:** `e2e-sandbox-metadata-race.test.ts`
(real PostgreSQL row-lock interleaving; runs only with `TEST_DATABASE_URL` —
not in CI yet, which is the open TODO), `sandbox-egress-pin.test.ts` (hermetic
shape guard), and the `restart abandoned: lost the restart claim` warning.
Remaining whole-object writers: `deleteSession`, the provisioning IIFE in
`session-sandbox.ts`, and the recovery fences in `runtime-identity.ts`.
