---
recorded: 2026-09-14T20:58:20Z
incident_date: 2026-09-14
commit: 8541359bdb
---
# Moving a surface under a URL namespace must move every reader, and an effect must never depend on a per-render localized object

**When:** relocating a page into an overlay/modal that prefixes its query
params, or localizing a static catalog through a function that returns a new
object. (1) Inside the account hub read state only through
`useHubSearchParams()`; a raw `useSearchParams().get('provider')` is always
`null` because the URL carries `accountProvider`. (2) Memoize localized objects
and key effects on primitive ids — `localizeProviderGuide()` returned a new
guide each render, so the progress-restore effect looped and reset the step.
*Incident:* SSO + SCIM setup wizards unusable on dev/staging/prod from
`123c1d91c5` (2026-09-08, provider pick did nothing) and `ebaae4d247`
(2026-09-04, Back/step rail snapped back, `Maximum update depth exceeded`).
*Enforcer:* `apps/web/src/features/accounts/hub/hub-search-params.test.ts`
(no hub-rendered file reads a hub key off the raw URL) and browser journey
`tests/e2e/specs/28-identity-setup-wizard.spec.ts` (every step, reload,
change provider, fails on render-loop console errors).
