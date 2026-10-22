---
recorded: 2026-10-17T20:24:47Z
incident_date: 2026-10-17
---
# Build a project's sandbox image in the region its sessions boot in; a regional copy is the fallback, not the plan

**Rule:** A `us_region` project's own image (`kortix-tpl-*`) is built in that region. The region is part of the image identity (`computeTemplateIdentity` → `projectImageRegion`) and rides on `/v1/templates/from-build/presign` and `/v1/templates/from-build`. A build request without a region lands where the request lands: the home control plane behind `PLATINUM_API_URL`. The region belongs in the name, not only in the request, because Platinum copies one way. The home control plane holds no credentials for a regional bucket, so an image built in `us-east` can never boot in `eu-west`.

**Trigger surface:** `apps/api/src/snapshots/templates.ts` (`computeTemplateIdentity`, `projectImageRegion`), `snapshots/providers/platinum.ts` (`buildOnce`, `swapAgent`), any new build path, and any new region or placement option.

**Incident:** 2026-10-17. A self-host org had every project in `us-east`, yet all 150 of its Platinum builds landed in `eu-west`. Every rebuild was copied to `us-east` when the first session asked for it: 58.1 s at 19:00Z and 66.1 s at 06:27Z, behind the 409 storm in the previous entry. The same evening on Platinum prod, a region-pinned `from-build` was ready in `us-east` in 21 s. A `from-patch` of it stayed in `us-east` (11 s), and both booted with no copy.

**Enforcement:** `apps/api/src/snapshots/templates-region-identity.test.ts` (region in the name and the swap key; home identities unchanged; shared default never regional) and `apps/api/src/__tests__/unit-platinum-snapshot-size.test.ts` ("Platinum build region": presign and from-build bodies).
