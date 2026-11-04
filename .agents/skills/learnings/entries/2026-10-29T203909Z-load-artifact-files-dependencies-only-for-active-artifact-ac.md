---
recorded: 2026-10-29T20:39:09Z
incident_date: 2026-10-29
---
# Load Artifact Files dependencies only for active Artifact access checks

**Rule:** Import Artifact Files visibility dependencies inside the active Artifact access branch. Empty and flag-off checks must not load them. Preserve strict failure propagation for active checks.

**Trigger surface:** Adding an optional notification source to a module already used by accounts, channels, session lifecycle, and legacy notifications.

**Incident:** PR #11110 API CI failed 27 existing unit files after Artifact access checks added eager imports of `artifacts/service` and `drives/service`. These imports pulled `shared/db.withDbTransaction` and `iam/authorize.resolvePrincipal` into unrelated route fixtures. Two representative failures reproduced without changing their mocks. Moving the dependencies to the active Artifact branch restored all 425 affected tests.

**Enforcement:** `notifications/access-lazy-artifacts.test.ts` rejects any Artifact Files import during empty and flag-off access checks. It also verifies that a live strict check loads the canonical dependencies and propagates their failure. Existing account-id and email-channel route tests retain their original mocks and pass.
