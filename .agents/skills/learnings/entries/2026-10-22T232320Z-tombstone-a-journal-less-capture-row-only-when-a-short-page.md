---
recorded: 2026-10-22T23:23:20Z
incident_date: 2026-10-23
supersedes: 2026-10-22T222352Z-tombstone-a-journal-less-capture-row-only-for-the-rewind-sha.md
---
# Tombstone a journal-less capture row only when a short-page-proven complete read lacks a suffix of the root history and lists a newer message

**Rule:** `writeSessionLogFromRead` tombstones stored root messages only when all of these hold: the walk is complete, and its last page was SHORT (fewer rows than the `limit` asked; a full page with no `x-next-cursor` is not the head, `readTranscriptPages`); the box is not pi; the lacking messages are a suffix of the stored root history (no stored root message after the oldest lacking one is still read); and the read lists a root message newer than all of them. A tombstone is soft: the row and its record stay (`deleted_at`, `seq = -rev`), and a later put of the same id revives it. The superseded entry called the rewind shape equivalent evidence of a rewind; it is not. **Residual:** a box that lost exactly its newest messages, kept its root, and then took a prompt is indistinguishable from an OpenCode rewind, and those messages are tombstoned (recoverable only by a put of the same id or by hand).

**Trigger surface:** Changing `rewoundIds`, `writeSessionLogFromRead` or `writeConverted` (`apps/api/src/projects/session-log-capture.ts`), `readTranscriptPages` (`lib/session-transcript-pages.ts`), or the page `limit` the capture passes.

**Incident:** 2026-10-23 review of PR #10783 (no data loss observed): an old OpenCode build that answers the newest `limit` rows with no cursor made every turn-end read "complete" and tombstoned every older root row in the DB suite; a hole in a complete read also tombstoned, and shifted the seqs of unread rows so `dropProvisionalRows` hid them. Fixed in the follow-up PR.

**Enforcement:** `apps/api/src/__tests__/integration-session-log-capture-rewind.test.ts` ("an old OpenCode build that answers the newest `limit` rows and no cursor", the hole case in "nothing else tombstones", the revive in the rewind case) and `apps/api/src/projects/lib/session-transcript-pages.test.ts` ("a full page with no cursor does not prove the head").
