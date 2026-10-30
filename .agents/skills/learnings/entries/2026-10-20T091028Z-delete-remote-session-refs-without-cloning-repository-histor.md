---
recorded: 2026-10-20T09:10:28Z
incident_date: 2026-10-20
---
# Delete remote session refs without cloning repository history

**Rule:** Resolve provider credentials once for remote branch deletion. Inspect the exact ref and push its deletion from an empty bare repository. Do not refresh a full mirror.

**Trigger surface:** Retention GC of expired session branches.

**Incident:** KRTX-2141: production GC reported 24 full-clone timeouts and 12 unauthenticated clone failures in one hour. The deletion path unnecessarily cloned repository history and did not reuse lazily resolved mirror credentials for subsequent commands.

**Enforcement:** `apps/api/src/projects/git/branches-delete.test.ts` checks real remote deletion, default-branch preservation, failure propagation and absence of a mirror. `branches-delete-auth.test.ts` checks resolved upstream reuse.
