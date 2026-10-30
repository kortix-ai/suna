---
recorded: 2026-10-22T23:43:12Z
incident_date: 2026-10-22
---
# A deployed smoke failure that repeats on its rerun is a regression until a repro proves otherwise

**Rule:** When the release suite's `deployed api smoke` fails twice (the run and its automatic rerun), treat it as a product regression. Reproduce it against staging with a synthetic user before calling it environmental. "Waiting for the current default image" and "Timed out waiting for sandbox fixture readiness" also fire when the image is fine and the session runtime inside it cannot start.

**Trigger surface:** Triage of a red release PR into `prod`, especially when the release changes kortixd, the harness, the sandbox image or the model catalog.

**Incident:** 2026-10-22, release v0.14.7 (#10730). The smoke timed out twice. The first read was "staging is rebuilding the default image". A repro on staging showed every OpenCode session looping `starting` → `failed`: since #10757, the gateway can send a model window with no output limit, and OpenCode rejects its whole config (`ConfigInvalidError … limit.output: Missing key`). In prod this would have broken every OpenCode session. Fixed by #10776 before the merge into `prod`.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/opencode-catalog.test.ts` (a window with no output limit gets one). The release suite's deployed smoke boots a real OpenCode session on staging. The triage rule itself is this entry.
