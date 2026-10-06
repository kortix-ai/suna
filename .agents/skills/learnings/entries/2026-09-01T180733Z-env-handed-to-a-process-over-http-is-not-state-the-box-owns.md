---
recorded: 2026-09-01T18:07:33Z
incident_date: 2026-09-01
commit: 32a38fa91e
---
# Env handed to a process over HTTP is not state the box owns; persist it or the first resume loses it

**When:** any handoff where a long-lived box is told WHAT to be at runtime — the
pi worker pool's park/claim, and anything else that boots generic and is
specialised by a request. `park.mjs` received the claim env over HTTP and
spawned the worker with it **in the child process only**, while the container's
own environment still said `KORTIX_PI_PARK=1`. Stop/resume re-ran the
entrypoint, which exec'd the park script again with the claim gone: port 8000
answered `{parked:true,runtimeReady:false}` forever,
`shouldBootstrapSessionRuntime` retried once, and the session could never run
another turn. Its transcript survived; nothing else did.
**Rules:** (1) persist the claim to the box's disk BEFORE acknowledging it, and
prefer it over the generic path on every later boot — the acknowledgement is a
promise the box must be able to keep; (2) a failed persist answers 500 and stays
claimable rather than accepting a claim it cannot honour; (3) whenever a
container has a "mode" env var, ask what re-running the entrypoint does — a
resume is not a fresh create.
**Diagnostic:** a session whose transcript loads but whose every turn hangs, on
a box whose `/kortix/health` says `parked:true`. A cold-created box resumed
fine, so it read as random until the pool was in the picture.
*Near-miss:* pool is gated off everywhere (`KORTIX_PI_WORKER_POOL_TARGET=0`), so
this never reached a user — it would have shipped with the pool.
*Enforcer:* `pi-worker-park.test.ts` boots the real baked script, claims it,
kills the box, and re-boots the SAME disk.
