---
recorded: 2026-09-30T19:17:35Z
incident_date: 2026-09-29
---
# Retry the managed-repo seed push with backoff while a new repo is not yet reachable over git

**Rule:** After creating a managed git repo, treat `Repository not found`, `HTTP 404` and `Write access ... not granted` on the first pushes as propagation lag: back off and retry (39 s total). Fail every other push error fast.

**Trigger surface:** Creating a repo through a git host API and pushing to it immediately (`pushVerifiedSeed`, provision).

**Incident:** 2026-09-23..29: 6 of ~254 prod provision requests in 7 days rolled back at stage=push after 2 instant pushes. The user lost the project create. Fix in the PR that added this entry.

**Enforcement:** `apps/api/src/projects/managed-repo-seed.test.ts`, block `freshly created repo not yet reachable over git`.
