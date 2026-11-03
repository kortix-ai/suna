---
recorded: 2026-11-02T23:09:47Z
incident_date: 2026-11-02
---
# A preview template over its size cap fails every preview: raise size_mb and the org cap together

**Rule:** The CI host template (`tests/src/core/platinum-ci.ts` `size_mb`) must stay below Platinum's per-org cap (`limits.org_overrides[org].maxTemplateSizeMb`, default 20,480 MB), and a lockfile that grows the image past `size_mb` needs both raised. `deploy-preview.yml` runs the default branch's copy of this file, so a fix on a pull request does not reach that pull request's own deploy.

**Trigger surface:** `tests/src/core/platinum-ci.ts` (`buildPlatinumTemplateSpec`), dependency upgrades that change `pnpm-lock.yaml`, the first preview after a lockfile change.

**Incident:** 2026-11-02, dev at deab382f8d. The new lockfile built a 14,560 MB image that needed 20,640 MB with headroom, over the 20,480 MB cap. The preview deploy failed at the template step (`built image needs 20640 MB`), and raising only `size_mb` failed with `400 template_size_cap_exceeded`. Fixed with `size_mb: 24_576` and `maxTemplateSizeMb: 32768` on the Kortix Dev org. Every preview on that lockfile was blocked until the cached template existed.

**Enforcement:** none yet. To build: a check in the preview deploy that logs the built image size against `size_mb`, and warns past 90 %, so the cap is raised before the build fails.
