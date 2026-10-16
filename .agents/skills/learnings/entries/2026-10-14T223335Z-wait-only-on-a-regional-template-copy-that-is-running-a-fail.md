---
recorded: 2026-10-14T22:33:35Z
incident_date: 2026-10-14
---
# Wait only on a regional template copy that is running; a failed or impossible copy boots the session in the home region

**Rule:** Read `state` on Platinum's `409 template_not_resident`. Wait (`SnapshotStillBuildingError`) only on `replicating`: a copy runs. On `failed` (the copy failed under 2 min ago) or `absent` (that control plane cannot copy), create the same box again without `region`, in the home region, and log Platinum's `error`. `us_region` chooses compute placement only. A warm (speculative) box never leaves its region: it fails fast. Platinum retries a failed copy on its own on the next regional create or `POST /v1/templates/:id/prepare` after its 2-min cooldown; no Kortix retry call exists or is needed.

**Trigger surface:** `apps/api/src/platform/providers/platinum.ts` create path, `regionalTemplateRefusal`; any new provider region, image build, or release gate that makes an image resident in a region.

**Incident:** 2026-10-14 ~21:42–22:05 UTC on dev. A deploy changed the platform default image. Its copy to `us-east` failed on every retry: Platinum could not read one source chunk ("failed 4 times: an unexpected error has occurred"). Every new session of a project with `us_region` on waited ~5 min (30 × 10 s) and ended `failed`. The dev release gate saw `failed/cooling_down` for its whole 12-min window on two deploys; it does not block the roll by design.

**Enforcement:** `apps/api/src/platform/providers/platinum-region.test.ts` ("us_region: a template not yet copied to the region": replicating waits; failed and absent create again in the home region; a warm box fails fast).
