---
recorded: 2026-10-29T22:02:01Z
incident_date: 2026-10-29
---
# Block new comment submission until selected-text capture finishes

**Rule:** Start a parent-owned submission gate synchronously for each permitted Comment intent. Clear the previous anchor before mapping preflight, saving, or reading a snapshot. Publish the anchor before finishing that gate. Finish once on failure, cancellation, or editor unmount. A failed capture requires explicit discard before a whole-Artifact comment can be sent. Leave existing replies available.

**Trigger surface:** Capturing a document selection asynchronously while its new-comment composer is already open.

**Incident:** Section 5 browser verification clicked Comment while the sidebar was open. A helper mistook an older Outdated quote for the new selection preview and sent before snapshot capture completed. The server accepted a whole-Artifact comment. This exposed a real submission race, so the editor now reports capture start and completion to its parent.

**Enforcement:** `doc-comment-capture.test.ts` verifies synchronous start, publish-before-finish, failure, cancellation, and late completion. The section 5 browser proof waits for the unique selection-discard control and asserts the outgoing text anchor and quote.
