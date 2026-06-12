# comp

Main comp monorepo

- `core/docker/.env` should mirror the sandbox Docker env file used in the sibling `computer` repo when local Docker sandbox commands require a missing env file.
- `scripts/setup-env.sh` is the canonical generator for `apps/api/.env` and `apps/web/.env` from the root `.env`; currently `apps/web/.env` is missing in `comp` even though root `.env` already contains the needed `NEXT_PUBLIC_*` Supabase values.
- `apps/web/src/middleware.ts` resolves Supabase runtime config in this precedence order: URL = `SUPABASE_SERVER_URL` -> `SUPABASE_URL` -> `KORTIX_PUBLIC_SUPABASE_URL` -> `NEXT_PUBLIC_SUPABASE_URL`; anon key = `SUPABASE_ANON_KEY` -> `KORTIX_PUBLIC_SUPABASE_ANON_KEY` -> `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- If `apps/web/.env` is missing in `comp`, copying the sibling `computer/apps/web/.env` restores the `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` values used by the middleware fallback chain; avoid overwriting `apps/api/.env` when it already exists.
- Local preview/proxy routing in `apps/api/src/sandbox-proxy/index.ts` changes behavior based on `ALLOWED_SANDBOX_PROVIDERS`: `local_docker` proxies directly without DB lookup, but `justavps` first resolves the sandbox by `sandboxes.externalId`; if local dev env is copied from a cloud config, `/v1/p/{sandboxId}/{port}` can fail with `{"error":"Sandbox not found"}` even when the local stack is up.
- `/.opencode/plugin/kortix-system/auth.ts` is not Claude Code-equivalent auth: its `Claude Pro/Max` path only requests `user:inference`, refresh also narrows to `user:inference`, and it lacks Claude Code's full-scope Claude.ai flow, auth-mode gating for third-party/external key scenarios, localhost callback listener, profile/account persistence, and 401 refresh-retry behavior.
