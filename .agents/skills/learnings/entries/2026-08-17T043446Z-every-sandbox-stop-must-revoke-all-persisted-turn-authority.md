---
recorded: 2026-08-17T04:34:46Z
incident_date: 2026-08-17
commit: d5ce1cd2d6
---
# Every sandbox stop must revoke all persisted turn authority

**When:** changing provider webhooks, idle reaping, manual stop, or the shared stopped-state writer. Remove `activeTurn`, `activeTurns`, and `lifecycleStopClaim` in the same transaction that sets `status='stopped'`. Do not rely on the reaper to clear tokens first; a provider-native timer or webhook can win that race.
*Incident:* the one-minute Dev Platinum proof stopped after `deadline_at`, but the provider webhook committed `status='stopped'` with a synthetic unknown `activeTurns` token still present.
*Enforcer:* `sandbox-state-sync.test.ts` requires `applyStoppedState()` to remove every turn-authority key atomically for all stop paths. The live provider harness verifies the stopped row has zero active turns.
