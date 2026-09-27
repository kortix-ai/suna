---
recorded: 2026-09-05T19:18:03Z
incident_date: 2026-09-05
commit: c75d736863
---
# Edge middleware imports locale constants from a leaf module

**When:** adding locale routing or other i18n behavior to Next.js middleware.
Import locale constants from `i18n/catalog.mjs`. Do not import `i18n/config.ts`,
because its dynamic message loader makes every translation catalog reachable
from the Edge bundle. *Near-miss:* PR #7109 built locally, but Vercel rejected
the 4.76 MB middleware above its 4.02 MB plan limit. *Enforcer:*
`middleware-public-routes.test.ts`; verify the production middleware manifest.
