---
recorded: 2026-11-02T18:57:02Z
incident_date: 2026-11-02
---
# A session start never waits silently on its image: every wait is a named step the client shows, bounded by a budget

**Rule:** `ensureSandboxImage` reports every wait through `onStep` (`resolving`, `serving_last_ready`, `waiting_for_build`, `building`, `copying_to_region`), and provisioning reports `waiting_for_provider` while Platinum finishes an image. The step lands on the sandbox row (`metadata.imageStep`), `/start` returns it as `boot.image`, and the SDK (`useSession().bootImage`), web, mobile, TUI and CLI show it. A session start resolves through `ensureSessionImage`: past `SESSION_IMAGE_BUDGET_MS` (8 s) it boots the image its project booted last (`runtimeArtifact` with `spec`) and logs the step that was slow. A new wait in the image path gets a named step and a timed mark, or it does not merge.

**Trigger surface:** `apps/api/src/snapshots/builder.ts` (`ensureSandboxImage`, `ensureSessionImage`, `templateRegionResident`), `apps/api/src/platform/services/session-sandbox.ts` (`resolveImage`, `imageStepReporter`, the provider retry hooks), `sandbox-init-state.ts` retries, and `deriveBoot` in `start-envelope.ts`.

**Incident:** 2026-11-02, local stack. The first session on a project waited 67 s in image resolution and reported "cache hit". No log line named a step, and the user saw a bare "provisioning". The API process had hot-reloaded about 100 s earlier. Every step re-measured afterwards took under 1 s, so the cause could not be reconstructed; the fix makes any recurrence named, visible and bounded. The same pass found a second silent wait: provider "still building" refusals retried 30 times at 10 s under a plain "provisioning". It also found a stale test: `builder-region-resident.test.ts` failed 2 of 3 on dev, because placement now reads the `drives` table with a non-UUID test id.

**Enforcement:** `apps/api/src/snapshots/builder-session-image.test.ts` (budget, fallback, no fallback, failed lookup), `builder-region-resident.test.ts` (copy notification), `projects/session-lifecycle/start-envelope.test.ts` (`boot.image` only while provisioning, malformed is null), `packages/sdk/src/react/use-session-boot-image.test.ts`, `apps/cli/src/__tests__/session-start-image.blackbox.test.ts`, `apps/web/src/features/session/session-image-status.test.tsx`, `apps/tui/.../boot-status.test.ts`, `apps/mobile/lib/session/connect-step.test.ts`. The provision timeline names each step (`image-step:<name>`), and `[snapshots] slow image step` logs any step of 2 s or more.
