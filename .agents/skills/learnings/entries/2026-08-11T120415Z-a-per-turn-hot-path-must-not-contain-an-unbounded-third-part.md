---
recorded: 2026-08-11T12:04:15Z
incident_date: 2026-08-11
commit: 6dd04ee8f8
---
# A per-turn hot path must not contain an unbounded third-party round-trip

**When:** adding an `await` to the prompt path — `syncSandboxEnvForPrompt`
(`apps/api/src/projects/lib/sandbox-env-sync.ts`) and everything it calls. The
network-boundary sync ran a FULL provider re-arm before every turn: manifest
resolve, GET/PUT sandbox secrets, `ensureSecret` per binding, then
`waitUntilArmed` at 40 × 250 ms — up to ~10 s, past the proxy budget. One egress
secret therefore broke every agent turn in the project. Arm once at session
start or in the background, bound the wait, and fail soft ONLY where a skipped
call cannot widen access (a boundary value never enters the guest, so the worst
case is a 401 upstream, not a leak). It also ran before `postEnvToDaemon`, so its
failure skipped the ordinary runtime-secret push too.
*Incident:* 2026-08-11 — same session, same sandbox: egress secret active →
`prompt_async` 502 in 5.2 s, disabled → 200 in 1.2 s. Found only when the product
owner said "I cannot test this on dev"; the symptom was a spinner stuck on
"Considering next steps…", naming neither secrets nor the provider.
*Enforcer:* none — build it.
