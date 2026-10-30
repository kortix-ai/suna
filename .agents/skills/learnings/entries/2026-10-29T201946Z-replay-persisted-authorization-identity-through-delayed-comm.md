---
recorded: 2026-10-29T20:19:46Z
incident_date: 2026-10-29
---
# Replay persisted authorization identity through delayed command execution

**Rule:** Preserve every persisted authorization field when reconstructing a delayed command, including its idempotency key. Treat `dead_lettered` as terminal. Verify worker consumption after enqueue.

**Trigger surface:** Durable command replay, delayed authorization guards, and dependent reservation retries.

**Incident:** PR #11110 preview accepted an Artifact Send request but rejected its queued session creation with 403. `executeQueuedCreate` omitted the persisted key required by the delivery guard. Queue-only HTTP tests passed. Real worker execution exposed the omission before merge. A dependent delivery also retried a dead-lettered creation because its terminal-state check omitted that enum.

**Enforcement:** `comment-queued-create.integration.test.ts` executes a persisted PostgreSQL command through the real delivery guard. It checks missing and foreign keys, materialization, and existing-row deduplication. `comment-delivery.integration.test.ts` checks terminal reservation failure and zero duplicate prompts. Run `pnpm test -- --db-only comment-queued-create comment-delivery`.
