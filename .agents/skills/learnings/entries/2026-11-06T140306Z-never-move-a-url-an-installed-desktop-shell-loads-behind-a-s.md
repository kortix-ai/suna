---
recorded: 2026-11-06T14:03:06Z
incident_date: 2026-11-06
---
# Never move a URL an installed desktop shell loads behind a server redirect until every shell in use allows the new path

**Rule:** An installed Electron shell loads only the paths in its own `nav-rules.js` list, and its `will-redirect` gate opens every other target in the system browser, leaving the window empty. When a web route moves, keep serving the old path to the `KortixDesktop` user agent (a rewrite, not a 308), send that UA's server redirects to paths its shipped list allows, and drop the compatibility only after the shell update has reached users. Every shell sends the same UA token, so the web cannot tell an old shell from a new one.

**Trigger surface:** Changing `next.config` `redirects()`, a middleware redirect, the sign-in callback destination, or the app's route prefixes.

**Incident:** 2026-11-06, PR #11857 (Workspaces) before merge: the `/projects` → `/workspaces` 308s, the desktop root bounce and the landing door would have opened every page of every installed shell in the browser. Found in review; never shipped.

**Enforcement:** `apps/web/src/lib/workspace-redirects.test.ts` runs the pre-release shell path list against the redirect table and the middleware landing paths; `apps/web/src/middleware-desktop-routes.test.ts` asserts the desktop bounce target.
