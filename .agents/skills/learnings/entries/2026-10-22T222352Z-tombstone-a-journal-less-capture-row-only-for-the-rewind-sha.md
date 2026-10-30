---
recorded: 2026-10-22T22:23:52Z
incident_date: 2026-10-19
supersedes: 2026-10-11T002547Z-never-delete-saved-transcript-rows-because-a-read-is-shorter.md
---
# Tombstone a journal-less capture row only for the rewind shape: a complete read of the pinned root that lacks it and lists a newer message

**Rule:** The capture of a box without a journal (`writeSessionLogFromRead`) never tombstones a stored row because a read is shorter. It tombstones a stored message of the read's root only when the read is complete (`complete && headComplete`, full history), the box is not pi, the read lacks that message, and the read lists a root message created after it. An empty, partial or tail read, a read that lacks only the newest messages, and a sub-agent's rows tombstone nothing. A read of a root other than `project_sessions.runtime_session_id` writes nothing. This replaces the superseded entry's "only a rewind the proxy recorded deletes": the session log keeps no rewind marker (the v1 mirror that held it is retired, P8), so the rewind shape itself is the evidence, the same "lacks it AND lists a newer one" test the marker rule used.

**Trigger surface:** Changing `writeSessionLogFromRead`, `rewoundIds` or `writeConverted` (`apps/api/src/projects/session-log-capture.ts`), or `captureIntoSessionLog` (`lib/session-transcript-capture.ts`); adding any tombstone to the capture path.

**Incident:** 2026-10-19 review of the P8 cutover (#10324): the capture tombstoned nothing, so an OpenCode rewind stayed visible forever, and a read of a stale root re-sequenced the old root's rows. Fixed in the session-log P8 follow-ups PR. No user report.

**Enforcement:** DB suite `apps/api/src/__tests__/integration-session-log-capture-rewind.test.ts`: the rewind case, "nothing else tombstones" (partial, lost-newest, empty, pi), the sub-agent case, and the stale-root case.
