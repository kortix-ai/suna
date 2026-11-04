---
recorded: 2026-10-30T10:08:03Z
incident_date: 2026-10-30
---
# Recheck preview service readiness after each host start

**Rule:** Recheck Docker and current API, frontend, and gateway SHAs after each preview host start. Gate fixture writes on those checks and database isolation. Run persistent daemon recovery in a detached session and verify it through a second independent exec.

**Trigger surface:** Persistent preview hosts after a stop/start cycle or a model-capacity pause.

**Incident:** PR 11136's preview deployed successfully at 00:59 UTC. The host later stopped and started while its retained phase file still said ready. Docker was absent. Current health gates blocked every fixture write. A direct daemon launch did not survive its exec session. Detached startup and unchanged retained-service startup restored all three expected SHAs. The provider stop cause remains unknown.

**Enforcement:** `assertTargetSmokeHealth` and `waitForTargetSha` in `tests/src/core/target-smoke.ts` require current health and the expected SHA. The preview bootstrap requires `docker info`. The owned proof controller also verifies empty database counts before creating fixtures. Recovery preserves existing images, configuration, and database data.
