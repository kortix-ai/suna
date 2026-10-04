---
recorded: 2026-10-03T22:23:33Z
incident_date: 2026-10-03
---
# Audit owned resources after interrupting a live test

**Rule:** Audit synthetic fixture records and external resources after interrupting a live test. Do not infer complete cleanup from runner teardown. Recover only resources proved to belong to that interrupted fixture before deleting its identity.

**Trigger surface:** A live test uses ordinary Node HTTP setup and receives a cancellation signal or deadline.

**Incident:** On 2026-10-03, an e2e diagnostic was interrupted with SIGINT after its process and working directory were verified. Its app stack stopped. A later database audit found the synthetic project and managed repository still present; no cloud session was allocated. Private recovery validated the captured fixture timestamp, project, managed repository owner, and synthetic membership. It confirmed repository absence and deleted the account and auth user. No customer resource was involved.

**Enforcement:** The root pilot wrapper rejects interrupted results. No automatic post-interruption resource auditor exists yet. The testing runbook requires a resource audit after interruption. Engine cancellation does not cancel arbitrary Node HTTP work in a test body; recovery must inspect persisted fixture identity and external state.
