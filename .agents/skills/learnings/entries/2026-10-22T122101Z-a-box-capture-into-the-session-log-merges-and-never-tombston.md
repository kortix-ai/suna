---
recorded: 2026-10-22T12:21:01Z
incident_date: 2026-10-22
supersedes: 2026-10-11T002547Z-never-delete-saved-transcript-rows-because-a-read-is-shorter.md
---
# A box capture into the session log merges and never tombstones; a short read deletes nothing

**Rule:** The capture of a box without a journal (`captureJournallessSessionLog`, `writeSessionLogFromRead`) puts only the messages the box answered, merged into the stored log. It never tombstones: a shorter, empty or partial read says nothing about what was removed. Only a journal tombstones a message.

**Trigger surface:** Changing `apps/api/src/projects/lib/session-transcript-capture.ts` or `writeSessionLogFromRead` / `writeConverted` (`apps/api/src/projects/session-log-capture.ts`), or adding a tombstone or DELETE on `session_log_messages` outside the journal ingest.

**Incident:** No incident. P8.2 (the PR that adds this entry) removed the v1 mirror writer, so the 2026-10-11 rule's mirror capture, its rewind marker and its enforcer (`integration-session-transcript-capture.test.ts`) are gone. The rule carries over to the log capture, which replaced the mirror writer for journal-less boxes.

**Enforcement:** `apps/api/src/__tests__/integration-session-log-capture.test.ts`: "a new turn puts only its messages; a tail read merges into the stored history and tombstones nothing" and "a journal owns the log: the capture and the wake read nothing from the box and write nothing".
