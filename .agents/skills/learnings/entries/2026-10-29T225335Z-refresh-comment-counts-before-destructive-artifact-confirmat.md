---
recorded: 2026-10-29T22:53:35Z
incident_date: 2026-10-29
---
# Refresh comment counts before destructive Artifact confirmation

**Rule:** Read the current comment count when opening Artifact Unshare confirmation.
Keep confirmation disabled until the read succeeds. Permit an explicit retry after failure.
Ignore an older response after the dialog closes or reopens.

**Trigger surface:** Displaying a destructive confirmation for data that other people can change.

**Incident:** On 2026-10-29, the section 5 browser proof loaded seven comments in one client.
A second client added a comment. Unshare still warned about seven before the next poll.
The proof caught the stale warning before merge. No customer data was affected.

**Enforcement:** `use-artifact-unshare.test.ts` verifies fresh counts, failed reads, retry, and response ordering.
The real browser proof adds a comment from another client and asserts the fresh count before Unshare.
