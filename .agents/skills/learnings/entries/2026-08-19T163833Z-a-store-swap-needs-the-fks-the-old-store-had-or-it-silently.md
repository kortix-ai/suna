---
recorded: 2026-08-19T16:38:33Z
incident_date: 2026-08-19
commit: 1addb77a0c
---
# A store swap needs the FKs the old store had, or it silently loses a cascade

**When:** moving rows from several tables into one canonical table.
`project_members`, `project_group_grants` and `iam_resource_grants` each had
`ON DELETE CASCADE` from `kortix.projects`; the canonical `role_assignments` had
no FK on `scope_id`, so the swap would have made "delete a project" stop
retracting its grants. The legacy `iam_policies` never had that FK either, and
410 of its 413 local rows pointed at deleted projects — orphans nothing could
observe and nothing cleaned up.
The rule: **enumerate every FK and every ON DELETE rule on the tables you are
replacing, and reproduce them on the survivor.** Add the FK `NOT VALID`, purge
the pre-existing violations in a batched `.concurrent.ts`, then `VALIDATE` in a
follow-up file.
*Near-miss:* the canonical-RBAC cutover, caught by diffing `pg_constraint` for
the retired tables before writing the migration.
