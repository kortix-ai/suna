---
recorded: 2026-08-22T23:59:36Z
incident_date: 2026-08-23
commit: 6cf0da07a9
---
# Webhook signing secrets must use connector delivery

**When:** creating, updating, or diagnosing a webhook trigger. A stored secret
is not sufficient. Its delivery policy must authorize the `connector` consumer:
use `broker` strategy with `connector` consumer, then rotate after narrowing a
secret that previously reached a sandbox. Reject invalid policy during trigger
create/update, and return distinct runtime codes for missing, inactive, and
delivery-mismatched secrets. *Incident:* production `test-webhook` returned 409
because `SECRET` existed with `runtime`/`sandbox` delivery; the same manifest
also named an undeclared agent. *Enforcer:* `e2e-project-triggers.test.ts` and
`secret-consumer-access.test.ts`.
