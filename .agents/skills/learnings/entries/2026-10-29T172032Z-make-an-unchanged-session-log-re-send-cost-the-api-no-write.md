---
recorded: 2026-10-29T17:20:32Z
incident_date: 2026-10-29
---
# Make an unchanged session-log re-send cost the API no write and no row lock

**Rule:** Every kortixd restart (each release, crash or agent swap) re-sends the whole native store to `POST …/log/journal` by design: that is how converter fixes and failed attachment uploads reach the log, so do not make the daemon skip it. The ingest must make an unchanged put cost nothing: one `SELECT` per batch finds the puts whose stored row (same generation, live, journal row) has the same `content_hash` and skips their `INSERT`, and `markDurableTurns` updates only turns whose `log_durable_at` is null. No per-put statement, no new row version, no row lock for a replay.

**Trigger surface:** Changing the per-put write path or the durable-turn update in `apps/api/src/projects/session-log-ingest.ts` (`applyBatch`, `storedUnchanged`, `applyPut`, `markDurableTurns`), or proposing that the daemon persist cursors to avoid the restart re-send (rejected in PR #11104 review: it lost blob retries, converter fixes, ignored acks and re-sequenced seqs).

**Incident:** v0.14.9 prod rollout, 2026-10-29 12:00–12:20Z. Every running box switched to the new daemon and re-sent its whole history; the API ran one `INSERT … ON CONFLICT` per message. The journal route went from ~20 to 66–95 requests per 10 min at up to 6.8 s average; 15 requests hit the 25 s deadline (`503`); the requests slower than 1 s ran 62,571 statements (up to 2,189 in one request, at least 94 % of each in the DB stage), while the API itself rolled. No data was lost: the daemons retried. Fixed in PR #11104 (local: a 2,000-message re-send 1,022–1,071 ms and ~2,080 statements → 51–56 ms and ~16).

**Enforcement:** `apps/api/src/__tests__/integration-session-log-ingest.test.ts` → "a restarted daemon re-sends every message with new revs: …" asserts that unchanged rows keep `xmin`/`xmax` (no write, no lock), a changed put is written, and an already durable turn keeps `xmin`/`xmax`. Not enforced: an alarm on journal request rate or DB statements at a rollout.
