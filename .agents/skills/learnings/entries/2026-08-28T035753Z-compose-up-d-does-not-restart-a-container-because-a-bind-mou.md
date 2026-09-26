---
recorded: 2026-08-28T03:57:53Z
incident_date: 2026-08-28
commit: e6d8498302
---
# `compose up -d` does not restart a container because a bind-mounted FILE changed

**When:** a redeploy rewrites a config file that a container reads through a
bind mount — a Caddyfile, an nginx conf, a prometheus.yml. Compose recreates a
container for a new image, env var, port or volume DEFINITION; new bytes inside
an already-mounted file are not part of that comparison. If the process does not
watch its config either (Caddy does not), the container keeps serving what it
loaded when it first booted, for as long as the box lives.

A per-PR preview never showed this because it is deleted and recreated on every
push. It appeared the first time a REUSED environment's config actually changed:
moving the branch environment to `pi.kortix.com` rewrote the Caddyfile's pinned
`X-Forwarded-Host`, the file said the new host both on disk and inside the
container, and the running Caddy still pinned the old one — so every Server
Action died with React #441 again (see the entry below).

**The rule: after writing a mounted config, reload the process that reads it**
(`compose exec -T <svc> caddy reload --config …`), or recreate that service
explicitly. Never infer from "compose up succeeded" that a mounted config took
effect.

**Diagnostic:** compare the file with the process's LIVE configuration, not with
the file inside the container — those two agree even when the bug is present.
For Caddy, `curl localhost:2019/config/` from inside the container; the same
shape of check applies to any config-reloading daemon.
*Near-miss:* the pi branch environment, 2026-08-28. Caught within minutes by
driving the real sign-in page; nothing deployed was affected.
*Enforcer:* `tests/unit/sandbox-preview.test.ts` asserts the bootstrap issues
the reload. Nothing detects a NEW mounted config file that lacks one.
