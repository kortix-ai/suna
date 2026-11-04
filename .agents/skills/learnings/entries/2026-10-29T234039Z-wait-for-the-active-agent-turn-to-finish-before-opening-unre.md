---
recorded: 2026-10-29T23:40:39Z
incident_date: 2026-10-30
---
# Wait for the active agent turn to finish before opening unrelated proof feedback

**Rule:** A resolved comment thread is not a completed model turn. Before introducing feedback for another recipient, wait for `GET /projects/:pid/sessions/:sid/turn` to return no turns and the latest assistant message to complete. Stop the first session and verify its stopped authority when isolation matters.

**Trigger surface:** Running a real-agent proof with consecutive existing-session and new-session Artifact feedback.

**Incident:** PR #11110 dev verification opened the fallback thread immediately after the first thread resolved. The first agent was still finishing and answered that new thread. The strict expected-author check rejected this false fallback success; the delayed guard refused the resolved source. The corrected proof waits for turn completion and isolates the first session.

**Enforcement:** The scoped dev proof checks the exact fallback `author_session_id`, reply marker, empty turn authority, completed assistant, and stopped first session. No maintained journey covers this ordering yet: retain these checks when adding live-runtime coverage to ART-7.
