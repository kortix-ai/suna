---
recorded: 2026-10-07T12:57:34Z
incident_date: 2026-10-01
---
# Never persist a value that names a listener the writing process owns; restore only values the next process cannot re-derive

**Rule:** A daemon env value that names something THIS process started (a
localhost port, a socket, a pid) never goes into a snapshot a later process
restores. Boot code that skips starting a listener because its URL is
already in `process.env` must only ever see a URL this process set.

**Trigger surface:** Adding a name to `OPENCODE_RUNTIME_ENV_NAMES` or any
other persisted runtime-env set in `apps/kortix-sandbox-agent-server`;
adding a boot guard of the form `if (!process.env.X) start…()`.

**Incident:** 2026-10-01 to 2026-10-07, prod. PR #8329 persisted
`KORTIX_LLM_PROXY_URL`. After any daemon restart (agent-swap self-update,
OOM relaunch, Platinum stop/start) boot restored it, skipped `startLlmProxy`,
and OpenCode sent every model call to a closed `127.0.0.1:4319`: "Cannot
connect to API: Unable to connect". 330 failed messages in 13 sessions in
21 days, 12 of them Platinum. A box stayed broken until its VM was replaced.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/opencode-runtime-env-survives-daemon-restart.test.ts`
("the LLM proxy URL is never restored").
