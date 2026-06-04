# Kortix CLI — design

Status: **draft** · author: in-progress · scope: the cloud-aware
`kortix` CLI commands beyond the local `init` / `apps` flow that
already ships.

## 1. Scope

### In

The CLI lets a user do **everything they can do in the dashboard**, but
from a terminal or a local coding agent. Concretely:

- **Auth** — `kortix login`, `kortix logout`, `kortix whoami`.
- **Projects** — list, show, link a local checkout to a remote project,
  open the dashboard.
- **Secrets** — list, set, unset env vars for a project.
- **Sessions** — list, create, connect / open the live URL, restart.
- **Triggers** — list, fire, enable / disable. (These round-trip
  through `kortix.toml` already; CLI is convenience over the existing
  API routes, not a new surface.)
- **Deploy / apps** — list, deploy, stop, tail logs.
- **Project init** — already exists (`kortix init` scaffolds a repo).

### Out

- **MCP server.** Explicitly deferred. The MCP wrapper will be built
  later as its own thing on top of the same API; it is **not** invoked
  through this CLI.
- **Implicit top-level `start` / `dev`.** Self-hosting lives under
  `kortix self-host ...` so Cloud hosts and local self-hosted hosts use
  the same host-selection model.

### Non-goal: a CLI-only API

The CLI must consume the **same HTTP API the dashboard consumes**. We
do not build a parallel "CLI API." If the dashboard currently reads
`kortix.toml` straight off GitHub for some view, that logic moves into
the API so both surfaces share one source of truth. (See §5 for the
audit-and-move list.)

## 2. Auth

Hybrid: PAT (paste-a-token) ships first, browser device flow is the
upgrade. Both produce the same `Authorization: Bearer <token>` header
for every subsequent call, so command code doesn't fork.

### 2.1 Token storage

```
~/.config/kortix/auth.json    (chmod 0600)

{
  "api_base":   "https://api.kortix.com",          # overridable
  "token":      "kortix_pat_abc...",                # the actual token
  "token_type": "pat" | "device_flow",
  "account_id": "uuid",                              # which account to act on by default
  "user_email": "marko@kortix.ai",                  # for whoami display only
  "expires_at": "2026-06-01T...Z"                    # optional; CLI re-auths on 401
}
```

- Override the file path with `KORTIX_AUTH_FILE`.
- Override the base URL with `KORTIX_API_URL` or `--api <url>`.
- Pull the token from env via `KORTIX_TOKEN` for non-interactive use
  (CI, agents) — bypasses the file.

### 2.2 Phase A — paste-a-token

The user generates a PAT in the dashboard at `/account/tokens`, pastes
into:

```
kortix login --token kortix_pat_...
```

Or just `kortix login` — the CLI opens the dashboard page in the
browser, reads stdin for the token, validates against
`GET /v1/account/me`, persists.

Backend additions needed:
- `POST /v1/account/tokens` → mint a PAT bound to the calling user's
  primary account. Returns the token **once** (hashed at rest).
- `GET /v1/account/tokens` → list (name, prefix, created_at,
  last_used_at, expires_at).
- `DELETE /v1/account/tokens/:id` → revoke.
- `GET /v1/account/me` → identity probe for `whoami`. Returns
  `{ user_id, email, accounts: [...] }`.
- Dashboard page at `/account/tokens` for create / revoke.

### 2.3 Phase B — browser device flow

The proper Vercel-style flow:

```
$ kortix login
  Opening browser to https://kortix.com/cli?user_code=XJ42-9KQS
  Waiting for approval...
  ✓ Authenticated as marko@kortix.ai
```

Backend additions needed:
- `POST /v1/cli/device/start` → returns
  `{ device_code, user_code, verification_uri, expires_in, interval }`.
- `POST /v1/cli/device/poll` body `{ device_code }` →
  - 202 `{ status: "pending" }`
  - 200 `{ token, account_id, user_email }`
  - 410 `{ status: "expired" }`
  - 429 `{ status: "slow_down" }`
- Dashboard page `/cli/approve?user_code=...` to grant.

Pattern can clone the project-level OAuth device flow already in
`projects/index.ts:1874-1990` — same idea, different scope.

## 3. Command surface

| Command                                         | What it does                                                         | API call                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `kortix login [--token <pat>]`                  | Auth via PAT paste or device flow                                    | (paste): `GET /v1/account/me` to verify · (device): see §2.3        |
| `kortix logout`                                 | Delete local auth file                                               | none                                                                |
| `kortix whoami`                                 | Print user + active account                                          | `GET /v1/account/me`                                                |
| `kortix accounts ls`                            | List accounts this user belongs to                                   | `GET /v1/account/me` → `accounts[]`                                 |
| `kortix accounts use <slug-or-id>`              | Switch active account stored in `auth.json`                          | `GET /v1/account/me` then write                                     |
| `kortix projects ls`                            | List projects in active account                                      | `GET /v1/projects`                                                  |
| `kortix projects info [<id-or-slug>]`           | Show one project (defaults to linked project)                        | `GET /v1/projects/:id`                                              |
| `kortix projects link [<id-or-slug>]`           | Bind cwd to a remote project (writes `.kortix/link.json`)            | `GET /v1/projects/:id`                                              |
| `kortix projects unlink`                        | Remove `.kortix/link.json`                                           | none                                                                |
| `kortix projects open`                          | Open the dashboard URL for the linked project                        | none                                                                |
| `kortix secrets ls`                             | List secret names + manifest `[env]` requirements                    | `GET /v1/projects/:id/secrets`                                      |
| `kortix secrets set <NAME>=<VALUE>...`          | Upsert one or more secrets (read VALUE from stdin if `-`)            | `POST /v1/projects/:id/secrets` (per entry)                         |
| `kortix secrets unset <NAME>...`                | Remove                                                               | `DELETE /v1/projects/:id/secrets/:name`                             |
| `kortix sessions ls`                            | List sessions                                                        | `GET /v1/projects/:id/sessions`                                     |
| `kortix sessions new [--prompt "..."]`          | Start a session                                                      | `POST /v1/projects/:id/sessions`                                    |
| `kortix sessions open <session-id>`             | Print / open the dashboard URL for one session                       | none                                                                |
| `kortix sessions logs <session-id> [-f]`        | Stream session output                                                | `GET /v1/projects/:id/sessions/:sid/events` (SSE — exists)          |
| `kortix sessions rm <session-id>`               | Stop + delete                                                        | `DELETE /v1/projects/:id/sessions/:sid`                             |
| `kortix triggers ls`                            | List triggers                                                        | `GET /v1/projects/:id/triggers`                                     |
| `kortix triggers fire <slug>`                   | Manually fire                                                        | `POST /v1/projects/:id/triggers/:slug/fire`                         |
| `kortix triggers enable/disable <slug>`         | Flip `enabled` in manifest                                           | `PATCH /v1/projects/:id/triggers/:slug`                             |
| `kortix apps ls [--remote]`                     | Local from manifest, or `--remote` from API                          | `GET /v1/projects/:id/apps`                                         |
| `kortix apps deploy <slug>`                     | Trigger deploy                                                       | `POST /v1/projects/:id/apps/:slug/deploy`                           |
| `kortix apps logs <slug> [-f]`                  | Tail deploy logs                                                     | `GET /v1/projects/:id/apps/:slug/logs`                              |
| `kortix env ls/pull/push`                       | Alias of `kortix secrets` plus dotenv import/export                  | same as secrets                                                     |

Conventions:
- All `<project>` arguments accept project-id (UUID) or slug
  (slug-resolution happens client-side via `GET /v1/projects` with a
  small cache).
- Commands that operate on a project look up project-id in this order:
  `--project <id>` flag → `KORTIX_PROJECT_ID` env → `.kortix/link.json`
  → error.

## 4. Project linking

Mirrors Vercel's `.vercel/project.json`. The first `kortix` command in
a fresh checkout prompts:

```
$ kortix secrets ls
This directory isn't linked to a Kortix project.
Link it now? [Y/n]
Select project:
  ▸ kortix-agent / acme-bot        (uuid: 1a2b...)
    kortix-agent / marketing-site  (uuid: 9f8e...)
✓ Linked → .kortix/link.json
```

File at `.kortix/link.json` (added to `.gitignore` by default in the
init starter):

```json
{
  "project_id": "1a2b-3c4d-...",
  "account_id": "uuid",
  "linked_at": "2026-05-19T...Z"
}
```

## 5. The single API: audit + move list

The user's directive: **don't build a CLI-only API. Use the same
endpoints the dashboard uses.** Two implications:

1. Anywhere the dashboard currently shells out to GitHub / reads
   `kortix.toml` directly client-side, move that logic to the API so
   the CLI gets it without re-implementation. (Audit needed — TODO.)
2. Any endpoint the CLI needs that isn't already exposed for the
   dashboard becomes a shared addition (PAT mgmt, device flow, account
   probe).

### 5.1 Already shared (dashboard + CLI use as-is)

All `/v1/projects/:id/...` routes for secrets, triggers, sessions,
apps, oauth credentials. The router is already auth-agnostic — it
accepts Supabase JWT or `kortix_` API key via the same
`Authorization: Bearer` header.

### 5.2 To add (will be used by dashboard immediately too)

| Endpoint                                     | Used by               |
| -------------------------------------------- | --------------------- |
| `GET  /v1/account/me`                        | CLI + dashboard nav   |
| `POST/GET/DELETE /v1/account/tokens[/:id]`   | CLI + a new dashboard `/account/tokens` page |
| `POST /v1/cli/device/start`                  | CLI (Phase B)         |
| `POST /v1/cli/device/poll`                   | CLI (Phase B)         |
| `GET  /v1/cli/device/approve?user_code=...`  | dashboard page render |
| `POST /v1/cli/device/approve` body { user_code, accept } | dashboard click handler |

These additions live under `apps/api/src/` and follow the existing
router pattern. The dashboard for the approve / tokens pages goes in
`apps/web/src/app/account/`.

### 5.3 To investigate (might already be shared)

- Does the manifest-editor in the dashboard hit an API endpoint to
  read `kortix.toml`, or does it fetch directly from GitHub?
  - If it fetches direct: move to API.
- Does the trigger / app list in the dashboard hit
  `/v1/projects/:id/{triggers,apps}` or re-parse the manifest in JS?
  - If the latter: nothing to do (parsing is cheap), but the CLI uses
    the API surface either way.

## 6. CLI architecture (code layout)

```
apps/cli/
  bin/kortix                       # bash shim → bun run src/index.ts
  src/
    index.ts                       # arg dispatcher (existing)
    style.ts                       # color + glyph helpers (existing)
    banner.ts                      # ASCII banner (existing)
    agents.ts                      # init flow per-agent installer (existing)
    prompts.ts                     # readline helpers (existing)
    scaffold.ts                    # init scaffold (existing)
    commands/
      init.ts                      # existing
      apps.ts                      # existing — extended with --remote
      create.ts                    # existing
      login.ts                     # NEW
      logout.ts                    # NEW
      whoami.ts                    # NEW
      projects.ts                  # NEW
      secrets.ts                   # NEW
      sessions.ts                  # NEW
      triggers.ts                  # NEW
    api/
      client.ts                    # fetch wrapper: auth headers, 401 handling, JSON
      auth.ts                      # load/save ~/.config/kortix/auth.json
      types.ts                     # response shapes, generated from API
      device-flow.ts               # Phase B
    project-link.ts                # .kortix/link.json read/write
```

### API client (`src/api/client.ts`) sketch

```ts
interface ApiClient {
  get<T>(path: string, opts?: { account?: string }): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
  sse(path: string, onEvent: (e: unknown) => void): AsyncIterable<void>;
}

function createApiClient(auth: Auth): ApiClient { ... }
```

Behavior:
- On 401: print "Token rejected — run `kortix login` to re-auth" and exit 1.
- On 5xx: retry once with 1 s backoff, then surface.
- Every response body is JSON parsed; non-JSON 200s throw.

## 7. Error model

- Auth missing → `kortix: not logged in. Run \`kortix login\`.` (exit 1).
- No project linked → `kortix: no project linked. Run \`kortix projects link\`.` (exit 1).
- API 4xx → print `kortix: <message from API>` (exit 1).
- API 5xx → print `kortix: server error — try again.` (exit 2).
- All errors use `status.err()` from `src/style.ts`.

## 8. Phasing

| Phase | Deliverable | Branch behavior |
| ----- | ----------- | --------------- |
| **1a — API: PAT** | `/v1/account/{me,tokens}` endpoints + dashboard tokens page | dashboard usable for tokens |
| **1b — CLI: login/whoami/projects** | `kortix login --token`, `logout`, `whoami`, `projects ls/info/link/unlink/open` | useful but read-only |
| **2 — CLI: secrets + sessions** | `kortix secrets *`, `kortix sessions *` | feature parity with the dashboard's most-used screens |
| **3 — CLI: triggers + apps + env** | The rest of the surface | full coverage |
| **4 — Device flow** | `/v1/cli/device/*` + dashboard approve page; `kortix login` opens browser by default | Vercel-style polish |
| **(later, separate)** | MCP wrapper — **not part of this CLI**, reuses the same API | separate repo / package |

## 9. Open questions

1. **Account model** — when a user belongs to multiple accounts/orgs,
   what's the default? Today the API resolves a "primary account" via
   `resolveAccountId(userId)`. CLI needs `accounts use <slug>` to
   switch. Confirm whether the API needs an explicit `X-Account-Id`
   header or whether `?account_id=` query is enough (it already
   accepts the latter — see middleware).
2. **PAT scope** — single global token, or per-project tokens? Vercel
   does global with optional scopes. Recommendation: global, no scopes
   to start (matches dashboard auth).
3. **Project slug** — does the API expose a stable human slug per
   project, or only UUIDs? If only UUIDs, the CLI needs a `name`-based
   lookup fallback and we should add a `slug` column.
4. **Session "connect"** — does the platform expose a public URL per
   running session that the CLI can `open` in the browser, or only the
   dashboard route? Both are fine; the CLI just `open`s the URL.
5. **Dotenv import/export** — `kortix env pull` writing `.env` is
   common; should we also support `kortix env push --from .env`? Probably
   yes, but worth confirming.

## 10. Next-action list

In strict order; each row blocks the next.

1. Confirm this design doc (you read this, comment).
2. Add `GET /v1/account/me` + `*** /v1/account/tokens` endpoints to
   the API.
3. Build dashboard `/account/tokens` page.
4. Implement `src/api/{auth,client}.ts` + `src/commands/{login,logout,whoami}.ts`.
5. Implement `src/commands/projects.ts` (`ls`, `info`, `link`, `unlink`, `open`).
6. Hand over for review; then continue Phase 2.
