---
recorded: 2026-10-23T13:27:35Z
incident_date: 2026-10-23
---
# Never let the session-log journal drop a batch the API refuses: fix the batch and send it again

**Rule:** kortixd's session-log journal never deletes a refused batch from its dirty set. A `422 seq_conflict` moves the thread above the API's `seq_max` and sends again; a `413` splits the batch or cuts a single message's longest strings to a 16 kB preview plus a marker; a `400` drops only the records the zod `issues` name; any other 4xx backs off. Every refusal leaves a WARN `[session-log] journal rejected` in the API log, because the daemon log never leaves the box.

**Trigger surface:** Changing `send`, `pack` or the status handling in `apps/kortix-sandbox-agent-server/src/harness/shared/session-log-journal.ts`, the journal route's status codes (`apps/api/src/projects/routes/session-log.ts`, `session-log-ingest.ts`), or anything that numbers seqs on a box without a restore (`session_log_restore` off).

**Incident:** Found 2026-10-23, fixed in PR #10829. The journal treated every 4xx except 404/409 (and 401/408/429) as "can never succeed" and deleted the batch. A box whose native store was gone, with restore off (prod's default), numbered its root from 1 again under the same deterministic thread id; its first new turn hit `422 seq_conflict` and the whole turn was dropped from the session log. Since the v1 mirror stopped being written (v0.14.5), that turn existed nowhere outside the box. Prod CloudWatch over ~33 h: 4,617 journal posts, 2 × 422 (1 session), 1 × 413, 1 × 403: each one a lost batch. Reproduced on a real Platinum pi box locally and on dev before the fix.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/session-log-journal.test.ts` → "no batch is dropped" (422 re-sequence and its persisted offsets, 413 ×3, 403, 400, boot recovery) against a fake API with the real write rules; `apps/api/src/__tests__/integration-session-log-ingest.test.ts` and flow SLOG-1 assert `seq_max` on the 422. Not enforced: a CloudWatch metric filter or alarm on the WARN line (the repo defines none in Terraform).
