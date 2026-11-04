---
recorded: 2026-10-24T19:13:46Z
incident_date: 2026-10-24
---
# Keep a shared template's last ready image per provider, never in the one row pointer

**Rule:** A boot fallback for a shared sandbox template reads `sandbox_templates.metadata.lastReady.<provider>`. Never derive it only from `provider_snapshot_name`, which follows whichever provider built last. Reap a predecessor only on the provider it lives on.

**Trigger surface:** Changes to `recordTemplateBuilt`, `findServableLastReadyImage`, the startup pre-build, or the release-gate image build in `apps/api/src/snapshots/`.

**Incident:** 2026-10-24, dev at `aa2ddb23`. The Dev release gate registered the new default image on Platinum at 18:06 UTC. The Platinum build host claimed the build and never streamed output, so the template stayed `building`. At 18:31 the Daytona startup pre-build repointed the shared `default` row at that identity. Every Platinum session boot after that found no fallback. It waited up to 12 min, failed with "still building on platinum", and dead-lettered its first prompt. Platinum's stall reconciler skips builds with a NULL heartbeat, so the template never terminalized. Fixed in #10899. Detection took a user report: no log line named the wait.

**Enforcement:** `apps/api/src/snapshots/last-ready-image.test.ts` ("a build on another provider does not hide this provider's last ready image") and `templates-record-reap-async.test.ts` ("a build on another provider never reaps…"). Both fail on the old code. The stable log `[snapshots] no ready image to serve; waiting for the build` marks every boot that waits.
