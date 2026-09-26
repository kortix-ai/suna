---
recorded: 2026-09-07T21:17:40Z
incident_date: 2026-09-08
commit: 4cbf835b08
---
# Token publication must not look like sign-out to waiting requests

**When:** fencing in-flight auth reads against cache writes. Distinguish a token
publication from a clear. Return the fresh published token after hydration;
return null when a clear occurred after the read began, including clear-then-sign-in.
*Incident:* #7065 made a valid session return null when AuthProvider published
during a token read. The project gate displayed "This project didn't load."
*Enforcer:* `apps/web/src/lib/auth-token.test.ts` covers concurrent hydration,
bootstrap, sign-out followed by sign-in, and expired publications.

**Identity-change near-miss:** Cross-tab `SIGNED_IN` can replace a user without
`SIGNED_OUT`. Clear bootstrap and cached tokens synchronously when `adoptUser`
requires a reset, before its first await. Otherwise pending requests can inherit
the incoming user's token. `auth-provider-identity.test.ts` pins this ordering.

**Cold-load ordering:** The project-access query must wait for AuthProvider's
resolved user. Otherwise first-load identity cleanup cancels its token read and
leaves the non-retrying gate on an error. Key access results by user and show
pending while auth is unresolved. CI's fresh-browser localization journey
reproduced the failure; `project-access-boundary.test.ts` pins the wiring.
AuthProvider declares initial readiness only after bootstrap validation and
cleanup finish, not from an earlier `INITIAL_SESSION` event. Keep the signed-out
redirect above the pending gate and use the user-scoped key for admin bypass.
