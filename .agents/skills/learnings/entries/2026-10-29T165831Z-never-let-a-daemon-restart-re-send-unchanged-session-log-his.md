---
recorded: 2026-10-29T16:58:31Z
incident_date: 2026-10-29
---
# Never let a daemon restart re-send unchanged session-log history, and keep an unchanged re-send free at the API

**Rule:** A kortixd that restarts on the same native store at the same generation sends only what changed since its last acknowledged batch: the journal persists the acknowledged native hashes (`session-log-acked.json`, with the generation) after each 200 and skips unchanged messages at its first collection. A message that was dropped, refused or not acknowledged is not in the file and goes again. No file, a torn file, or another generation (a restore) exports every stored message. The file never makes a tombstone. apps/api finds unchanged puts with one `SELECT` per batch and skips their `INSERT`: a full re-send writes no row and takes no row lock.

**Trigger surface:** Changing the journal's cursors, acknowledgements or first collection (`apps/kortix-sandbox-agent-server/src/harness/shared/session-log-journal.ts`), the boot state (`session-log-boot.ts`), or the per-put write path of `POST …/log/journal` (`apps/api/src/projects/session-log-ingest.ts`).

**Incident:** v0.14.9 prod rollout, 2026-10-29 12:00–12:20Z. Every running box switched to the new daemon; each restarted journal had no cursors and re-sent its whole history, and the API ran one `INSERT … ON CONFLICT` per message. The journal route went from ~20 to 66–95 requests per 10 min at up to 6.8 s average; 15 requests hit the 25 s deadline (`503`); the requests slower than 1 s ran 62,571 statements (up to 2,189 in one request, at least 94 % of each in the DB stage), while the API itself rolled. No data was lost: the daemons retried. Fixed in PR #11104.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/session-log-journal.test.ts` → "restart on the same store" (only changes go; unacknowledged and `400`-dropped messages go again) and "recovery: acknowledgements of another generation …" (everything goes, no tombstone); `pi-session-log-restore.test.ts` (a real pi runtime restarted after a restore sends 0 messages); `apps/api/src/__tests__/integration-session-log-ingest.test.ts` → "a restarted daemon re-sends every message with new revs" (unchanged rows keep `xmin`/`xmax`). Not enforced: an alarm on journal request rate or DB statements at a rollout.
