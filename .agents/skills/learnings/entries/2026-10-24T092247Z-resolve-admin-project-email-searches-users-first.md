---
recorded: 2026-10-24T09:22:47Z
incident_date: 2026-10-24
---
# Resolve admin project email searches users-first

**Rule:** Reuse `accountIdsWithMemberEmailLikeSql` for fleet project email search. Do not correlate a membership-first auth-user lookup per project.

**Trigger surface:** Admin project list and filtered count queries.

**Incident:** KRTX-3437, 2026-10-24: three frontend ApiError events exposed a statement timeout in the admin project search. A real PostgreSQL reproduction planned primary-key auth-user probes per membership.

**Enforcement:** `apps/api/src/admin/projects-search.integration.test.ts` checks the PostgreSQL plan and search results, including literal wildcard inputs. The legacy predicate fails its users-first assertion.
