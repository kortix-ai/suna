---
recorded: 2026-10-26T18:23:22Z
incident_date: 2026-10-26
---
# Delete legacy thread runs before cascading personal account erasure

**Rule:** Delete legacy agent runs through the threads owned by the personal account before deleting that account. Creator attribution is not ownership. Preserve unrelated account runs and keep cleanup transactional.

**Trigger surface:** Account erasure on upgraded databases carrying public.threads and public.agent_runs.

**Incident:** KRTX-2754 recurred on 2026-10-26 with two production failures. The original Better Stack pattern now grouped a basejump.accounts deletion blocked by agent_runs_thread_id_fkey when account deletion cascaded to threads. The earlier nullable-version attribution fix remained valid.

**Enforcement:** `apps/api/src/billing/services/integration-account-deletion.test.ts` reproduces the cascade blocker, completes immediate erasure, preserves another account's threads and runs, and retries deletion safely.
