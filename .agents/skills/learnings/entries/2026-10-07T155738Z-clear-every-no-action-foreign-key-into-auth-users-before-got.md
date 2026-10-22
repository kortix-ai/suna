---
recorded: 2026-10-07T15:57:38Z
incident_date: 2026-10-07
---
# Clear every NO ACTION foreign key into auth.users before GoTrue deletes a user; read the FKs from the catalog

**Rule:** Before `auth.admin.deleteUser`, clear every NO ACTION / RESTRICT foreign key into `auth.users` (read from `pg_constraint`, not a fixed list). Legacy tables such as `basejump.accounts` outlive the schema that created them in dev, staging and prod, but not in the local or db-suites database, so a local pass proves nothing.

**Trigger surface:** Deleting a user or account; adding any table with a foreign key to `auth.users`; running an account-deletion worker.

**Incident:** 2026-10-07, prod v0.13.52. Scheduled deletions deleted account data, then GoTrue failed with `Database error deleting user` on every 15-minute tick. Each user owned a legacy `basejump.accounts` row (`primary_owner_user_id`, NO ACTION). 397 of 433 pending prod requests were affected.

**Enforcement:** `apps/api/src/billing/services/integration-account-deletion.test.ts` builds the legacy FK shape and runs a real `DELETE FROM auth.users` as the auth fake.
