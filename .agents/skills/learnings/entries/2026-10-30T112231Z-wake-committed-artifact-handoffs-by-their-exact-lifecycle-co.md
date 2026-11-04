---
recorded: 2026-10-30T11:22:31Z
incident_date: 2026-10-30
---
# Wake committed Artifact handoffs by their exact lifecycle command key

**Rule:** After an Artifact handoff commits, wake only its persisted lifecycle command key. Use the digest command's key and `available_at`, including inherited creates. Enable the kick when global workers or the job worker is enabled. Keep both switches off for queue-only tests. Never drain before commit, sweep siblings, or mutate target progress before commit. Bound delayed kicks and leave durable retries intact.

**Trigger surface:** Artifact comment dispatch, Send, digest coalescing, fallback session creation, and lifecycle worker gates.

**Incident:** 2026-10-30, PR #11136 preview at b306848f. Send persisted a due lifecycle command with zero attempts. The preview enabled global workers and disabled the scheduler, so no lifecycle worker claimed it. A focused regression also found that a deferred transaction failure left the in-memory target sent after rollback.

**Enforcement:** `comment-lifecycle-wake.test.ts` checks worker gates, exact drain scope, due times, timer bounds, and contained failures. `comment-delivery.integration.test.ts` checks committed visibility, released Artifact locks, digest and create keys, and rollback retryability against PostgreSQL. The real preview Send proof must complete through natural workers without an operator drain.
