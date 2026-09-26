---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-16
commit: cea48e1b66
---
# Queue integration tests must claim only fixture rows

The inbox integration suite used global ten-row claims against the shared local
database. One assertion failed because unrelated rows filled the batch. Those
claims were released by their exact test worker IDs. Every test claim now uses
its fixture's idempotency key. Never claim, update, or delete an unscoped work
queue in a test against a developer database.

Enforcement: `integration-prompt-inbox.test.ts` targets each fixture claim and
verifies peer-owned rows remain queued before claiming the owning instance.
