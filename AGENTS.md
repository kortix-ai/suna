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

> **Secrets are dotenvx-encrypted (mandatory).** `apps/api/.env` (+ `.env.dev`)
> are committed as ciphertext (`KEY=encrypted:…`); keys live in Dotenv Armor.
> **Never write a plaintext secret into a tracked file or commit** — add/change
> values only via `dotenvx set KEY value -f apps/api/.env` (then commit), read
> with `dotenvx get`, and machine-local overrides go in the gitignored
> `apps/api/.env.local`. If the user pastes a key, store it with `dotenvx set`,
> never paste it raw. A pre-commit hook + GitHub push protection enforce this —
> don't bypass them. Full procedure: the **dotenvx-secrets** skill.

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

### End-to-end harnesses
- `pnpm --filter @kortix/tests test:e2e` — Playwright UI specs.
- `pnpm --filter @kortix/tests test:e2e:gate5:local` — local Gate 5 verifier.
- `pnpm --filter @kortix/tests test:e2e:gate5:target` — target Gate 5 rehearsal.
- `tests/README.md` indexes the current E2E and Gate 5 harnesses.

### End-to-end tests — `ke2e` (the canonical API suite + source of truth)
- `suna/tests/` is the **one** black-box REST e2e suite (`ke2e` runner). It hits
  a **live deployed API** over HTTP (`dev-api.kortix.com` / local / prod) with
  **real services** — no mocking. Every test maps 1:1 to a flow ID in
  `tests/spec/end-to-end.md`; a coverage gate checks that mapping against the
  authoritative route manifest (`tests/spec/routes.generated.json`).
- **WIP — NOT yet enforced.** ke2e is still being built out (most flows aren't
  written yet) and does **not** gate PRs, promotes, or deploys right now. The
  intended end-state is test-as-source-of-truth (touch an API contract → update
  `tests/spec/end-to-end.md` + add/adjust the flow + keep `ke2e coverage` green),
  but treat that as aspirational guidance until the suite is complete and turned on.
  See the `ke2e-tests` skill for how it works.
- Run: `cd tests && bun bin/ke2e.ts run --domain system,access` (public, no creds);
  auth'd domains need `KE2E_OWNER_EMAIL/PASSWORD` + `KE2E_LIVE_CONFIRM=1`. Open
  `test-results/<runId>/report.html` for every request/response.
- Regenerate the route manifest after adding/removing routes:
  `bun run apps/api/scripts/dump-routes.ts`.
- Provisioning is slow (snapshot build up to ~9 min, sandbox up to ~5 min) —
  flows that boot sandboxes have generous timeouts; run long checks in the background.

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
