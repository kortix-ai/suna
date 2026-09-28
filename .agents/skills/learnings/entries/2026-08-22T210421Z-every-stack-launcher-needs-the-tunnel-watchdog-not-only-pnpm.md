---
recorded: 2026-08-22T21:04:21Z
commit: e356963d2d
---
# Every stack launcher needs the tunnel watchdog, not only `pnpm dev`

2026-08-22. The `timeline-parity` worktree's quick tunnel died three times in
one evening (30 min – 3 h after mint). The symptom in the session UI was
OpenCode `Retrying in 81s · #1 · <none>` — Cloudflare's HTML 530 carries no
message — or `Cannot connect to API …trycloudflare.com/v1/llm-gateway` on the
first prompt. The local API was healthy each time. `scripts/dev-local.sh` had
a watchdog that rotates a dead tunnel and bounces the API; the worktree
launcher (`scripts/worktree/cli.ts`) did not, so every death needed a hand
restart and a new `KORTIX_URL`.

**The rule.** A component that bakes a public callback URL at spawn must own
the liveness of that URL. Any launcher that mints a quick tunnel ships the
watchdog with it: probe the URL while the local API is healthy; on death,
mint a new tunnel and respawn the API with the new URL; say so in the log.
Diagnose a `<none>` retry row by `curl $KORTIX_URL/v1/health` (530 = dead
tunnel) and `pgrep -f 'cloudflared tunnel'`.

**The enforcement.** `pnpm worktree start` now runs `startTunnelWatchdog`
(60 s tick, two-probe confirmation, cloudflared exit detection, API respawn
with the new `KORTIX_URL`). The worktree launcher gets the same tunnel
watchdog as `pnpm dev`. Proven by killing cloudflared on a live stack and
watching the rotation (PR #6755).

*Incident:* session `b090016e…` / `cbde77cf…` on worktree `timeline-parity`,
three tunnel deaths, each surfaced as an OpenCode retry loop.
