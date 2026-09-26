---
recorded: 2026-09-21T17:26:44Z
incident_date: 2026-09-21
commit: 6e6640a741
---
# Freeing a port means waiting for it, not just deleting what held it

**Rule:** A CI step that clears host ports for a following service must POLL
until each port is actually free, then name the holder if it never clears.
Deleting the container is not the same as getting the binding back.
**Trigger surface:** any workflow step that stops one service and starts
another on the same ports. **Incident:** run `35630898515`, `browser-1` lane,
`main` @ `3c67a5e0b6` — the sweep added hours earlier ran clean, `supabase
stop` succeeded, `docker ps -aq --filter publish=54324` matched nothing, 54322
then bound fine, and 54324 still failed with `address already in use`. Nothing
was left to delete. The bind had not been released yet. The lane read as a test
failure for the third time. **Enforcers:** the `ss -ltnH` wait plus the
`::warning::port … is still bound` diagnostic in `tests.yml`'s "Free the local
Supabase ports", asserted by `tests/unit/sandbox-workflow.test.ts`.

**Meta-rule from three occurrences of one symptom:** each was diagnosed by
inference — stale containers, then a release race — and each fix was shipped
without evidence naming the actual holder. When a failure recurs after a fix,
the next change must make the NEXT occurrence self-diagnosing before it makes
another guess at the cause.
