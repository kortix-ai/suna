# Getting started — run Kortix locally and drive it with `@kortix/sdk`

The zero-to-streaming guide: boot the full stack on your machine, mint a
token, and talk to a real cloud sandbox from a script, a server, or a plain
`<script>` tag. For the API surface itself see [README.md](./README.md) and
[API-MAP.md](./API-MAP.md); this file is only about **getting it running**.

---

## 1. Prerequisites

| Thing | Why | Check |
|---|---|---|
| **pnpm 8.x** | workspace package manager (`packageManager: pnpm@8.11.0`) | `pnpm -v` |
| **Bun** | runs the API, the tests, and the examples directly from TS | `bun -v` |
| **Node 22** | repo tooling convention — newer majors have broken the worktree scripts before | `node -v` (`nvm use 22`) |
| **Docker** | local Supabase runs in containers | `docker info` |
| **dotenvx keys** | `apps/api/.env` / `apps/web/.env` are committed **encrypted**; you need the private keys (Dotenv Armor) to decrypt locally | `dotenvx get SUPABASE_SERVICE_ROLE_KEY -f apps/api/.env` prints a value |

Sandboxes are **real Daytona cloud sandboxes** — the `DAYTONA_API_KEY` already
lives in the encrypted `apps/api/.env`. Nothing to set up, but know that every
session you start provisions a real machine.

Then, once per checkout:

```bash
pnpm install
```

## 2. Start the stack

From the repo root:

```bash
pnpm dev
```

That one command (`scripts/dev-local.sh`) loads the env files and starts:

| Service | Where | Notes |
|---|---|---|
| Web | `http://localhost:3000` | Next.js dev server |
| API | `http://localhost:8008/v1` | Bun server; `GET /v1/health` returns JSON |
| Supabase | `http://127.0.0.1:54321` | local, in Docker |
| Tunnel | cloudflared quick tunnel | lets cloud sandboxes call back into your local API |

**Check before you start a duplicate** — the stack may already be up:

```bash
curl -s localhost:8008/v1/health
lsof -iTCP:3000 -sTCP:LISTEN
```

### First-run gotchas

- **API returns 503 / errors about a missing `kortix` schema** → the local
  database has no schema yet. Start Supabase, then run the migrations:
  `pnpm --filter @kortix/db migrate`, and restart `pnpm dev`.
- **Ports 3000/8008 already bound** → something else (or a previous run) owns
  them; kill it or reuse it rather than double-starting.

## 3. Get credentials (once)

The SDK has exactly one auth seam: `getToken`. For scripts you want a
**Personal Access Token** (`kortix_pat_…`):

1. Open `http://localhost:3000`, create an account / sign in.
2. Click your avatar (user menu) → **User settings** → **API keys** tab
   (under the "Account" group) → **Create API key**. Copy the token — it is
   shown once. Fastest path: command palette (`⌘K`) → type "API keys".
   (In code this is `kortix.accounts.tokens.create()`; the UI lives in
   `apps/web/src/features/accounts/settings/cli-tokens-tab.tsx`.)
3. Export it for the examples:

```bash
export KORTIX_API_URL=http://localhost:8008/v1
export KORTIX_API_KEY=kortix_pat_...
```

Programmatic alternative (no browser): mint a Supabase JWT against the local
stack — admin-create a confirmed user, then password-grant — exactly as
`tests/e2e/helpers/auth.ts` does; the root `AGENTS.md` ("Authenticating to the
live API") walks through the four calls. A JWT works everywhere a PAT does.

## 4. Create a project and a session

Easiest: do it in the web UI at `localhost:3000` (create a project, open a
session) and copy the ids out of the URL:

```bash
export KORTIX_PROJECT_ID=proj_...
export KORTIX_SESSION_ID=...
```

Scripted alternative, using the SDK itself:

```ts
import { createKortix, generateSessionId } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_API_KEY!,
});

const project = await kortix.projects.provision(/* … */);
const session = await kortix.projects.createSession(/* … */);
```

(Exact input shapes: see `core/rest/projects-client/projects.ts` /
`sessions.ts`, or just hover the types — the facade re-exports them 1:1.)

## 5. Drive it — the examples ladder

Every example is plain TypeScript, framework-free, run directly by bun from
the package directory (`cd packages/sdk`). They import `../src/index`, so no
build step is needed inside the workspace; as an npm consumer the only line
that changes is `import { … } from '@kortix/sdk'`.

| Example | What it proves | Needs |
|---|---|---|
| `01-list-projects.ts` | minimum viable client: `createKortix` + PAT → `projects.list()` | PAT |
| `02-send-and-stream.ts` | `ensureReady()` → `stream()` → `send()`, live SSE via `narrowChatEvent` | PAT + project + session |
| `03-server-wrapper.ts` | `createScopedKortix` — per-request isolation for a multi-tenant server | PAT |
| `04-render-transcript.ts` | render a transcript to text with `classifyTurn` | PAT + project + session |
| `05-cost-passthrough.ts` | gateway usage / cost data | PAT + project |
| `06-files-and-secrets.ts` | session-scoped workspace files + project secrets | PAT + project + session |
| `07-vanilla.ts` | **the whole flow in one file** — list → ready → stream → send → classify | PAT + project + session |
| `08-cdn.html` | the same thing from a `<script>` tag, **no build step, no framework** | bundles built + browser |

Start with:

```bash
cd packages/sdk
bun run examples/01-list-projects.ts
```

Then the full flow:

```bash
bun run examples/07-vanilla.ts "What files are in this repo?"
```

First `send()` on a fresh session provisions a real sandbox — expect the
ready step to take a little while the first time.

### The browser one (`08-cdn.html`)

```bash
pnpm --filter @kortix/sdk run build:bundles   # emits dist/kortix.global.js
cd packages/sdk && python3 -m http.server 8099
```

Open (real browser, stack running):

```
http://localhost:8099/examples/08-cdn.html?key=kortix_pat_...&project=<id>&session=<id>
```

Expected: `sent — streaming…` followed by `· message.part.updated` lines.
`window.Kortix` **is** the root barrel — `Kortix.createKortix`,
`Kortix.classifyTurn`, `Kortix.ApiError`, no namespaces.

## 6. Using the SDK from your own app (outside this repo)

```bash
npm install @kortix/sdk
```

```ts
import { createKortix } from '@kortix/sdk';        // everything framework-free
import { useSession } from '@kortix/sdk/react';     // optional React layer
import { createScopedKortix } from '@kortix/sdk/server'; // Node servers (async_hooks)
```

Point `backendUrl` at your stack (`http://localhost:8008/v1` locally,
`https://api.kortix.com/v1` in production) and supply `getToken`. The 20
older subpaths (`/projects-client`, `/turns`, …) still work but are
`@deprecated` — import from the root.

> **React Native / Expo:** REST works; **streaming does not** (RN's `fetch`
> has no `response.body`). Don't build on it yet.

## 7. Verify your checkout (the package gates)

```bash
pnpm --filter @kortix/sdk typecheck          # tsc + examples, exit 0
pnpm --filter @kortix/sdk test               # full suite incl. tripwires
pnpm --filter @kortix/sdk run build:bundles  # CDN ESM + IIFE into dist/
pnpm --filter @kortix/sdk run smoke:install  # pack → install → import, hermetic
```

`test` without built bundles skips the 2 bundle-content tests; run it after
`build:bundles` for the full count. If you change anything here, read
[AGENTS.md](./AGENTS.md) first — this package is live on npm, and the rules
(TDD, never weaken a test, exported names are forever) are enforced by the
tripwires you just ran.

## 8. When something breaks

| Symptom | Likely cause → fix |
|---|---|
| API 503 on every call | local DB missing the `kortix` schema → `pnpm --filter @kortix/db migrate` |
| `401` from the SDK | stale/wrong PAT → re-mint in the **API keys** settings tab; check you exported `KORTIX_API_KEY` |
| `SessionNotReadyError` | you called `previewUrl()`/runtime accessors before `ensureReady()`/`send()` — that's deliberate; ready the session first |
| Streaming connects but nothing arrives | stack tunnel down or sandbox still booting → check `pnpm dev` output; first boot takes longest |
| `bun test <dir>` says `Ran 0 tests` and exits 0 | you pointed it at a dir with no test files — run the full `pnpm --filter @kortix/sdk test` |
