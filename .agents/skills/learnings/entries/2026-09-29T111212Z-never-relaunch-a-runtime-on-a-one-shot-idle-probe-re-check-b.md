---
recorded: 2026-09-29T11:12:12Z
incident_date: 2026-09-29
---
# Never relaunch a runtime on a one-shot idle probe; re-check busy at the moment of the kill

**Rule:** A decision to kill a runtime that serves turns is valid only at the moment of the kill. Re-check busy (any OpenCode session busy, subagents included; cannot tell = busy) immediately before the kill, not seconds earlier. A busy abort is a deferral, not a failure: it spends no attempt budget. Do not force a relaunch the daemon already does itself at its next `session.idle`.

**Trigger surface:** Any path that restarts the sandbox runtime chain: `legacy-runtime-bootstrap.sh` (`stop_runtime_chain`), `bootstrapLegacyRuntime`, `guaranteeCurrentRuntimeOnOpen`, the box reaper, a new restart or repair route.

**Incident:** 2026-09-29, local stack on Platinum. Session open classified a fresh box `stale` (`running_assets_stale`, `agent_swap_pending`: the daemon had staged the manifest agent and deferred its own swap). The API probed OpenCode idle once, then the script downloaded for 19 s. The user's prompt started 3 s after the probe; the relaunch SIGTERMed the daemon and OpenCode 16 s later. The new daemon aborted the orphaned turn, and the UI said "No reason was reported". `LEGACY_RUNTIME_BOOTSTRAP` defaults on, so any box behind the current daemon can lose its first prompt after a deploy.

**Enforcement:** `apps/api/src/projects/lib/legacy-runtime-bootstrap.test.ts` ("runtime_busy: ...", "the busy re-check runs before the token rotation and the kill ...", "a turn that starts after the idle probe ...", "the manifest agent already staged on a self-swapping daemon is not stale ...") and `legacy-runtime-bootstrap-wiring.test.ts` ("the manifest agent staged on a self-swapping daemon: proceed ...").
