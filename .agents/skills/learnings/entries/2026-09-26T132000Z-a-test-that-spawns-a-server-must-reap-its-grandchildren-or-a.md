---
recorded: 2026-09-26T13:20:00Z
incident_date: 2026-09-26
---
# A test that spawns a server must reap its grandchildren, or a later run fails on a port it never bound

**Rule:** When a test spawns a process that itself spawns a listener, kill the
process GROUP in `afterEach`, not the direct child. A surviving grandchild keeps
its port, and a later run that picks a port at random from a narrow range hits
it, gets a `200` from the wrong server, and fails an assertion about content it
never produced. Before attributing such a red to the branch under test, check
for orphans: `lsof -nP -iTCP -sTCP:LISTEN` over the range, and `curl` the port —
the body names the leaker.

**Trigger surface:** Any test that `spawn`s a server and asserts against
`http://127.0.0.1:<port>`, especially one that draws the port from a fixed range
instead of binding `:0` and reading the assigned port. In this repo:
`apps/api/src/snapshots/pi-worker-park.test.ts`, whose `bootPark` uses
`18800 + Math.floor(Math.random() * 500)` and whose `afterEach` kills only the
park server, never the session worker the park server hands the port to.

**Incident:** 2026-09-26, near-miss, no customer impact, local only.
`bash scripts/test.sh` in `apps/api` failed twice in a row on `pi worker park
server > full claim handshake hands the port to a worker running the claim env`
with `Expected: true, Received: undefined`, while the same file passed alone
(`1 pass`). The failure was nearly attributed to an unrelated branch, then to
the merge that preceded it. Neither was the cause: 55 orphaned
`session-worker.mjs` processes from earlier runs — the oldest 12 hours old —
were still listening in 18800-19299, and each answered
`{"ok":true,"runtimeReady":true,"sessionId":"sess-42"}` with no `parked` field,
which is exactly the observed value. `bootPark` polls `/kortix/health` until a
`200`, so it accepted an orphan's reply as its own server's. Killing the
orphans returned the suite to `10580 pass · 0 fail · exit 0`.

**Enforcement:** none yet. The durable fix is for `bootPark` to bind `:0` and
read the assigned port, and for `afterEach` to kill the process group
(`spawn(..., { detached: true })` + `process.kill(-child.pid)`), so a leak
cannot poison a later run. Until that lands, the rule is the enforcer.
