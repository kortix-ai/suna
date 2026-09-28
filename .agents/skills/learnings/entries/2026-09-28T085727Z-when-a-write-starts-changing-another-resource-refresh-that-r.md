---
recorded: 2026-09-28T08:57:27Z
incident_date: 2026-09-28
---
# When a write starts changing another resource, refresh that resource's cached reads in every client that sends the write

**Rule:** When you make an API write change a second resource, find every client query that reads the second resource. Invalidate each one in the write's success handler, even when the client code did not change. A cached read outside the invalidated scope keeps the old value, and a save made from that stale view writes it back.

**Trigger surface:** adding a side effect to an existing route (`PUT …/sharing` now rewrites `session_provider_secret_pools`). Also: a React Query key kept outside `qk.project.*` scopes, such as `['session-provider-secret-pools', projectId, sessionId]`.

**Incident:** dev, 2026-09-28, after PR #7657. A share switched the session's ChatGPT selection on the server. The web share dialog refreshed only `qk.project.sessionsScope`, so the Provider keys panel showed the pre-share selection as "1 selected key is unavailable". Its **Remove unavailable keys** and **Save changes** would have stored an empty selection and stopped the model. Caught during dev verification. PR #7958.

**Enforcement:** `apps/web/src/features/workspace/project-sidebar/modal/share-session-cache.test.ts` (a share invalidates exactly the shared session's pool query).
