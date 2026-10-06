---
recorded: 2026-10-06T12:03:55Z
incident_date: 2026-10-06
---
# Never bulk-delete the grants of an object where no grant means everyone

**Rule:** A secret value or a shared connector account with no audience grant is usable by everyone in the project. Never delete `role_assignments` rows of such an object in bulk: filter every bulk delete with `notAnAudienceGrant()` (`apps/api/src/iam/audience-grants.ts`). Only the object's own audience setting, or deleting the object, removes an audience grant. A grant to a principal that is gone reaches nobody, which is the safe state.

**Trigger surface:** writing or reviewing any `db.delete(roleAssignments)` keyed by a principal (offboarding, promotion, SCIM, group or service-account deletion, a cleanup sweeper), or adding a new object type whose empty audience means "open".

**Incident:** 2026-10-06, found in a platform audit, no report of use. Since secret audiences moved into `role_assignments` (#8533), promoting a value's holder to admin, removing them, their leaving, SCIM deprovisioning, deleting the group or service account in the audience, and the members-manage resource-grant delete each removed the last audience grant: an "Only you" secret became usable by, and listed as "Everyone" to, the whole project. Shared connector accounts narrowed to people or groups had the same paths. Fixed fail-closed in the PR that adds this entry.

**Enforcement:** `apps/api/src/__tests__/integration-secret-audience.test.ts` ("an audience outlives the principals it names": promotion/removal, group, service account, resource-grant delete) and the HTTP flow `SEC-AUD-4` (`tests/src/flows/secrets.flow.ts`). A new bulk-delete path is not covered automatically: grep for `delete(roleAssignments)` when adding one.
