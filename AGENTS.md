# Kortix project

## You CAN run and verify everything end-to-end. Do it.

This repo ships a **complete, runnable local stack with live cloud sandboxes**.
Do not claim you "can't verify from here" or hand back unverified work — you
have everything needed to run the app, hit the real API, provision real
Daytona sandboxes, drive the real UI in a browser, and assert behavior. Use it.

### The stack (already wired)
- **Web** — Next.js dev server on `http://localhost:3000`.
- **API** — Bun server on `http://localhost:8008/v1` (`/health` returns JSON).
- **Supabase** — local, on `http://127.0.0.1:54321` (Docker).
- **Sandboxes** — REAL Daytona cloud sandboxes (`DAYTONA_API_KEY` in
  `apps/api/.env`). Each project session gets its own sandbox; `session_id ==
  sandbox_id`. The OpenCode runtime inside a sandbox is reached via the API
  proxy: `http://localhost:8008/v1/p/<external_id>/8000/...` (SSE event stream
  at `…/event`).
- **Tunnel** — `scripts/dev-local.sh` (`pnpm dev`) auto-starts a cloudflared
  quick tunnel so cloud sandboxes can call back to the local API (`KORTIX_URL`).

Bring it up with `pnpm dev` from `suna/` (it loads `apps/api/.env` +
`apps/web/.env`, starts Supabase, the API, the web app, and the tunnel). Check
what's already running before starting a duplicate: `curl -s
localhost:8008/v1/health`, `lsof -iTCP:3000 -sTCP:LISTEN`.

> **`apps/api/.env` is dotenvx-encrypted** (committed ciphertext; values show as
> `encrypted:…`). `pnpm dev`/`pnpm dev:api` decrypt it via `dotenvx run` using
> the key in `apps/api/.env.keys` or Dotenv Armor (`dotenvx-armor login`). To
> read a value: `pnpm dlx @dotenvx/dotenvx get KEY -f apps/api/.env`; to
> add/rotate: `… set KEY value -f apps/api/.env` then commit. Never write
> plaintext to `apps/api/.env` — runtime overrides go in the gitignored
> `apps/api/.env.local`.

### Authenticating to the live API (for scripts/tests)
Mint a real JWT against local Supabase, then call the API with it:
1. `SUPABASE_SERVICE_ROLE_KEY` lives in `apps/api/.env`; the anon key
   (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) in `apps/web/.env`.
2. Create a confirmed user: `POST 127.0.0.1:54321/auth/v1/admin/users`
   (`apikey` + `Authorization: Bearer <service_role>`, body
   `{email,password,email_confirm:true}`).
3. Password-grant for the token: `POST
   127.0.0.1:54321/auth/v1/token?grant_type=password` (`apikey: <anon>`).
4. Call the API: `Authorization: Bearer <access_token>` against
   `localhost:8008/v1` (e.g. `/accounts`, `/projects/provision`,
   `/projects/:id/sessions`, `/p/<ext>/8000/...`).

See `tests/e2e/helpers/auth.ts` for the exact calls.

### End-to-end harnesses (the canonical way to verify)
- `bun tests/e2e/scripts/session-smoke.ts` — full single-session flow:
  provision project → snapshot ready → create session → sandbox active →
  OpenCode reachable → prompt → assert a real assistant reply. Self-cleans.
- `bun tests/e2e/scripts/multi-session-stream-smoke.ts` — provisions **two**
  sessions and opens **two concurrent SSE streams**, asserting both sandboxes
  stream live at the same time (regression guard for parallel sessions).
- `tests/e2e/specs/*.spec.ts` — Playwright UI specs. `tests/e2e/end-to-end.md`
  is the flow source-of-truth.
- Provisioning is slow (snapshot build up to ~9 min, sandbox up to ~5 min) —
  run long checks in the background and poll the log.

### Driving the real UI (chrome-devtools MCP)
- Routes are auth-gated (`/dashboard`, `/projects/*` → redirect to `/auth`
  unauthenticated); sign in first (seed a user as above, then log in via the
  `/auth` form, or inject the Supabase session).
- The MCP uses a dedicated Chrome profile at
  `~/.cache/chrome-devtools-mcp/chrome-profile` (separate from your normal
  browser). If launch fails with "browser is already running for … profile",
  kill the orphaned Chrome using that profile and remove
  `chrome-profile/Singleton{Lock,Cookie,Socket}`, then retry.
- Next.js dev compiles routes on first hit — first navigation to a cold route
  can take 30–60s; warm it with `curl` or use a generous navigation timeout.

### Frontend type/lint gate
- `apps/web` `tsc --noEmit` emits ~1500 BOGUS `TS2786` / `IntrinsicAttributes`
  errors from a React 19↔18 types mismatch — ignore those; grep for YOUR files.
- `npx eslint <files>` should be clean.
