---
recorded: 2026-10-11T00:25:47Z
incident_date: 2026-10-09
---
# Never delete saved transcript rows because a read is shorter; only a rewind the proxy recorded deletes, and only rows from the marker onward that a read with a newer message lacks

**Rule:** The transcript capture merges every read into `session_transcript_messages`. A shorter, empty or partial read never deletes a saved row. Only a rewind the sandbox proxy recorded (`session_transcript_mirrors.rewind_message_id`, set on an accepted `POST /session/:id/revert`, cleared on `unrevert`) deletes, and only rows from the marker onward that a read lacks, when that read lacks the marker message AND lists a newer one.

**Trigger surface:** Changing `captureSessionTranscript` or `applyRecordedRewind` (`apps/api/src/projects/lib/session-transcript-capture.ts`), the proxy's `recordAcceptedRewind`, or adding any DELETE on the transcript tables.

**Incident:** Found 2026-10-09 in research, fixed in PR #9521. Three read-driven delete branches (complete read, caught-up read, sub-agent read) treated "the box no longer lists it" as "it was removed". A box that lost its state answered a shorter read, and its saved history was deleted. Blast radius: any session whose box restarted without its OpenCode state.

**Enforcement:** DB suite `apps/api/src/__tests__/integration-session-transcript-capture.test.ts`: "a turn writes only what changed, and a shorter read deletes nothing", "only a recorded rewind deletes, and only the rewound rows", "a pi session never loses rows on any read", "an empty complete read with a marker set deletes nothing and keeps the marker", "a read that lists only messages older than the marker deletes nothing and keeps the marker", "a marker whose message is not stored under this root is cleared and deletes nothing".
