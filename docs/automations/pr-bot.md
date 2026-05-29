# PR bot — agent code review + preview env on every GitHub PR

Two webhook triggers fire a Kortix agent on every pull request to
`kortix-ai/suna`:

- **`pr-review`** — clones the PR, runs the **thermo-nuclear-review** skill on
  the diff, posts a review comment, and (when it has concrete fixes) opens a
  stacked fix-PR.
- **`pr-preview`** — boots the PR branch's frontend + backend in the sandbox and
  posts one-click preview URLs to the PR.

Both run the **`pr-bot`** agent (`.kortix/opencode/agents/pr-bot.md`) and reach
GitHub through the **`github` connector** (executor) — no raw tokens in the
agent.

This was built as a dogfood: use Kortix to automate Kortix's own PRs, and find
where the product is rough. The rough edges are written down at the bottom — the
point is to make the *next* such automation trivial.

## Architecture

```
GitHub PR event ──HMAC──▶ /v1/webhooks/projects/<project_id>/pr-review   ─▶ session (pr-bot, REVIEW)
                  └─────▶ /v1/webhooks/projects/<project_id>/pr-preview  ─▶ session (pr-bot, PREVIEW)

pr-bot session ──clone PR──▶ kortix-ai/suna @ PR ref     (read the code)
               ──executor──▶ github connector (Connect Proxy)  (comment / open PR)
               ──proxy────▶ Kortix sandbox proxy           (preview URLs)
```

- **Triggers** live in `kortix.toml` `[[triggers]]`. The platform loads them
  from the project's **default branch**, so they only go live once the manifest
  is on the project's `main` (via `kortix ship`).
- **GitHub interaction is executor-first.** The agent never holds a GitHub
  token. It calls the `github` connector via the `kortix-executor` MCP tools
  (`discover`/`describe`/`call`), and uses the connector's generic **`request`**
  tool (Connect Proxy) to hit any GitHub endpoint — comment, open PR, read
  files. See the `kortix-executor` skill.
- **Reading code** is a plain public `git clone` at the PR ref
  (`.kortix/automation/pr-bot/checkout-pr.sh`) — no auth needed for a public
  repo, and independent of the session's own git backend.
- **Previews** use the Kortix sandbox proxy. `preview-url.sh <port>` mints a
  one-click URL (`POST /v1/p/share`) for a server the agent started in the
  sandbox.

## Setup (one-time, from your terminal)

Everything is doable from the CLI — no dashboard required.

```sh
# 1. The github connector is already in kortix.toml. Apply the manifest:
kortix ship --no-verify         # --no-verify skips the unrelated [sandbox] lint

# 2. One-click GitHub auth — the CLI hands you the link:
kortix connectors connect github     # open the printed URL, authorize Kortix
kortix connectors finalize github     # confirm; the connector is now usable

# 3. The HMAC secret the GitHub webhook signs with:
kortix secrets set GITHUB_WEBHOOK_SECRET=<a-random-string>

# 4. Register the GitHub webhook(s) on kortix-ai/suna — one per trigger,
#    content-type application/json, event = "Pull requests", secret as above:
#      <api-base>/v1/webhooks/projects/<project_id>/pr-review
#      <api-base>/v1/webhooks/projects/<project_id>/pr-preview
#    (project_id: `kortix projects info`. In local dev, <api-base> is the
#     cloudflared tunnel URL, not localhost.)
```

Then open a test PR and watch the two comments land.

> Local dev note: GitHub must reach the webhook, so `<api-base>` is the
> cloudflared tunnel that `scripts/dev-local.sh` starts, not `localhost:8008`.
> The tunnel URL changes on restart — re-point the webhook if it rotates.

## The Connect Proxy (platform change this dogfood produced)

The PR bot needs to post comments and open PRs — arbitrary GitHub API calls.
Pipedream's *curated* actions don't cover every endpoint, but Pipedream Connect
offers a **proxy** to the whole app API. The executor didn't expose it, so we
added it:

- `apps/api/src/executor/pipedream.ts` — `proxyRequest()` hits
  `POST /v1/connect/{project}/proxy/{base64url(url)}?external_user_id=…&account_id=…`
- `normalize.ts` — every Pipedream connector now gets a generic `request` tool
  (`binding: pipedream_proxy`)
- `gateway.ts` / `db-deps.ts` — dispatch + prod wiring; `types.ts` — the binding

Net effect: a Pipedream connector now behaves like an `openapi`/`http` one — the
agent reaches the **complete API**, with one-click OAuth and the credential kept
server-side. This benefits *every* Pipedream connector, not just GitHub.

## Dogfood findings (make the next one easier)

1. **The executor couldn't reach a connected app's full API.** Only curated
   Pipedream actions were exposed. → Fixed: added the Connect Proxy `request`
   tool (above). This was the single biggest unlock.
2. **A trigger can't boot the session on the PR branch** — it always branches
   from the default branch; the agent must clone/fetch the PR ref itself. A
   `base_ref` passthrough from the webhook body would remove this step.
3. **No GitHub → Kortix PR-event ingestion.** `project_git_connections.webhook_id`
   exists but is unwired, so we register the webhook by hand. A first-class
   "GitHub PR trigger" (auto-registered webhook + typed PR context) would make
   this a one-liner.
4. **A project's git backing looks immutable after creation**, and there's **no
   CLI to GitHub-connect a project** (`/link-repository` is API/dashboard-only).
   Connecting an existing project to GitHub means making a new one.
5. **The sandbox doesn't know its own preview URL** — the agent has to call the
   API back for `sandbox_id`. A `kortix proxy url --port N` usable in-sandbox
   would be the obvious fix.
6. **`kortix validate` is ahead of the committed manifest** (`[sandbox]` →
   `[[sandbox.templates]]`), so `ship` needs `--no-verify` until that migration
   lands. Unrelated to this automation, but it blocks the happy path.
7. **No `discover`/`call` in the `kortix` CLI** — those live only in the
   in-sandbox executor MCP server. Fine for agents; a CLI surface would help
   humans test connectors locally.

## Files

- `kortix.toml` — `[[triggers]]` (pr-review, pr-preview) + `[[connectors]]` github
- `.kortix/opencode/agents/pr-bot.md` — the agent
- `.kortix/opencode/skills/thermo-nuclear-review/SKILL.md` — the review rubric
- `.kortix/automation/pr-bot/` — `checkout-pr.sh`, `preview-url.sh`, `lib.sh`
- `apps/api/src/executor/` — the Connect Proxy (`pipedream.ts`, `normalize.ts`,
  `gateway.ts`, `db-deps.ts`, `types.ts`)
