---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# A retryable POST needs a server-enforced idempotency key

**When:** retrying an append after a timeout or transport failure can follow a committed write.
**Incident:** the Pi transcript client could not distinguish a failed request from a lost response;
retrying could duplicate a durable message, while not retrying could lose it.
**Rule:** mint one UUID per logical append, reuse it across retries, and reject key/content conflicts.
**Enforcer:** `session-store.test.ts`, `session-log-http.test.ts`, and the unique database index.
