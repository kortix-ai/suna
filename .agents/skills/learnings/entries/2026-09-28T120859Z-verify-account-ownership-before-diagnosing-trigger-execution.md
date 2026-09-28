---
recorded: 2026-09-28T12:08:59Z
incident_date: 2026-09-28
---
# Verify account ownership before diagnosing trigger execution

**Rule:** Check live account-scope owner assignments when a trigger cannot resolve its automation actor.
Repair a confirmed ownerless account through the platform-admin member-role endpoint, which writes canonical assignments and audit events.
Verify prompt delivery separately from schedule configuration; an hourly expression can still be disabled.

**Trigger surface:** `resolveProjectAutomationActor`, trigger firing, and account-role incident repair.

**Incident:** On 2026-09-28, prod v0.13.40, one personal account had one admin and no owner.
Nineteen scheduled executions exhausted retries; manual tests returned HTTP 500 before prompt delivery.
The admin endpoint restored the existing user's owner role; manual fire returned 202 and its delivery command succeeded.

**Enforcement:** Existing last-owner guards prevent owner removal but do not repair pre-existing ownerless accounts.
TODO: add an ownerless-account integrity check and explicit automation-actor failure coverage.
