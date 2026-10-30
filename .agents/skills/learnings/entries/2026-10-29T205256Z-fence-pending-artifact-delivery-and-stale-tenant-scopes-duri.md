---
recorded: 2026-10-29T20:52:56Z
incident_date: 2026-10-29
---
# Fence pending Artifact delivery and stale tenant scopes during project transfer

**Rule:** Move verified Files identity receipts with their project before updating sandbox rows that capture those identities. Cancel pending Artifact delivery instead of rewriting its captured principal. Recheck the locked Artifact account against both the actor and authorized scope before writing a comment.

**Trigger surface:** Project ownership transfer, Artifact delivery queues, and session-content purge classification.

**Incident:** PR #11110 DB CI found an unclassified sandbox identity table. A real transfer fixture then reproduced lost historical Files attribution and an old-tenant comment write after transfer. Updating sandbox rows before their identity receipts also caused a destination primary-key collision. Completed history remains readable in the destination; pending old-tenant commands are dead-lettered with an explicit cancellation result. Session purge deliberately retains only the six-field identity receipt while erasing session content.

**Enforcement:** `project-transfer-artifacts.integration.test.ts` checks live and retired identity movement, destination comments/activity reads, stale-scope rejection, pending cancellation, and unaffected history/queues. `integration-session-log-purge.test.ts` checks erased content and retained ID-only identity. The transfer classifier requires every account/project table to have an explicit policy.
