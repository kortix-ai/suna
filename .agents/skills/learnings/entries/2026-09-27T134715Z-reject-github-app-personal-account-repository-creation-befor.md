---
recorded: 2026-09-27T13:47:15Z
incident_date: 2026-09-25
---
# Reject GitHub App personal-account repository creation before calling GitHub

**Rule:** Reject repository creation with an App installation token on a personal account before calling GitHub. A PAT may still use `/user/repos`.

**Trigger surface:** Creating a GitHub-backed project or a managed repository for a personal account.

**Incident:** On 2026-09-25 a personal installation produced GitHub `/user/repos` 403 and an opaque frontend ApiError during project creation. Installation tokens cannot create a personal repository through this endpoint.

**Enforcement:** `bun test apps/api/src/projects/github-rate-limit.test.ts apps/api/src/__tests__/unit-github-owner-type-routing.test.ts` checks the rejection and the PAT alternative.
