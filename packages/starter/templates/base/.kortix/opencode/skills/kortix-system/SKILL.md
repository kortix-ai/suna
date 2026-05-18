---
name: kortix-system
description: How the Kortix platform works under the hood — the kortix.toml manifest, the repo-native Project model, session sandboxes (isolated Daytona VM + ephemeral branch on the project repo), triggers (cron + signed webhook), per-project encrypted secrets, the layered Docker sandbox image, the [[apps]] deployment surface (experimental), the Kortix sandbox daemon, the contract between Kortix config and OpenCode config, and the rules an agent should follow inside a session. Load when the user asks how Kortix runs, how to add or debug a trigger, where secrets come from, what a `kortix.toml` key means, how the sandbox is built, how branches and PRs flow, or what the agent can and cannot do inside a session.
---

# Kortix system

You're an agent running inside a **Kortix session** — an isolated VM
sandbox with this project's GitHub repo cloned onto its own ephemeral
branch. This skill is the canonical reference for the platform around
you: the manifest, the runtime, triggers, secrets, the sandbox image,
the deployment surface, and the rules to operate confidently.

If the user asks how Kortix works, how to add a trigger, where secrets
live, what's safe to do, or why something is the way it is — answer
from this document.

## Identity

**One project = one GitHub repo = one account.** No cross-project state,
no shared workspace, no "global context." Each project is its own
universe. The `kortix.toml` at the root of that repo is the only
universal contract the platform reads.

**One conversation = one session = one branch.** Every conversation the
user has with you runs inside a **fresh sandbox VM** with the project
repo cloned and checked out on a branch named after the session id.
The sandbox is ephemeral; the branch persists. The user reviews and
merges into the project's default branch when they're ready.

**OpenCode is the agent runtime.** You're an OpenCode agent. The
Kortix platform is the *control plane around* OpenCode — it boots the
sandbox, clones the repo, lays in the agent daemon, schedules triggers,
holds secrets, and proxies the dashboard. Inside the sandbox, you talk
to OpenCode the same way you would on a laptop.

## The contract

Two configuration surfaces, with strict ownership:

| Surface           | Owned by  | Lives in                                                          |
| ----------------- | --------- | ----------------------------------------------------------------- |
| Kortix config     | Kortix    | `kortix.toml` at the repo root + the `.kortix/` folder beside it  |
| OpenCode config   | OpenCode  | `.kortix/opencode/` (agents, skills, commands, opencode.jsonc)    |

The rule: **Kortix stuff (triggers, env spec, sandbox image, deployable
apps, project metadata) lives in `kortix.toml`. OpenCode stuff (agents,
skills, commands, tools, plugins, providers) stays as files under
`.kortix/opencode/`.** Where opencode's config dir actually lives is
declared in `kortix.toml` under `[opencode] config_dir` — the default is
`.kortix/opencode` but you can relocate it.

Any repo with a valid `kortix.toml` at the root is a Kortix project —
that's the universal contract. The platform never reads opencode's
config dir; OpenCode never reads `kortix.toml`. Each side owns its half.

When the user edits triggers / env / apps from the Kortix dashboard,
those edits are read-modify-writes on `kortix.toml` — they round-trip
cleanly. Editing the manifest inside a session works exactly the same:
commit the change, and the next session picks it up.

## Runtime

Inside the sandbox, the layout is fixed:

| Path                          | What                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `/workspace`                  | Working root + cloned repo, on the session branch. `WORKDIR` and `HOME` both point here, so tool caches (`.npm`, `.cache`, `.bun`) land alongside repo files — that's expected. |
| `/workspace/.kortix/`         | Repo-internal Kortix folder — `Dockerfile` + `opencode/` dir. |
| `/usr/local/bin/kortix-agent` | The sandbox daemon binary (supervisor + reverse proxy).  |
| `/usr/local/bin/kortix-entrypoint` | Boot script the container `ENTRYPOINT` points at.   |

Key env vars the platform injects at session boot (in addition to the
project's `[env]` secrets):

| Var                            | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `KORTIX_PROJECT_ID`            | UUID of this project.                                         |
| `KORTIX_SESSION_ID`            | UUID of this session — also the branch name.                  |
| `KORTIX_REPO_URL`              | HTTPS clone URL for the project repo.                         |
| `KORTIX_DEFAULT_BRANCH`        | The repo's default branch (usually `main`).                   |
| `KORTIX_BASE_REF`              | The ref the session branched off of.                          |
| `KORTIX_BRANCH_NAME`           | Same value as `KORTIX_SESSION_ID` — what your work pushes to. |
| `KORTIX_WORKSPACE`             | `/workspace` by default.                                      |
| `KORTIX_PROJECT_TARGET`        | `/workspace` — where the repo is cloned. Same as `KORTIX_WORKSPACE` by default; override only if you need them split. |
| `KORTIX_SERVICE_PORT`          | `8000` — the daemon's external port (proxies opencode).       |
| `KORTIX_AGENT_NAME`            | The OpenCode agent the session was created with.              |
| `KORTIX_INITIAL_PROMPT`        | Set when the session was spawned by a trigger.                |
| `KORTIX_GITHUB_TOKEN`          | Token the platform uses to push your commits back.            |
| `KORTIX_LLM_BASE_URL` / `_TOKEN` | Where to route LLM calls (for routed billing).              |

The `KORTIX_*` prefix is reserved for platform variables. **Don't
declare a user secret with that prefix** — the manifest validator
rejects it.

## Sessions

Each session is an isolated, ephemeral compute leaf:

- Fresh sandbox VM (Daytona by default; `local_docker` in dev).
- The project repo is cloned to `/workspace` and checked out
  on a branch named after the session UUID.
- OpenCode runs inside on an internal port; the Kortix daemon reverse-
  proxies it on `8000`. The dashboard tunnels in over HTTPS.
- Everything you commit + push lands as a real branch on the project
  repo. The user reviews, opens a PR, and merges into the default
  branch when they like the result.
- The sandbox dies when the session ends. **The branch persists.**

**Implication: you can do whatever you want in the sandbox.** `rm -rf`,
install whatever, run unsafe scripts. It's isolated and disposable. But
**only what you commit + push survives** — the rest is gone the moment
the session ends. Treat anything outside the repo (HOME caches, system
state) as scratch.

### Session lifecycle in the dashboard

`queued → branching → provisioning → running → ended`

- `queued` — accepted, waiting for a slot.
- `branching` — the platform is creating the session branch.
- `provisioning` — Daytona is spinning up the sandbox.
- `running` — you're live, the user can connect.
- `ended` — sandbox stopped. Branch and history stick around.

Concurrent-session caps are enforced per account. If the platform
returns a 429 on a new session, the user has hit their tier's cap.

## `kortix.toml` — the manifest

```toml
kortix_version = 1            # schema version, lets the platform evolve safely

[project]
name = "my-project"
description = "What this project is."

[env]
required = ["DATABASE_URL"]   # session refuses to start without these
optional = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]

[sandbox]                            # base image for session sandboxes
dockerfile = ".kortix/Dockerfile"    # repo-relative
context = "."                        # build context

[opencode]                           # where opencode's config dir lives
config_dir = ".kortix/opencode"      # repo-relative; opencode reads OPENCODE_CONFIG_DIR

[[triggers]]                         # cron + webhook triggers — array of tables
slug = "daily-digest"
name = "Daily digest"
type = "cron"
agent = "default"
enabled = true
cron = "0 0 9 * * 1-5"
timezone = "UTC"
prompt = """
Summarize yesterday's commits. Save the result to
.kortix/digests/{{ fired_at }}.md and open a PR.
"""

[[triggers]]
slug = "slack-hook"
type = "webhook"
agent = "default"
secret_env = "WEBHOOK_SLACK_SECRET"
prompt = "Handle the Slack event: {{ body.text }}"
```

### Schema versioning

`kortix_version` is the schema version. Manifests without it are
treated as v1 for backward compat. A manifest declaring a version
higher than the platform knows about is rejected outright — the
platform won't silently misread future fields.

When the platform writes the manifest back (after a UI edit), it
ensures `kortix_version` is the first key, so the file is
self-describing at a glance.

### What's parsed where

The manifest is parsed at every relevant boundary:

| Surface                | What it reads                                          |
| ---------------------- | ------------------------------------------------------ |
| Trigger sweep          | `[[triggers]]`                                         |
| Sandbox builder        | `[sandbox]`                                            |
| Sandbox runtime        | `[opencode]` (where to launch opencode with its config) |
| Session bootstrap      | `[env]` (validates required against project_secrets)   |
| Apps deploy sweep      | `[[apps]]` (when `KORTIX_APPS_EXPERIMENTAL=true`)      |
| Dashboard UI           | All of the above + `[project]`                         |

Unknown top-level tables are ignored by the platform — safe to add
your own metadata, but don't expect the platform to react to it.

## Triggers

Triggers fire and spawn a **fresh session** that runs the rendered
prompt as its initial message. The session lands on the project's
default branch (the trigger creates a session branch the same way an
interactive session would), runs the agent, commits, pushes.

### Types

- **`type = "cron"`** — fires on a **6-field croner expression**:
  `second minute hour day month weekday`. Optional `timezone`
  (IANA name, default UTC). The platform polls every minute by default
  (`KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS`), so sub-minute precision is
  best-effort.

- **`type = "webhook"`** — fires on signed POSTs to:

  ```
  POST /v1/webhooks/projects/<project_id>/<slug>
  ```

  Signature header: `X-Kortix-Signature: sha256=<hmac>` over the raw
  body, using HMAC-SHA256 with the secret named by `secret_env`. The
  GitHub-compatible `X-Hub-Signature-256` header is also accepted, so
  GitHub webhooks point straight at this URL with no adapter.

  The secret value lives in `project_secrets`, never inline in the
  manifest.

### Trigger fields

| Field        | Required | Type       | Notes                                                        |
| ------------ | -------- | ---------- | ------------------------------------------------------------ |
| `slug`       | yes      | string     | URL-safe `[a-z0-9][a-z0-9_-]{0,127}`, unique per project.    |
| `type`       | yes      | string     | `"cron"` or `"webhook"`.                                     |
| `prompt`     | yes      | string     | Mustache-style template (see below). May be multi-line.       |
| `name`       | no       | string     | Human label. Defaults to the slug.                           |
| `agent`      | no       | string     | OpenCode agent name. Defaults to `"default"`.                |
| `enabled`    | no       | bool       | When `false`, the sweeper and webhook receiver skip it.      |
| `cron`       | cron     | string     | 6-field croner expression. Required for `type = "cron"`.     |
| `timezone`   | cron     | string     | IANA tz, e.g. `"America/Los_Angeles"`. Defaults to `"UTC"`.  |
| `secret_env` | webhook  | string     | Name of a `project_secrets` entry holding the HMAC secret.   |

### Template variables

The `prompt` field is rendered with a small mustache-style engine:
`{{ token.dotted.path }}`. Values flatten to strings:

| Variable             | Source                                                         |
| -------------------- | -------------------------------------------------------------- |
| `{{ fired_at }}`     | ISO-8601 timestamp of the fire.                                |
| `{{ trigger.slug }}` | The trigger's slug.                                            |
| `{{ trigger.type }}` | `"cron"` or `"webhook"`.                                       |
| `{{ trigger.kind }}` | Always `"git"` for manifest-defined triggers.                  |
| `{{ body.* }}`       | Webhook only. JSON-parsed request body. Dotted access works.   |
| `{{ headers.* }}`    | Webhook only. `content_type`, `user_agent`, `forwarded_for`.   |

Missing values render as empty strings — no error, no `{{ x }}` left
in the output. Objects/arrays render as JSON.

### Runtime state

Manifest is the source of truth for **config**. The
`project_trigger_runtime` table is the source of truth for **state**
(`last_fired_at`, `event_count`). Writing to the repo on every fire
would amplify a 5-second scheduler tick into a flood of git commits.

If you need to know when a trigger last fired, check the dashboard,
not the repo.

### Common gotchas

- `[triggers]` (single brackets) is wrong — must be `[[triggers]]`
  (array of tables). The parser surfaces a clear error.
- Slugs must be lowercase + URL-safe. Uppercase or spaces fail.
- A webhook trigger without `secret_env` is rejected. There's no
  unauthenticated webhook surface — by design.
- A cron trigger without a `cron` expression is rejected.
- Triggers and apps share the manifest. Bad entries surface in
  `errors` next to the good ones — they don't break the whole file.

## Secrets

Per-project, encrypted at rest. The platform uses **AES-256-GCM** with
**HKDF-derived per-project keys** rooted in the platform's
`API_KEY_SECRET`. Stored in the `project_secrets` table; **never
inline in the repo**.

### How they flow

1. The user (or you, in a session) declares a secret name in
   `kortix.toml`:

   ```toml
   [env]
   required = ["DATABASE_URL"]
   optional = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "WEBHOOK_SLACK_SECRET"]
   ```

2. The user sets the value in the Kortix Secrets Manager (dashboard).
3. When a session boots, the platform decrypts every secret on the
   project and injects them as plain environment variables into the
   sandbox via Daytona env injection.
4. Your agent code reads them like any other env var
   (`process.env.DATABASE_URL`, `os.environ['DATABASE_URL']`, etc.).

### Rules

- Names match `[A-Z_][A-Z0-9_]{0,63}` — env-var-shaped.
- The `KORTIX_*` prefix is reserved for platform variables; user
  secrets cannot use it.
- `required` secrets must be set before a session can start; the
  platform surfaces a clear error otherwise.
- Webhook triggers reference signing secrets by env-var name only
  (`secret_env = "WEBHOOK_FOO_SECRET"`). The value is resolved at
  fire-time — the manifest never sees the plaintext.
- Mid-session rotation: provider keys come in at sandbox-create time.
  Rotating a key in the dashboard takes effect on the **next** session.
  If a key is revoked mid-session, expect calls to fail until the user
  restarts.

## Sandbox image

Sessions run inside a Docker container built from the project's own
`Dockerfile`. The `[sandbox]` table points at it:

```toml
[sandbox]
dockerfile = ".kortix/Dockerfile"   # repo-relative path
context = "."                       # build context
```

Both paths must be repo-relative. Absolute paths and `..` traversal
are rejected — the build runs in its own sandbox, but accepting them
makes intent ambiguous.

### Layered build

The user defines the **workspace**; Kortix owns the **runtime** on top.
On every snapshot build, the platform appends a final layer that:

1. Switches to `USER root`.
2. Installs `ca-certificates`, `curl`, `git`, `nodejs`, `npm`.
3. Installs the pinned `opencode-ai@<version>` CLI globally.
4. Copies in `kortix-agent` and `kortix-entrypoint` binaries.
5. Sets `KORTIX_WORKSPACE=/workspace`, `WORKDIR /workspace`,
   `EXPOSE 8000`.
6. Sets `ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]`.

So feel free to `FROM ubuntu`, `FROM python:3.12`, `FROM golang:1.23`,
or anything else — Kortix slots in on top, and everything you
installed remains on `PATH`. The daemon layer is **non-negotiable**:
it's what makes the session connectable from the dashboard.

### Customizing the image

Edit the project's `Dockerfile` and commit. The next session will be
provisioned from a freshly built snapshot. Snapshots are cached by
a stable hash over the manifest sandbox config + Dockerfile contents,
so rebuilds only happen when something actually changed.

For incremental tweaks during a session (install a system package,
add a CLI), you can `apt-get install ...` inside the running sandbox
— but those changes disappear when the session ends. To persist, put
the install in the Dockerfile and commit.

## `[[apps]]` — deployment surface (experimental)

Gated behind the platform flag `KORTIX_APPS_EXPERIMENTAL=true`. When
the flag is off, the `/apps` routes return 404 and the deploy sweep
skips every project.

`[[apps]]` declares deployable surfaces alongside the agent — think
fly.toml-style entries inside `kortix.toml`. Each entry has a slug,
a `source` (git or tar), an optional `build`, an `env` map, and a list
of domains. The platform dispatches through a provider adapter
(Freestyle today; pluggable) and records each deploy in the
`deployments` table.

```toml
[[apps]]
slug = "marketing-site"
name = "Marketing site"
enabled = true
domains = ["marketing.example.com"]
framework = "next"

  [apps.source]
  type = "git"
  repo = "https://github.com/me/site"
  branch = "main"
  root_path = "apps/site"

  [apps.build]
  command = "pnpm build"
  out_dir = "dist"

  [apps.env]
  NEXT_PUBLIC_API_URL = "https://api.example.com"
```

If the user asks about deploying an app from their project, and the
platform has apps enabled, this is the surface. If it's disabled,
say so — the routes return 404 and the dashboard hides the section.

## The sandbox daemon

A small Bun binary (`kortix-agent`) runs as the container entrypoint.
Its scope is deliberately tight:

1. **Process supervisor for `opencode serve`** — spawn, restart on
   crash, drain on SIGTERM/SIGINT.
2. **Reverse proxy** that fronts opencode's HTTP + SSE surface on
   `KORTIX_SERVICE_PORT` (default `8000`). Internal opencode runs on
   `KORTIX_OPENCODE_INTERNAL_PORT` (default `4096`).
3. **A small Kortix-namespaced control surface:**

   | Path                  | Purpose                                                   |
   | --------------------- | --------------------------------------------------------- |
   | `GET /kortix/health`  | Daemon liveness + opencode state + repo info.             |
   | `POST /kortix/refresh`| Signed fast-forward of the session branch + opencode restart. |
   | `/*`                  | Reverse-proxied to opencode. `503` while opencode boots.  |

Everything else — triggers, channels, secrets, preferences — is
**deliberately not** the daemon's concern. Those live in the cloud
API and either run there or are injected into the sandbox as plain
env vars at create-time. The daemon doesn't read them, expose them,
or know they exist.

`/kortix/health` always returns 200 from the daemon (it's how the
platform tells "daemon down" from "opencode down"):

```json
{
  "daemon": "ok",
  "opencode": "ok",        // or "starting" / "down"
  "uptime_s": 123,
  "opencode_pid": 4567,
  "repo": "https://github.com/owner/name.git",
  "branch": "<session-uuid>",
  "commit_sha": "abc123..."
}
```

`/kortix/refresh` is how the cloud applies an out-of-band change
(e.g., committed config in a parallel session) without re-provisioning
the sandbox. It requires a valid `X-Kortix-User-Context` signed with
`KORTIX_TOKEN`. On success, the daemon `git pull --ff-only`s the
session branch and restarts opencode.

## Tools

The canonical rules for OpenCode tool calls.

### Dedicated tools over `bash`

When a dedicated tool exists, use it — do **not** use `bash` to do
the same thing.

| Operation                  | Use                          | Not this                |
| -------------------------- | ---------------------------- | ----------------------- |
| Read files                 | `read`                       | `cat`, `head`, `tail`   |
| Edit files                 | `edit`                       | `sed`, `awk`            |
| Create files               | `write`                      | `echo > file`, heredoc  |
| Find files by name         | `glob`                       | `find`, `ls`, `fd`      |
| Search file contents       | `grep`                       | `bash grep`, `bash rg`  |
| Communicate to user        | plain text output            | `echo`, `printf`        |
| Show artifacts to user     | `show`                       | inline ASCII / prose    |

`bash` is for real shell: running commands (`pnpm test`, `tsc`,
`cargo build`, `git`, `curl`), process management, package installs,
service control. Not for anything the file-layer tools already handle.

### Per-tool rules

**`read`**
- Absolute paths only.
- Default reads up to 2000 lines. For large files use `offset` + `limit`.
- PDFs over 10 pages require the `pages` param.

**`edit`**
- You **must** `read` the file at least once before editing it.
- Preserve indentation exactly as shown — line numbers are a prefix,
  not part of the file.
- `old_string` must be unique; use `replace_all` for renames.
- Prefer `edit` over `write` for existing files.

**`write`**
- Only for brand-new files or full rewrites.
- **Never create `.md` or `README` files unless the user explicitly asks.**
- **No emojis in files unless the user explicitly asks.**

**`grep`**
- Always use the tool. Never `bash grep` / `bash rg`.
- Regex is ripgrep syntax — literal braces must be escaped
  (`interface\{\}`).
- Output modes: `files_with_matches` (default), `content` (with
  `-A/-B/-C`, `-n`), `count`.
- Multi-round exploratory searches → delegate to a subagent.

**`glob`**
- For file pattern matching (`src/**/*.tsx`).
- Results sorted by modification time.

**`bash`**
- Quote paths containing spaces.
- Prefer absolute paths; avoid `cd` to keep CWD stable.
- For long-running processes (dev server, watcher, integration
  suite), use `run_in_background: true` and stream output rather
  than blocking the tool response.
- **Never `sleep` as a polling wait.** If you're waiting on a
  background process, the harness will wake you when it finishes.
- No newlines to separate commands. Use `&&` (sequential, fail-stop)
  or `;` (sequential, ignore failures).

**`skill`**
- When the user types a slash command (`/commit`, `/review-pr`),
  call the `skill` tool **before** responding. Blocking requirement.
- Never mention a skill in prose without invoking it.
- Not for built-in CLI commands (`/help`, `/clear`).

**`show`**
- The OpenCode way to surface artifacts inline — files, URLs, code,
  images, rendered output. Better than describing in prose.

### Parallelization

- **Independent tool calls → parallel in a single message.**
  Example: `git status`, `git diff`, `git log` → one turn, three
  tool calls.
- **Dependent calls → sequential.** If B needs A's output, chain.
- "In parallel" from the user → one message, multiple tool-use blocks.

### Never do this

- `bash grep` / `bash rg` / `bash find` / `bash cat` / `bash sed`.
- `write` a file you haven't `read` first (if it exists).
- `edit` a file you haven't `read` first.
- `sleep` loops to wait for builds, servers, or remote processes.
- Mention a skill by name in text without invoking it.
- Create `README.md` / `CHANGELOG.md` / any `*.md` on your own
  initiative.
- Ship a change as "done" without a deterministic verification that
  actually ran and passed.

## Authoring

### Commit messages

- Concise: 1–2 sentences focused on the **why**, not the **what**.
- Lead with a type: `add` / `update` / `fix` / `refactor` / `test` / `docs`.
- **Never commit unless the user explicitly asks.**
- Always heredoc to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
Fix Slack webhook signature mismatch on retried events.

Slack retries with the same body but a fresh timestamp; our HMAC
included the timestamp, which broke on the second delivery.
EOF
)"
```

### PR bodies

- Title under 70 characters.
- Body uses heredoc + two sections — **Summary** (1–3 bullets) and
  **Test plan** (markdown checklist):

```bash
gh pr create --title "Fix Slack webhook signature mismatch on retries" --body "$(cat <<'EOF'
## Summary
- Strip the timestamp from the HMAC payload — Slack signs the body only.
- Add a regression test against the documented Slack signature spec.

## Test plan
- [ ] `pnpm test webhooks/slack` all green
- [ ] Manual: retry a delivery from Slack, no 401
EOF
)"
```

### `kortix.toml` edits

The manifest round-trips through the dashboard. When editing in a
session, keep entries in the same shape the platform writes them
back in (slug, name, type, agent, enabled, then type-specific fields,
then `prompt` last). This avoids needless diffs when the user later
edits the same trigger from the UI.

If you add a new trigger and don't yet have a value for `secret_env`,
declare it in `[env].optional` so it shows up in the Secrets Manager,
and leave the trigger `enabled = false` until the user sets the value.

## Git

### Commit safety

- **Only commit when the user explicitly asks.** Being "proactive"
  with commits is not helpful.
- **Never update git config.**
- **Never force push to the default branch.** If the user asks,
  warn them first.
- **Never `--no-verify` or `--no-gpg-sign`** unless explicitly asked.
  If a pre-commit hook fails, fix the underlying issue.
- **Never amend (`--amend`)** unless explicitly asked. Always create
  a NEW commit.
- **Never destructive git ops** without explicit request:
  `push --force`, `reset --hard`, `checkout .`, `restore .`,
  `clean -f`, `branch -D`.
- **Stage files by name.** Prefer `git add path/to/file.ts` over
  `git add -A` to avoid accidentally committing `.env`, credentials,
  or large binaries.
- **Never commit suspected-secret files** (`.env`, `credentials.json`,
  `id_rsa`) even if the user asks — warn first.

### Commit workflow

When asked to commit, run these three **in parallel** first:

1. `git status` (never `-uall` — memory issues on large repos)
2. `git diff` (staged + unstaged)
3. `git log -10 --oneline` (match the repo's style)

Then draft a 1–2 sentence message, stage specific files, commit with
heredoc. Run `git status` afterwards.

### PR workflow

When asked to open a PR, run these **in parallel** first:

1. `git status`
2. `git diff`
3. Check upstream tracking / ahead-behind
4. `git log` + `git diff <default>...HEAD` for the full branch delta

Then analyze **all** commits on the branch (not just the latest),
write title + body via heredoc, create branch if needed, push with
`-u`, `gh pr create`.

### Pushing from the sandbox

The platform injects `KORTIX_GITHUB_TOKEN` and configures git to use
it. You can `git push origin HEAD` without extra setup — the push
goes to the session branch on the project repo. The user reviews and
merges via the dashboard or directly on GitHub.

### Other rules

- No `-i` flags (`git rebase -i`, `git add -i`) — interactive input
  not supported.
- No `--no-edit` with `git rebase`.
- Use `gh` for all GitHub operations.
- Reference issues/PRs as `owner/repo#123`.

## Actions

Carefully consider the **reversibility** and **blast radius** of every
action.

### Free to do (local, reversible, inside the sandbox)

- Editing files in `/workspace`.
- Running tests, linters, type checks.
- Reading from any system the sandbox can reach.
- Local builds, local services, creating files anywhere in the
  sandbox.
- Installing packages, system tools — sandbox is disposable.

### Pause and confirm (destructive or hard-to-reverse)

- `git reset --hard`, `git push --force`, `git branch -D`,
  amending published commits.
- Dropping database tables, truncating data on shared services.
- Removing or downgrading packages in committed `package.json` /
  lockfiles.
- Modifying CI/CD pipelines.
- Overwriting uncommitted changes.
- Rewriting `kortix.toml` in ways that disable triggers or remove
  declared `required` env vars.

### Pause and confirm (shared state, visible to others)

- Pushing code to remote (the user usually wants this, but ask if
  scope is unclear).
- Opening/closing/commenting on/merging PRs or issues.
- Sending messages (Slack, Telegram, email) from inside an agent run.
- Posting to external services.
- Modifying shared infrastructure or permissions.

### Rules of engagement

- Hit unexpected state (unknown files, unfamiliar branches, lock
  files)? **Investigate before overwriting.** It may be the user's
  in-progress work from a parallel session.
- **Never bypass safety checks** (`--no-verify`, `--force`) as a
  shortcut to make an obstacle disappear. Fix the root cause.
- User approval of an action once does NOT approve it in all future
  contexts. "Yes push this" authorizes *that specific change*, not
  all future pushes.
- Match the scope of your action to what was requested. Don't expand
  scope because you have the permissions.

## Verification

"Verified" has exactly one meaning: **a reproducible, scripted check
ran and returned a binary pass**. Nothing else counts.

### Acceptable verification

- Test suite exit code 0 (`pnpm test`, `pytest`, `cargo test`,
  `go test`, `bun test`).
- `tsc --noEmit` clean.
- Linter / formatter exit 0.
- A script that diffs actual vs expected and exits 0.
- `curl` + `jq` assertion.
- DB query whose result matches an expected value.
- `grep -q` for presence/absence.

Commands someone else can rerun and get the same answer.

### NOT verification

- "It looks right."
- "I read the diff and it seems correct."
- "The types should line up."
- "This should work."
- "The logic is sound."
- "I didn't see any errors."

Reading is not running. Staring is not verifying.

### Rules

- Every verification must name: (a) the exact command executed,
  (b) the exit code or concrete result, (c) what that result proves
  about the change's success condition.
- If no deterministic check exists for the change, **write one** —
  a test, an assertion, a small script — before claiming done.
- If you cannot run the verification in this environment (missing
  deps, no creds, no hardware), **say so explicitly** and state the
  exact commands the user would need to run.
- **Flaky tests do not count as verified.** Re-run until
  deterministic, or fix the flake.

### UI / frontend changes

For UI work, **start the dev server and actually use the feature in
a browser** before reporting the task complete. Test the golden path
AND the edge cases. Watch for regressions in neighbouring features.
Type checks and test suites verify code correctness, not feature
correctness. If you can't actually test the UI in this environment,
say so explicitly rather than claiming success.

## Output

### Tone & style

- **Lead with the answer or the action.** Drop preamble, filler,
  restatements, and trailing summaries. The user can read diffs.
- **One sentence over three.** If you can say it in one, say it in one.
- **No emojis** in code, commits, files, or replies unless the user
  explicitly asks.
- **Reference code with `file_path:line_number`** so the user can
  jump straight there: `apps/api/src/projects/triggers.ts:266`.
- **Reference GitHub with `owner/repo#123`** — renders as a clickable
  link.
- **No colon before a tool call.** "Let me read the file." with a
  period, not "Let me read the file:". The tool call is its own
  thing, not the continuation of a sentence.

### What to emit as text

Focus text output on:
- **Decisions that need the user's input.**
- **High-level status updates at natural milestones.**
- **Errors or blockers that change the plan.**

Don't narrate every tool call. Don't restate what the user just said.
Don't explain what's obvious from the diff.

### Verified vs unverified

- Never claim success on something not verified deterministically.
- If you couldn't run the check, say exactly which command you would
  have run and why it was blocked.
- "Should work" and "probably compiles" are not completion states.

## Public URLs

When you start a dev server, build a preview, or run any service on a
port inside the sandbox, **don't send `localhost` URLs to the user**.
The user is outside the sandbox; `localhost` is your loopback, not
theirs.

If the project has a port-share surface (the platform exposes one
per environment — check `KORTIX_*` env vars), use that to mint a
short-lived public URL. Otherwise, surface the work through `show` so
the dashboard can render it inline.

The reverse-proxy on `KORTIX_SERVICE_PORT` (8000) is reserved for
opencode + the daemon — don't put your own dev server there.

## Working in a session

1. **Read `kortix.toml` first if the question touches platform
   config** — it's the source of truth.
2. **For OpenCode customization** (new agent, new skill, new slash
   command), create the file under `.kortix/opencode/` and commit it.
   Sessions read it on next clone (or call `/kortix/refresh` for an
   in-place reload).
3. **For Kortix customization** (new trigger, new env requirement,
   new sandbox dep), edit `kortix.toml` (and `.kortix/Dockerfile` if
   needed) and commit it. Use the dashboard if the user prefers —
   both paths write the same files.
4. **Run the project's own test command** before declaring a change
   done. Whatever it is — `pnpm test`, `pytest`, `go test` — figure
   it out from the repo, don't guess.
5. **Commit in small, meaningful chunks.** The branch is yours; the
   eventual PR is what matters.
6. **Don't half-ship.** Hit a blocker? Surface it with what you tried
   and what's needed. Don't paper over.

## Things that surprise people

- **No global workspace.** Each project is its own GitHub repo. No
  cross-project state, no shared context. The `kortix.toml` at the
  root is the only universal contract.
- **Triggers live in `kortix.toml`, not as files.** Earlier Kortix
  shipped triggers as `.opencode/triggers/<slug>.md` — that's gone.
  Centralized in the manifest now, parsed as `[[triggers]]`.
- **The session branch is named after the session UUID.** That's not
  a coincidence — the branch name *is* the session id by construction.
  Use `KORTIX_SESSION_ID` and `KORTIX_BRANCH_NAME` interchangeably.
- **The repo is cloned directly into `/workspace`.** `WORKDIR` and
  the cloned repo root are the same path. Tool caches (`.npm`,
  `.cache`, `.bun`) land beside repo files because `HOME=/workspace`
  by default. Use absolute paths.
- **Kortix-owned files live in `.kortix/` at the repo root.** The
  `Dockerfile` and `opencode/` config dir sit under there to keep
  the root clean. Both paths are declared in `kortix.toml`
  (`[sandbox] dockerfile` and `[opencode] config_dir`) — relocate
  if you want.
- **OpenCode primitives (agents, skills, commands, opencode.jsonc)
  are never platform-special.** The platform doesn't read them —
  OpenCode does. The platform only reads `kortix.toml`.
- **Manifest schema is versioned.** `kortix_version` lets the
  platform evolve safely. A manifest declaring a higher version than
  the platform knows about is rejected — better than silent misread.
- **Required env vars block session start.** Declare carefully; an
  empty Secrets Manager + a long `required` list means sessions
  refuse to boot.
- **The Kortix sandbox runtime layer is non-negotiable.** You define
  the workspace base in your `Dockerfile`; Kortix layers
  `kortix-agent` + `opencode` + the entrypoint on top. Don't try to
  override `ENTRYPOINT`.
- **`[[apps]]` is experimental.** If `KORTIX_APPS_EXPERIMENTAL` is
  off on the platform, the deploy surface is hidden — entries are
  parsed but never acted on.

## When to load this skill

Load `kortix-system` when the user asks:

- "What does `kortix.toml` do?" / "What's `kortix_version`?"
- "How do I add a cron trigger / webhook?"
- "Why isn't my webhook firing?" / "What's the signature header?"
- "Where do secrets come from?" / "Why does my session fail to start?"
- "How is this session isolated?" / "What survives the session?"
- "What's the difference between `kortix.toml` and `opencode.jsonc`?"
- "Can I delete `.opencode/triggers/`?" (yes — triggers are in the
  manifest now)
- "How do I customize the sandbox image / install extra system tools?"
  (edit `.kortix/Dockerfile` — Kortix layers its runtime on top
  automatically)
- "Where does my agent's code run?" / "What's `/workspace`?"
- "How do I deploy a frontend from this project?" (`[[apps]]`, if
  enabled)
- "What env vars does the platform inject?" / "What is
  `KORTIX_SESSION_ID`?"

If the question is purely about OpenCode itself (agent personas,
skills authoring, slash-commands, providers, model configuration),
point at the OpenCode docs (<https://opencode.ai/docs/>) — that's
their config, not ours.
