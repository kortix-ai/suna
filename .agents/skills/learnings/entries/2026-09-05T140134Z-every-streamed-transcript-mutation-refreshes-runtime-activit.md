---
recorded: 2026-09-05T14:01:34Z
incident_date: 2026-09-05
commit: 1bac1e4dd7
---
# Every streamed transcript mutation refreshes runtime activity

**When:** adding or changing a wire event that mutates visible assistant output.
Refresh `sessionActivityAt` after the mutation applies. Do not cover only full
part snapshots; delta-only streams can run past the 45-second observation bound.
Ignore replayed event IDs because history is not current activity. *Incident:*
reasoning text kept growing while the composer changed from Stop to Send and the
turn busy indicator disappeared. *Enforcer:* `sync-store.test.ts`.
