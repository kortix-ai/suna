---
recorded: 2026-10-30T02:03:34Z
incident_date: 2026-10-30
supersedes: 2026-10-29T172032Z-make-an-unchanged-session-log-re-send-cost-the-api-no-write.md
---
# Make a session-log re-send of changed puts cost one INSERT per batch, not one per message

**Rule:** The puts of a journal batch cost a constant number of statements, whatever their number. The 2026-10-29 rule stays: an unchanged put (same generation, live journal row, same `content_hash`) costs no write and no row lock, and a durable turn is not updated again. New: the changed puts go in one multi-row `INSERT … ON CONFLICT` per 2,000 rows, inside a savepoint. Only a seq collision (`session_log_messages_thread_seq_key`) or a message id twice in a batch takes the one-INSERT-per-put path, so the `422` still names the colliding pair. Never add a statement per put to the ingest.

**Trigger surface:** Changing the write path in `apps/api/src/projects/session-log-ingest.ts` (`applyBatch`, `storedUnchanged`, `applyPuts`, `insertPuts`, `markDurableTurns`), or shipping a daemon, converter or harness change that alters every record's hash (each such release re-sends whole stores as changed puts).

**Incident:** v0.14.10 prod rollout, 2026-10-30 01:10–01:40Z. Boxes swapped to the 0.14.10 daemon (pi 1.4.0), which changed the record hashes, so #11104's unchanged-put skip did not apply. Slow journal requests ran 467–927 statements in 1.8–25 s; 74 / 129 / 222 requests per 10 min; 4 `503`s at the 25 s deadline. No data was lost: the daemons retried. Fixed in PR #11154 (local: 2,000 changed puts 1,018–1,161 ms and 2,011 statements → 199–229 ms and 13).

**Enforcement:** `apps/api/src/__tests__/integration-session-log-ingest.test.ts` → "a batch of 500 changed puts costs a constant number of statements; …" asserts fewer than 40 statements (`Server-Timing` `n=`) for 500 changed puts, and the same `422` body as one put at a time for a collision inside the batch. Not enforced: an alarm on journal statements per request at a rollout.
