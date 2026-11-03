---
recorded: 2026-11-03T02:38:42Z
incident_date: 2026-11-03
---
# Regenerate both route catalogs after changing route registrations

**Rule:** Run the route generator and then the web audit-route generator. Do not insert a route into either generated catalog by hand. Preserve the generator's ordering even when the route set is unchanged.

**Trigger surface:** Changing API route registrations or resolving conflicts in the generated route catalogs.

**Incident:** Release v0.14.17, run 41562465631 attempt 3, failed the live-route manifest check because the Drive access-delete route followed admin-reads instead of preceding it. The route set was correct; the committed order was not. Regenerating both catalogs fixes the check without changing an endpoint or weakening an assertion.

**Enforcement:** `apps/api/src/__tests__/unit-routes-manifest.test.ts` compares the committed catalog with the real generator output. It fails before regeneration and passes after it. The web audit registry test verifies route labels.
