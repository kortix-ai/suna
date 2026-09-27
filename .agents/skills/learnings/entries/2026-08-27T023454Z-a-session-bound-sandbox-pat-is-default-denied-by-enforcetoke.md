---
recorded: 2026-08-27T02:34:54Z
commit: 39685da48d
---
# A session-bound sandbox PAT is default-denied by enforceTokenProjectScope: whitelist each new sandbox->API surface

- **Incident (2026-08-27, WS-Z4):** the same runtime-projection push ALSO 403'd before it ever reached its handler. The in-sandbox `KORTIX_TOKEN` is one project+SESSION-scoped PAT ("One sandbox, one session-scoped Kortix credential"), and `enforceTokenProjectScope` in `apps/api/src/middleware/auth.ts` is DEFAULT-DENY: any surface not explicitly allowed 403s with "Project-scoped token cannot call this surface". A new sandbox->API route (`/v1/platform/runtime-projection`, the boot-timeline sibling) had no allowance, so the daemon's push died at the gate on every environment. Same class as the earlier `/v1/skills` and `/v1/runtime-assets/` 403s that shipped for the same reason.
- **Rule:** whenever the sandbox daemon gains a new API route, add an explicit branch to `enforceTokenProjectScope` (gated on session-binding for a sandbox-only surface) AND a regression test in `auth.test.ts` — the route's own handler test does not mount `combinedAuth`, and the e2e flows exercise only ANON + a Supabase-JWT owner, so nothing else catches it.
- **Enforcement:** `enforceTokenProjectScope` now allows `/v1/platform/runtime-projection` for a session-bound PAT only; `auth.test.ts` pins both the allow (session-bound) and the deny (plain project PAT). The handler still re-verifies the sandbox↔session binding via `isSessionSandboxCredential`.
