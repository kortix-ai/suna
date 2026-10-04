---
recorded: 2026-10-01T16:28:50Z
incident_date: 2026-10-01
---
# Never let an object grant count as a role binding for an agent service account

**Rule:** An agent's service account is `activated` only by a scope-level role
binding (`role_assignments.object_type IS NULL`). An object grant to the
service account (a secret, a connector account, any future shareable object)
gives access to that one object and never changes the agent's ceiling. When
you add a new principal type to object grants, grep every query on
`role_assignments` by `principal_type`/`principal_id` and decide for each one
whether object grants belong in it.

**Trigger surface:** Adding a principal type to object grants (`assignRole`
with `object`), any query that probes `role_assignments` for "does this
principal have a role", `iam/actor.ts`, `iam/authorize.ts` step 5a.

**Incident:** 2026-10-01, dev only, 38 min (live on dev 15:56Z with #8635, fixed 16:34Z with #8638). #8635 let a secret be shared
with an agent: `setSecretAudience` writes an object grant for the agent's
service account. `loadServiceAccountActivation` counted any live
`role_assignments` row, so the agent became `activated`. `authorize.ts` step 5a
then used its bound roles as the ceiling instead of `AGENT_DEFAULT_CEILING`.
`resolvePrincipal` skips object grants, so that ceiling was empty, and every
governed session of the agent got `403 agent_ceiling_insufficient` on
`project.session.read` / `project.session.start`. A teammate session found it
from one dev row. Fixed in #8638: the probe adds `isNull(roleAssignments.objectType)`. Dev re-check: a `kortix` session with a secret shared with `kortix` started and read sessions.
Local flows stayed green because no flow ran a governed session of an agent
after an object grant to that agent.

**Enforcement:** `apps/api/src/__tests__/integration-iam-build-actor.test.ts`,
"an OBJECT grant to the service account (a shared secret or account) does not
activate it". It fails when the probe counts object grants again.
