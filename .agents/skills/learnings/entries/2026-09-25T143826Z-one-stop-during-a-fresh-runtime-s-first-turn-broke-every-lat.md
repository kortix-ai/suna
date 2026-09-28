---
recorded: 2026-09-25T14:38:26Z
incident_date: 2026-09-25
commit: 8d0dc807c5
---
# One Stop during a fresh runtime's first turn broke every later turn

**Incident.** A user pressed Stop about 1 s into the first turn of a new prod
session. Every later turn ended within 15–66 ms as `MessageAbortedError`, with
no output and no cancel request. The web showed "This turn stopped before it
finished. No reason was reported." for all of them. Changing the model did not
help, and a new OpenCode session in the same box failed the same way. Over the
previous 7 days, 17 prod sessions on 15 accounts matched this pattern and never
recovered. Upper bound: other failures can also end a turn in under 3 s.

**Cause.** OpenCode builds each per-directory service (tool registry, plugins,
agents, skills, providers, MCP) on first use, in the caller's fiber, and
caches the result forever (`InstanceState` → Effect `ScopedCache`). An
interrupted build is cached too. Verified on effect 4.0.0-beta.83 and rc.117
and on OpenCode 1.18.23 through upstream `dev`. The first prompt of a fresh
instance is usually that first caller. The tool registry also waits for the
config dir's dependencies and imports the project's custom tools, so the
window is about 1 s on Kortix projects. A second gap on our side: the hold
route's settle re-aborted the turn before the browser's own abort and did not
stamp `UserStop`, so even the user's own Stop read as unexplained.

**Rule.** No user-cancellable request may be the first caller of a runtime's
lazily built, forever-cached state. The daemon builds that state itself,
from requests nobody cancels, whenever a runtime instance exists, and gates
turn-starting requests on it. Any "Aborted" nobody asked for is a runtime
fault, not a stop: heal the runtime, then recover or name the cause. Every
path that asks the runtime to abort records the request before it sends it.

**Enforcement.** `apps/kortix-sandbox-agent-server/src/harness/open-code/instance-guard.ts`
(warm-up, prompt gate, poison probe, `POST /instance/dispose` heal, victim
resume through `turn-auto-resume.ts`), tested in `instance-guard.test.ts`
against a mock with the measured poison contract. The API stamps `UserStop`
in the hold route before the settle can abort (`session-prompts.test.ts`,
`inbox-hold-settle.test.ts`, `integration-sandbox-turn-lifecycle.test.ts`).
Root fix upstream: an `InstanceState` must not cache an interrupt-only exit.
Unblock recipe for a stuck box: `POST /v1/p/<external_id>/8000/instance/dispose`.
