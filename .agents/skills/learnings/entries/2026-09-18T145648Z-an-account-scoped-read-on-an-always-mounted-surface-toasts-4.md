---
recorded: 2026-09-18T14:56:48Z
incident_date: 2026-09-18
commit: 088e0aa7e5
---
# An account-scoped read on an always-mounted surface toasts 403 at every member

**Rule:** before adding a query to a component that renders on every project
page, ask who gets a 403 from it. `GET /accounts/:id/secret-resources` answers
403 to anyone who is not a member of the ACCOUNT — a project member need not be
— and the SDK toasts a 403 by default (`showErrors` defaults true,
`apps/web/src/lib/error-handler.tsx`). Gate such a read on the feature flag its
routes require AND on a user action (popover open), so the request is
user-initiated like the provider modal's. **Near-miss:** the model picker's new
credential read ran on every project page load; the 403 appeared in a real dev
log on the branch, not in review. Same class as Marko's member 403-toast storm.
**Enforcer:** none — the toast is 30 s-deduped, so it is quiet in a single
session and loud across a team. Until one exists, grep a new `use*Query` in an
always-mounted component for its route's authorization, and check
`provider-connect.tsx`'s gate shape as the precedent.
