---
recorded: 2026-08-23T15:20:51Z
incident_date: 2026-08-23
commit: 3926a01abf
---
# A typed list from a remote endpoint is not a list — normalize it at the SDK seam

**When:** adding or touching any `@kortix/sdk` hook that returns a LIST from the
runtime or platform API. Coerce the response with `asRuntimeList` and read the
localStorage placeholder with `cachedRuntimeList`, so a body with an unexpected
shape degrades to "no items" instead of reaching a render that iterates it.
*Incident:* `GET /command` returned a truthy non-array on dev; the session view
crashed into its error boundary with `TypeError: t is not iterable` from
`detectCommandFromText`, and the bad value was cached, so a reload did not clear
it. Fixed by PR #6790. *Enforcer:* `shared.test.ts` covers both helpers; the
guard is only real for hooks that call them — check the call site in review.
