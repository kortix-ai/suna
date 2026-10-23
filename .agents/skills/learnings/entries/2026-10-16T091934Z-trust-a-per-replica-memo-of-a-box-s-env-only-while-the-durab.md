---
recorded: 2026-10-16T09:19:34Z
incident_date: 2026-10-16
---
# Trust a per-replica memo of a box's env only while the durable record confirms it, and fence that record at every daemon boot

**Rule:** The API's record of what env a box holds describes one kortixd PROCESS. A new process (agent swap exit 75, crash, VM reboot) seeds its env from the boot env (`/etc/pt-env`) and loses every push. Fence the record at the daemon's `initial_turn_claim` (`recordDaemonBootForEnvSync`), and trust the per-replica memo only while `loadEnvSyncDurableState` still names its signature: another replica's push moves the record, not this memo.

**Trigger surface:** Changing `apps/api/src/projects/lib/sandbox-env-push.ts`, `env-sync-durable-state.ts` or `env-sync-skip-decision.ts`; adding any per-replica "we already pushed this to the box" cache; changing the daemon's boot claim or what a new daemon process reads at boot.

**Incident:** 2026-10-16, local stack, real Platinum box. A private session's boot env held its creator's personal secret override. An admin prompted: the push set the base value. After the turn kortixd swapped its binary and rebooted, and the env file reverted to the creator's value. Reproduced: the next prompt inside `ENV_SYNC_BACKGROUND_REFRESH_STALE_MS` (10 min) logged `[env-sync] push=trusted` and ran on the boot env (KRTX-2517 class). The same hole opened without a reboot when two replicas alternated persons.

**Enforcement:** `apps/api/src/projects/lib/sandbox-env-sync.durable-skip.test.ts` ("a daemon restart drops the trust", "another replica moved the box"), `env-sync-durable-state.test.ts` (fence + record version), `projects/routes/turn-stream.test.ts` (the claim records the boot; a failed record answers 503).
