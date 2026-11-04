---
recorded: 2026-11-04T14:46:37Z
incident_date: 2026-11-03
---
# A gate that holds Send, a page shell or a redirect reads the project row, never the project detail

**Rule:** A value that holds an interaction or a whole page (a send or run gate,
a page-level `settled`/skeleton, a feature flag, a redirect) reads the project
row: `qk.project.summary` / `getProject` (`GET /projects/:id`, one database
read). The detail (`qk.project.detail`, `GET /projects/:id/detail`) is for the
config summary only (agents, skills, commands, `manifest_raw`): it reads the
repository and can take seconds, or fail with `503` at the 25 s deadline. The
row already carries `account_id`, `name`, `metadata` and the flags.

**Trigger surface:** adding a `useQuery` on `qk.project.detail` for a
`project.*` field; gating `isLoading`, `settled`, `beforeSend` or a redirect on
any query; adding a Customize or project-shell section.

**Incident:** 2026-11-03, dev, an internal project with a large repository:
`/detail` hung up to 25 s and returned `503`. The sidebar and sessions list
waited on flags read from it (fixed in #11651). After that, Send still sent
nothing until `/detail` answered, and every Customize tab showed a skeleton,
both for `account_id` only (fixed in #11754).

**Enforcement:** `packages/ui/src/internal/hooks/projects/use-project-can-run.test.tsx`
(the run gate answers while the detail never settles). No guard covers a new
gate yet: none yet, a browser journey that holds `/detail` and asserts Send and
Customize would be the enforcer.
