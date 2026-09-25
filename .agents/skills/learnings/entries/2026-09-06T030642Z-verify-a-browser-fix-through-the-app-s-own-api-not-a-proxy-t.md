---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-05
commit: 3caec60726
---
# Verify a browser fix through the app's OWN API, not a proxy to another stack

**When:** browser-verifying a worktree's web change. `NEXT_PUBLIC_BACKEND_URL`
is inlined into the client bundle at compile, so a hand-booted `pnpm dev` that
does not set the worktree's full env bakes `localhost:8008` — the browser then
calls the PRIMARY api cross-origin and every request dies on CORS
("This project didn't load / Failed to fetch"), testing nothing. `pnpm worktree
start <name>` sets `NEXT_PUBLIC_BACKEND_URL`, `KORTIX_API_PROXY_TARGET`,
`FRONTEND_URL`, `CORS_ALLOWED_ORIGINS` and `KORTIX_INSTANCE_ID` together
(`scripts/worktree/lib/launch-env.ts`). **The rule:** boot a worktree for
browser verification with `pnpm worktree start`, and PROVE the bundle hit the
branch api — assert the `/v1/` request host is the worktree api port before
trusting the result. A green DOM over the wrong backend is a false pass.
