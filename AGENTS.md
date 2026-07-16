# Kortix project

## First, at session start: where do you work?

Before starting any non-trivial change, **ask the user which environment to work
in** — don't assume. Three choices:

1. **A new isolated worktree** (`pnpm worktree`) — the default for any feature,
   bugfix, refactor, or experiment beyond a one-line edit. Own branch, own port
   block, own `node_modules`, own tunnel; runs in parallel without touching the
   primary web/API stack. By default it reuses the primary checkout's standard
   local Supabase DB for fast setup and consistent auth. Provision non-blocking with
   `pnpm worktree create --name <feat> --yes --no-start`, then do all edits/runs
   under the sibling checkout `../suna-<feat>`. If the change needs database
   migrations, destructive data work, schema drift, or independent auth/storage
   state, opt into the full isolated data plane with
   `pnpm worktree create --name <feat> --db --yes --no-start`. See the
   **worktree** skill.
2. **Straight in this primary checkout** via `pnpm dev` (web `3000` / api `8008`)
   — on `main` or whatever branch is already checked out here. Simplest; fine
   for small or quick iterative work where isolation isn't needed.
3. **An existing worktree** — list them with `git worktree list` and work in the
   one the user names.

Carve-outs where you don't need to ask — just proceed: read-only
investigation/questions, and trivial single-file typo/comment fixes on the
current branch.

## Default delivery: PR, merge to main, then prove it on dev

Unless the user explicitly asks for a different delivery path, complete every
non-trivial change through this full lifecycle:

1. Work on a dedicated branch in an isolated worktree and keep the commit scoped
   to that change.
2. Run the relevant local unit, type, integration, and end-to-end checks with
   real inputs and outputs.
3. Push the branch, open a PR against `main`, wait for required checks, and merge
   it. Do not leave finished work only on a branch or stop after opening the PR.
4. Follow the resulting **Deploy Dev** workflow through completion. Confirm the
   deployed artifact contains the merged SHA; a successful `/health` response
   alone is not deployment proof. If a newer push cancels or supersedes the run,
   verify its path filters still rebuild every affected artifact. Manually
   dispatch the workflow when necessary to avoid a skipped component.
5. Re-run the user-visible behavior against `https://dev.kortix.com` and/or
   `https://dev-api.kortix.com`. Prefer the real Kortix CLI configured for the
   dev API for CLI/project/session flows, and direct authenticated HTTP calls for
   API contracts. For web behavior, drive the deployed UI and assert its network
   request plus visible result.

Local verification and dev verification are both required. A local pass does
not replace the deployed check, and a dev smoke test does not replace focused
local tests. Record the PR, merge SHA, deploy run, deployed SHA evidence, and
exact dev command or interaction in the final response.

## Architecture: `@kortix/sdk` is the source of truth

`@kortix/sdk` is the **single source of truth** for everything that talks to the
Kortix backend — projects, accounts, sessions, files, secrets, triggers, the
OpenCode runtime, SSE streaming, model state, and auth-token plumbing. The apps
(`apps/web`, `apps/whitelabel-demo`, `apps/mobile`) are **thin consumers**. Treat
these as standing rules whenever you touch the data/runtime layer:

> **Editing `packages/sdk` itself? Read `packages/sdk/PROGRESS.md` (current state,
> claim your task) and `packages/sdk/AGENTS.md` (the rules) first.** It is a
> **published npm package** with its own hard rules that have no analogue
> elsewhere in this repo: **TDD is mandatory** (failing test first — invoke the
> `tdd` skill — and every turn ends with the gates run, the real output pasted,
> and an explicit shippable YES/NO/NOT YET); exported names (including *types*)
> are a public API contract and renaming one is a breaking change; the `version`
> field is inert and must never be bumped by hand; adding an export requires
> three synchronized edits; and the framework-free core is enforced by a static
> import-graph tripwire.

- **Logic lives in the SDK, never in a host.** No raw `fetch` to the Kortix API,
  no `@opencode-ai/sdk` imports, no transport / runtime / data-state code written
  in app code. New data or runtime behavior is added to the SDK and exposed
  through its public surface — not hand-rolled or duplicated in a host. If you
  need something the SDK doesn't expose, add it to the SDK.
- **One client per host.** Create it once via `createKortix({ backendUrl,
  getToken })` and read everything through `@kortix/sdk` + `@kortix/sdk/react`.
  Auth is just `getToken` — an API key / PAT for programmatic use, or a Supabase
  JWT for the logged-in web app. Hosts never instantiate a second client.
- **A whole session is one hook.** `useSession(projectId, sessionId)` owns the
  entire runtime lifecycle — `/start`, the sandbox switch, the live SSE stream,
  readiness seeding, the canonical OpenCode id, and message sync. Hosts don't
  hand-roll the mount, drive a server-store "switch", or mount a separate event
  provider.
- **Session-scoped + provider-agnostic.** The public API is session-scoped
  (`kortix.session(pid, sid).health() / .previewUrl() / .restart() / …`).
  "Sandbox" and the provider (daytona / …) are server-side
  concerns; client code must never branch on them.
- **`apps/web` data modules are shims.** Files such as
  `apps/web/src/stores/server-store`, `lib/projects-client`, and
  `hooks/opencode/use-*` are thin re-exports (`export * from '@kortix/sdk/...'`).
  Keep them as shims; put the real logic in the SDK. When a merge conflict lands
  on one of these, **keep the shim (`--ours`) and port any new host-side logic
  into the SDK** — do not revert to a host-local implementation.
- **Docs are the spec.** `apps/web/content/docs/sdk/*` and
  `packages/sdk/README.md` describe the intended surface. Keep them current with
  the SDK, and flag legacy/deprecated surfaces in-doc rather than documenting them
  as current.

## You CAN run and verify everything end-to-end. Do it.

This repo ships a **complete, runnable local stack with live cloud sandboxes**.
Do not claim you "can't verify from here" or hand back unverified work — you
have everything needed to run the app, hit the real API, provision real
Daytona sandboxes, drive the real UI in a browser, and assert behavior. Use it.

### Required verification standard — real inputs, real outputs

For every behavior change, assume **100% autonomy** to verify the user-visible
contract before handing the work back. Do not stop at typechecks, unit tests, or
mocked internals when a real surface exists.

- **API changes:** exercise the actual HTTP route with real request payloads
  (`curl`, `bun fetch`, or the `ke2e` runner against a running API). Assert the
  status code and exact response fields that prove the behavior. For writes,
  also assert the persisted/read-back state or resulting repo/file output.
- **CLI changes:** run the real CLI command as a process from bash, with the
  same flags and stdin a user or agent would use. Assert exit code, stdout,
  stderr, and any files/API calls/commits it should create. Do not rely only on
  importing command functions.
- **Web changes:** drive the real page in Chromium/Playwright/chrome-devtools.
  Click/type/toggle the actual controls, intercept or observe the network
  request, and assert the visible UI state plus the outgoing payload. Screenshots
  are useful evidence, but assertions on DOM and network data are required.
- **Cross-surface features:** verify each exposed surface independently. If the
  same feature ships on API + CLI + web + mobile, each gets its own black-box
  assertion for the inputs users can make and the outputs they receive.
- **Default/negative paths count:** when changing defaults or removing implicit
  behavior, assert both the new default and the explicit opt-in/alternate path.
- **No silent gaps:** if a surface cannot be fully exercised in the current
  turn, say exactly which input/output remains unverified and why. Otherwise
  keep going until the real surface is verified.
- **Final response format:** when work is finished, answer with low-fluff,
  numbered lists. Include exactly what changed, what was verified, what remains
  unverified or risky, and what the user should test next. Keep prose short and
  concrete; do not bury the actionable testing path in a paragraph.

### The stack (already wired)
- **Web** — Next.js dev server on `http://localhost:3000`.
- **API** — Bun server on `http://localhost:8008/v1` (`/health` returns JSON).
- **Supabase** — local, on `http://127.0.0.1:54321` (Docker).
- **Sandboxes** — REAL cloud sandboxes on the enabled provider (Daytona,
  Platinum, or E2B; credentials in `apps/api/.env` / `.env.local`). Each project
  session gets its own sandbox; `session_id == sandbox_id`. The OpenCode runtime inside a sandbox is reached via the API
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
  it is intended to be production-ready. Human/code changes enter staging by PR:
  `main` -> `staging` for the full dev candidate, or a targeted branch ->
  `staging` for a selective release candidate. Staging deploys to
  `staging.kortix.com` / `staging-api.kortix.com` and must use the staging data
  plane, not dev or prod.
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
