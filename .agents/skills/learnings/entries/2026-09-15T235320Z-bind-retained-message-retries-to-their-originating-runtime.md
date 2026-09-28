---
recorded: 2026-09-15T23:53:20Z
commit: 8d95a67a2e
---
# Bind retained message retries to their originating runtime

**Incident (2026-09-15, PR #7267):** production retried three native conversation
IDs against sandbox `61e4c0bd-bacd-4fc1-80e2-df289cf6772a`. Database records mapped
each conversation to a different sandbox. Cached controllers resolved the global
active client after navigation. Message reads returned repeated `404` responses.

**Rule:** bind each transcript controller to its originating runtime URL or
explicit client. Retaining or looking up a controller must not clear that binding.
Preserve HTTP status on synchronization errors. Stop automatic retries and busy
polling after `404` or `410`; preserve transcript data and allow explicit recovery.

**Enforcement:** registry tests use a real HTTP server to assert A/B/A request
paths across a runtime switch. Controller tests assert no retries for 60 seconds
after `404` and `410`, then successful explicit recovery. The SDK browser journey
switches between two real sandboxes while the first message read retries.
