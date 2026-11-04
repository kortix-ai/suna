---
recorded: 2026-10-30T19:03:47Z
incident_date: 2026-10-30
---
# Every image a session boots needs a last-ready fallback and a pre-roll build

**Rule:** A session start never waits for an image build. Every image kind a session boots (default, project template, `meta`) serves the last image a real session booted while the new one builds, and the dev release gate builds it before the API roll. A reap protects the images that fallback serves, read from a table that actually records that image kind.

**Trigger surface:** adding a new runtime image kind, changing `ensureMetaSandboxImage` / `ensureSandboxImage`, a reap of provider images, or `apps/api/scripts/prepare-platform-default-image.ts`.

**Incident:** 2026-10-30, dev. The default image had a fallback and a pre-roll build; the `meta` image (My Kortix) had neither. Its hash covers the agent, SDK, CLI and shared source, so nearly every deploy moved it, and the first My Kortix session after 6 deploys waited 80–111 s for an inline build. Its reap protection read `project_snapshot_builds`, which never holds `meta` rows, so each new build also deleted the image that replicas still serving the previous version booted. Fixed in #11241.

**Enforcement:** `apps/api/src/snapshots/meta-image-build-dedupe.test.ts` (fallback, no duplicate build, region fallback, startup never falls back). None yet for a new image kind: a review of the image's `ensure*` function against this rule.
