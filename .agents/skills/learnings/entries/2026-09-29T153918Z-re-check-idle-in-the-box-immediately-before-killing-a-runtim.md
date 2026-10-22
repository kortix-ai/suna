---
recorded: 2026-09-29T15:39:18Z
incident_date: 2026-09-29
---
# Re-check idle in the box immediately before killing a runtime, never only before the slow work

**Rule:** A repair that kills the session runtime checks "no turn is running" in the
box, immediately before the kill. A check made before a download, an install, or any
other slow step is stale by the time the kill runs. A busy box defers the repair and
spends no attempt. Separately: a relayed provider 4xx never carries a word OpenCode's
retry classifier matches (`server_error`, `internal error`, `overloaded`, ...), because
OpenCode retries on body text whatever the status.

**Trigger surface:** editing `apps/api/src/projects/lib/legacy-runtime-bootstrap.sh` or
any other path that restarts the daemon or OpenCode on a live box; relaying an upstream
error body from `packages/llm-gateway`.

**Incident:** 2026-09-29, dev. Every first message in a new session on a box one
manifest build behind died with "This turn stopped before it finished. No reason was
reported." Session open ran the legacy bootstrap: the API saw OpenCode idle, the script
downloaded the ~110 MB agent (~10 s), the prompt landed, and the relaunch SIGTERMed it.
The same turn also hit a permanent OpenCode Go 400 labelled `server_error`, which
OpenCode replayed 5 times.

**Enforcement:** `legacy-runtime-bootstrap.test.ts` ("pt-app re-checks OpenCode idle
after the download, before the token swap and the kill"; "a turn that starts during the
repair defers the relaunch and spends no attempt"). `simple-handler.test.ts` ("a
provider 4xx labelled server_error reaches the client without the label OpenCode
retries on").
