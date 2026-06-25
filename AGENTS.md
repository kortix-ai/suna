# Kortix project

## First, at session start: where do you work?

Before starting any non-trivial change, **ask the user which environment to work
in** — don't assume. Three choices:

1. **A new isolated worktree** (`pnpm worktree`) — the default for any feature,
   bugfix, refactor, or experiment beyond a one-line edit. Own branch, own port
   block, own Supabase project, own `node_modules`, own tunnel; runs in parallel
   without touching the primary stack. Provision non-blocking with
   `pnpm worktree create --name <feat> --yes --no-start`, then do all edits/runs
   under the sibling checkout `../suna-<feat>`. See the **worktree** skill.
2. **Straight in this primary checkout** via `pnpm dev` (web `3000` / api `8008`)
   — on `main` or whatever branch is already checked out here. Simplest; fine
   for small or quick iterative work where isolation isn't needed.
3. **An existing worktree** — list them with `git worktree list` and work in the
   one the user names.

Carve-outs where you don't need to ask — just proceed: read-only
investigation/questions, and trivial single-file typo/comment fixes on the
current branch.

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
  a **live deployed API** over HTTP (`staging-api.kortix.com` / `dev-api.kortix.com` / local / prod) with
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

### Release topology — dev, staging, prod
- **`main` = dev trunk.** It is the repo default branch and deploys to
  `dev.kortix.com` / `dev-api.kortix.com`. Direct pushes are allowed; breaking or
  incomplete development can live here while it is being shaken out.
- **`staging` = release-candidate branch.** Nothing should land on staging unless
  it is intended to be production-ready: either promote a known dev ref with
  **Promote Dev to Staging**, or open a targeted PR directly into `staging`.
  Staging deploys to `staging.kortix.com` / `staging-api.kortix.com` and must
  use the staging data plane, not dev or prod.
- Staging deploys must apply pending DB migrations against `STAGING_DATABASE_URL`
  before the staging EKS rollout. If that secret is missing or points at dev/prod,
  treat the deploy as broken; staging must never fall back to dev, KE2E, or prod DBs.
- **`prod` = production.** Production moves only through **Promote to Production**,
  which uses `staging` as the source, opens a reviewed release PR into `prod`,
  publishes the release artifacts, and rolls production after merge.
- If `qa-staging` or a staging runtime check points at `dev.kortix.com` or
  `dev-api.kortix.com`, treat that as a broken staging setup, not a passing
  staging gate.

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

### Frontend design standard — Jay/Kortix bar

When touching any visual surface in `apps/web`, treat brand fit as a release
gate, not polish:

- Read `.claude/skills/kortix-design-system/SKILL.md` first and compose existing
  primitives from `@/components/ui/*` before inventing local chrome.
- Match the current Jay Suthar / Kortix product aesthetic: calm neutral surfaces,
  dense-but-legible UI, black/white plus one earned accent, token-driven spacing,
  and no decorative color, glow, or one-off rounded boxes.
- Use recent product surfaces as references before editing: `/design-system`,
  `apps/web/src/features/co-worker/project-layout/project-home.tsx`,
  `apps/web/src/components/ui/wallpaper-background.tsx`, and the account/IAM
  screens called out by the design-system skill.
- Verify visual work in the browser and include the exact lint/typecheck commands
  you ran in the PR. If it does not look native beside Jay-authored UI, keep
  iterating before shipping.
