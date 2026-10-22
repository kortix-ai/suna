---
recorded: 2026-10-22T17:42:47Z
incident_date: 2026-10-22
---
# Answer 'nothing saved' only when nothing is saved, not when a conversion lock was busy

**Rule:** A read that converts old data on demand under a try-lock (`pg_try_advisory_xact_lock`) can lose the lock to a concurrent read of the same open and write nothing. Its "not found" answer must then not claim "nothing saved": check that no unconverted source remains before answering a code a client treats as final (`session_log_missing`).

**Trigger surface:** Adding a typed 404 or empty answer to a route whose read converts lazily (`readSessionLogPage` → `convertMirrorOnRead`); two reads of one open that hit the same conversion (the session-open snapshot's `log` leg and `GET …/log`).

**Incident:** 2026-10-22, dev only (caught before a release). #10722 gave the no-log 404 `code: 'session_log_missing'`, and the SDK stopped reading v1 on it. A session whose history was only in the v1 mirror then opened empty: the snapshot held the conversion lock, `GET …/log` skipped, answered `session_log_missing`, and the SDK stayed on an empty log. Journey 34 "loading older messages…" failed on dev and locally. #10728: the route answers 404 with no code while an unconverted mirror remains, so the client reads v1, which converts it.

**Enforcement:** `apps/api/src/__tests__/integration-session-log-read.test.ts` ("a mirror-only session whose conversion another read holds answers 404 with no code"); journey 34 test 10.
