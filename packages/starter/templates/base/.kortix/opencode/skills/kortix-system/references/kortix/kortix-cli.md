# Kortix CLI — full reference

The `kortix` CLI is the canonical way to drive everything the Kortix
dashboard can do — from a terminal, from a coding agent, from a session
sandbox. It is **always available** inside a Kortix session sandbox:

- the binary is on `PATH` (`/usr/local/bin/kortix`)
- `KORTIX_CLI_TOKEN` is pre-injected — a project-scoped token the CLI
  authenticates with automatically (not `KORTIX_TOKEN`; see "Inside a
  sandbox" below)
- `KORTIX_API_URL` points at the platform you're running against

So you can run `kortix sessions ls` or `kortix secrets set FOO=bar`
from any shell in the sandbox with no setup.

This document lives under the `kortix-system` skill at
`.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md`
— it travels with your repo and is loaded on-demand whenever an agent
needs CLI specifics.

## Quickstart inside a session

```sh
kortix whoami                       # confirms what project + account this token has
kortix projects info                # the project you're running inside
kortix secrets ls                   # encrypted env vars + manifest [env] spec
kortix sessions ls                  # every session on this project (incl. you)
kortix cr ls                        # open change requests
kortix cr open --title "..."        # propose merging your branch into main
```

The token in the sandbox is **project-scoped**: it can read + write
anything on *this* project (secrets, sessions, triggers, change
requests, apps), but it cannot list other projects or touch
account-level resources. See "Token scope" below for the full
permission model.

## On your laptop

The local install flow is one curl + one click:

```sh
curl -fsSL https://kortix.com/install | bash
kortix login                        # opens browser, you click Authorize
```

The local CLI uses a **user-scoped** token saved at
`~/.config/kortix/config.json` (mode 0600). That token can see every
project on every account you're a member of.

## Command surface

### Machine-readable output (`--json`) — driving Kortix as an agent

Every **read/list** command accepts `--json`: it prints the raw API
payload to **stdout** (the human table is suppressed) and nothing else,
so an agent can parse it directly. All diagnostics — the `host …` banner,
update notices, errors — go to **stderr**, so `… --json 2>/dev/null | jq`
is always clean JSON. Mutations are flag-driven with no hidden prompts.

Net effect: the CLI is a **100% scriptable surface** — an agent can drive
Kortix end-to-end from the terminal, the same surface a human drives in
the dashboard (list/select/interact with sessions, read messages, browse
files & diffs, open/merge change requests, manage secrets/triggers/
connectors, …).

```sh
kortix sessions ls --json                       # what's running
kortix sessions log <id> --json                 # what an agent is doing
kortix cr ls --json                             # open change requests
kortix files cat README.md --json | jq -r .content
```

### Auth

| Command | Effect |
| --- | --- |
| `kortix login [--token <pat>] [--host <name>] [--api <url>]` | Default: opens browser → click Authorize → token written. `--token` is the headless fallback. `--host` logs into a named host slot (see Hosts). |
| `kortix logout [--host <name>]` | Remove the token for the active host (or named one). |
| `kortix whoami [--host <name>]` | Print the user + active account on the chosen host. |

### Hosts — pick which Kortix you talk to

A host is one Kortix API endpoint. You can configure several
(cloud, localhost, self-hosted) and switch between them. One is
"active" at any moment; commands operate on the active host by default.

| Command | Effect |
| --- | --- |
| `kortix hosts ls` | List configured hosts (`●` marks active). |
| `kortix hosts use [<name>]` | Switch active host. No name → arrow-key picker. |
| `kortix hosts add <name> --url <url> [--login]` | Register a new host. `--login` runs the browser flow right after. |
| `kortix hosts rm <name>` | Remove a host (confirms when it's the last one). |
| `kortix hosts info [<name>]` | Detailed view of one host. |
| `kortix hosts current` | Print the active host name (script-friendly). |

`--host <name>` on any command overrides the active host for a single
invocation: `kortix projects ls --host local`.

### Projects

| Command | Effect |
| --- | --- |
| `kortix projects ls` | Every project on the active account. |
| `kortix projects info [<id-or-slug>]` | Show one project (defaults to the linked one — see below). |
| `kortix projects link [<id>]` | Bind cwd to a remote project. Writes `.kortix/link.json` with `project_id`, `account_id`, `host`, `host_url`. No arg → arrow-key picker. |
| `kortix projects unlink` | Drop `.kortix/link.json`. |
| `kortix projects open [<id>]` | Open the dashboard URL for a project in your browser. |

#### How a command finds "the project"

In strict order:

1. `--project <id>` flag.
2. `KORTIX_PROJECT_ID` env var.
3. `.kortix/link.json` in cwd (or any ancestor — git-style).
4. Inside a session sandbox: the sandbox's own `KORTIX_PROJECT_ID`.

If none resolve, the command errors with a pointer to `projects link`.

#### How a command finds "the host"

1. `--host <name>` flag.
2. `host` field in `.kortix/link.json` (so a repo always hits its
   home Kortix instance).
3. The globally-active host.

### Secrets

Encrypted env vars stored on the project, injected as plain env
into every session sandbox at boot.

| Command | Effect |
| --- | --- |
| `kortix secrets ls` | List secret names + manifest `[env]` spec; marks required-but-missing. |
| `kortix secrets set NAME=VALUE …` | Upsert one or more. `NAME=-` reads VALUE from stdin (so values never appear in shell history). |
| `kortix secrets unset NAME …` | Remove. |

### Env — dotenv ↔ secrets

| Command | Effect |
| --- | --- |
| `kortix env pull [--out .env] [--force]` | Write a `.env` skeleton (names only — plaintext can't leave the cloud). |
| `kortix env push --from <path>` | Upload every `NAME=VALUE` from a dotenv file as a secret. Supports quoted values, `export NAME=…`, comment lines. |

### Sessions

Each session is an isolated sandbox VM on its own ephemeral branch.

| Command | Effect |
| --- | --- |
| `kortix sessions ls` | All sessions on the project. `--json` for machine-readable output. |
| `kortix sessions status [--all] [--json]` | **Mission control** — every session + what each agent is doing *right now* (live: current tool / thinking / idle + last activity). Built for when many run in parallel. Aliases: `overview`, `ps`. |
| `kortix sessions info <id>` | Detail view: status, branch, base ref, agent, sandbox URL, errors. `--json`. |
| `kortix sessions log [<id>] [--limit N] [--json]` | **Read-only** peek at a session agent's recent messages — see what another agent is *doing right now* without sending it anything. Aliases: `messages`, `history`. No id → most-recent running (an interactive picker when several run on a TTY). |
| `kortix sessions chat [<id>]` | Talk to a session's agent. `--prompt "<text>"` = one-shot (prints the reply and exits); add `--json` to get that reply as JSON (a synchronous subagent call); no flag = REPL. No id → picks/asks which running session. `--new` starts a fresh one. |
| `kortix sessions new [--prompt "<text>"] [--wait] [--json]` | Start a new session. `--wait` blocks until it's running; `--json` prints the session object so you can capture `session_id` to orchestrate. |
| `kortix sessions restart <id>` | Re-provision a session in place. |
| `kortix sessions rm <id>` | Stop + delete. |
| `kortix sessions open <id>` | Open the dashboard URL for a session. |

**Inside a sandbox:** `KORTIX_SESSION_ID` tells you which session
you're running in. `kortix sessions info $KORTIX_SESSION_ID` gives
you the live view of yourself.

**Watch + talk to other agents.** From any session (or your laptop) you
can see the whole project's activity and read it live — this is how an
agent checks up on every other agent that's running:

```sh
kortix sessions status                      # all agents + what each is doing now
kortix sessions status --json | jq .        # …parsed for a monitoring loop
kortix sessions log <id> --limit 20         # read one agent's recent transcript
kortix sessions chat <id> --prompt "…"      # talk to another agent
```

`log` is **read-only** — it never sends a message, so it's the safe way
to observe. To actually talk to another session, one-shot it:
`kortix sessions chat <id> --prompt "status?"` (prints the reply and
exits), or drop into a REPL with `kortix sessions chat <id>`.

**Orchestrate parallel subagents.** The whole fan-out loop is CLI-only —
spawn many sessions, watch the fleet, collect results, land work:

```sh
# spawn a subagent and get a *ready* session id back in one call
id=$(kortix sessions new --json --wait --prompt "do task X" | jq -r .session_id)

kortix sessions status --json                 # the fleet: who's working vs idle
kortix sessions chat "$id" --prompt "result?" --json | jq -r .text   # synchronous call
kortix sessions log "$id" --json              # …or read progress without interrupting

kortix cr ls --json                           # subagents land work as CRs → review/merge
kortix sessions rm "$id"                       # tear the subagent down
```

`--json --wait` is the spawn primitive (one call → a running session id you
can immediately drive); `sessions status` is the at-a-glance fleet view;
`chat … --prompt --json` is a synchronous call; `log` is async observation.

### Triggers

Round-trip through `kortix.toml`'s `[[triggers]]`. Dashboard sees
the same state.

| Command | Effect |
| --- | --- |
| `kortix triggers ls` | List triggers + runtime state (`last_fired_at`). |
| `kortix triggers info <slug>` | Show one trigger in full. |
| `kortix triggers fire <slug>` | Manually fire a trigger now. |
| `kortix triggers enable <slug>` | Set `enabled = true`. |
| `kortix triggers disable <slug>` | Set `enabled = false`. |

### Change requests (`cr`)

Kortix-native PR layer for session work landing on `main`. A change
request proposes merging one branch (`head_ref`) into another
(`base_ref`) inside a project. The CR layer is **Kortix-native** —
it works on top of any git host (GitHub, GitLab, plain
git) without per-host integration. A CR is the **only sanctioned
way** for an agent to land session-branch work on `main`; see
`change-requests.md` (alongside this file) for the full mandate and
lifecycle.

| Command | Effect |
| --- | --- |
| `kortix cr ls [--status open\|merged\|closed\|all] [--project <id>]` | List CRs on the project. Default: `--status open`. |
| `kortix cr show <cr> [--project <id>]` | Show one CR's metadata. Alias: `kortix cr info`. Includes the merge-preview (clean / fast-forward / conflicts) for open CRs. |
| `kortix cr diff <cr> [--no-color] [--project <id>]` | Unified diff of the CR. Three-dot diff for open / closed CRs; for merged CRs it uses the SHAs captured at merge time so the patch still renders even though `head_ref` is now reachable from `base_ref`. |
| `kortix cr open --title "<text>" [--description "<text>"] [--head <ref>] [--base <ref>] [--session <id>] [--project <id>]` | Open a new CR. Aliases: `kortix cr new`, `kortix cr create`. Inside a sandbox, `--head` defaults to `$KORTIX_BRANCH_NAME` and `--session` defaults to `$KORTIX_SESSION_ID`, so `kortix cr open --title "..."` Just Works. `--base` defaults to the project's default branch (usually `main`). `--title` is required. Alias for `--head`: `--from`. Alias for `--base`: `--into`. Alias for `--description`: `--body`. |
| `kortix cr merge <cr> [--message "<text>"] [--project <id>]` | Merge an open CR into its `base_ref`. Fast-forward when possible, three-way merge otherwise. The default commit message is `Merge CR #<n>: <title>` (override with `-m / --message`). Fails with 409 if the CR is not `open` or there are conflicts. |
| `kortix cr close <cr> [--project <id>]` | Close an open CR without merging. Cannot close a merged CR. |
| `kortix cr reopen <cr> [--project <id>]` | Reopen a closed CR (only — merged CRs are terminal). |

`<cr>` accepts either the short per-project number (`3`, `#3`) or the
full UUID `cr_id`. Numbers are unique per project, monotonically
increasing.

#### Inside a sandbox — the typical agent flow

```sh
# 1. Commit on the session branch
git add .
git commit -m "Add release-notes skill"

# 2. Push the branch (KORTIX_BRANCH_NAME)
git push origin HEAD

# 3. Open the CR — head and session are auto-detected
kortix cr open \
  --title  "Add release-notes skill" \
  --description "Drafts release notes from merged commits. Tested against the last 5 tags."

# 4. Confirm it's listed
kortix cr ls

# 5. (Optional) show the diff one more time
kortix cr diff 3
```

The agent **does not merge its own CR** — that's the user's call,
either in the dashboard or via `kortix cr merge <n>`.

#### Conflicts

`kortix cr show <cr>` prints a merge preview:

- `Mergeable cleanly` — no conflicts; `kortix cr merge` will succeed.
- `Mergeable cleanly (fast-forward)` — `head_ref` is strictly ahead of
  `base_ref`; the merge will be a fast-forward.
- `Conflicts in N files:` — listed; resolve on the branch first, push,
  then re-show.

#### Output format

`kortix cr ls` prints `#NUM`, status badge (`● open` / `✔ merged` /
`× closed`), `head_ref → base_ref` (truncated UUID-style branches),
title. Sorted newest first.

#### Exit codes

| Code | Meaning |
| --- | --- |
| `0`  | Success. |
| `1`  | Operation failed (CR not found, merge failed, etc.). |
| `2`  | Bad flag / missing required arg. |

> See `change-requests.md` (alongside this file) for the full
> data model, REST API, and the "MUST open a CR" agent mandate.

### Install / update / uninstall

| Command | Effect |
| --- | --- |
| `kortix update` | Re-runs `curl -fsSL kortix.com/install | bash` to pull the latest binary. |
| `kortix uninstall` | Removes the binary, /usr/local/bin shim, and `~/.config/kortix/`. `--keep-auth` keeps the token. |
| `kortix version` | Print the CLI version. |

### Project scaffold

| Command | Effect |
| --- | --- |
| `kortix init` | Scaffold a Kortix project in the current directory. Writes `kortix.toml`, `.kortix/Dockerfile`, the OpenCode config dir with the default agent + kortix-system skill, and a `.kortix/link.json` placeholder. |
| `kortix <project-name>` | Same as `init` but creates a new directory next to cwd. |

## Token scope

There are **two** token types issued by the Kortix API. Both use the
`kortix_pat_…` prefix; they're distinguished by an internal `project_id`
column on the token row.

| Type | Scope | Issued by | Typical use |
| --- | --- | --- | --- |
| **User token** | All projects on accounts the user belongs to + account-level routes (`/v1/accounts/me`, billing, etc.) | `kortix login` browser flow → minted via `POST /v1/accounts/tokens` | The CLI on your laptop |
| **Project token** | Read + write everything on **one** project — secrets, sessions, triggers, change requests, apps. Cannot list other projects or hit account-level routes. | Auto-minted at session create; surfaced via `POST /v1/projects/:id/cli-token` | The CLI inside a sandbox |

Enforcement: every project route handler checks the token's
`project_id` against the URL's `:projectId` parameter. Mismatch → 403.
Account routes (`/v1/accounts/*`) reject any project-scoped token
outright.

### Inside a sandbox

The session bootstrap injects:

```
KORTIX_CLI_TOKEN=kortix_pat_…   ← project-scoped PAT; what the CLI authenticates with
KORTIX_TOKEN=kortix_sb_…        ← sandbox service key (runtime/clone/LLM) — NOT for the CLI
KORTIX_API_URL=https://<host>/v1
KORTIX_PROJECT_ID=<uuid>
KORTIX_SESSION_ID=<uuid>
KORTIX_BRANCH_NAME=<session-branch>
```

The CLI reads `KORTIX_CLI_TOKEN` (falling back to `KORTIX_EXECUTOR_TOKEN`)
automatically and uses `KORTIX_API_URL` as the host base. No config file,
no `kortix login` needed — `kortix …` just works.

> **Don't authenticate with `KORTIX_TOKEN`.** That's the sandbox *service
> key* (used for the LLM gateway, the tool router, and just-in-time git
> clone credentials). The project-scoped routes the CLI calls
> (`change-requests`, `secrets`, …) reject it with `401 Invalid or expired
> token` — it isn't expired, it's simply the wrong token. Use the CLI; it
> already holds the right one.

### Rotating

```sh
# From a logged-in user CLI:
kortix projects info                    # confirm you're on the right project
kortix project token rotate             # rotates the project token
# (existing sandboxes keep their token until they restart)
```

## Common workflows

### Spin up a fresh session with custom env

```sh
kortix secrets set OPENAI_API_KEY=sk-… ANTHROPIC_API_KEY=sk-…
kortix sessions new --prompt "Audit the auth module and propose a fix"
```

### Inside a session: trigger another session

```sh
# I'm an agent that just finished a big migration. Spawn a verifier:
kortix sessions new --prompt "Verify migration 0048 by running pnpm test + opening a CR if anything fails"
```

### Run a trigger by hand for debugging

```sh
kortix triggers ls                      # confirm the slug + status
kortix triggers fire daily-digest       # one-shot manual fire
kortix sessions ls | head -3            # the new session that the trigger spawned
```

### Pull current secrets into a local `.env` for development

```sh
kortix env pull                         # names only, values left blank
$EDITOR .env                            # fill in values locally
# (don't push — local-only file)
```

### Bulk-upload local `.env` to the cloud project

```sh
kortix env push --from .env
kortix secrets ls                       # confirm
```

### Land session work on `main` (the CR flow)

The agent in the sandbox is responsible for opening the CR; the user
reviews + merges. **There is no other path to `main` from inside a
session.**

```sh
# inside a session sandbox, on branch session-<id>
git add .
git commit -m "Add release-notes skill"
git push origin HEAD

kortix cr open \
  --title       "Add release-notes skill" \
  --description "Drafts release notes from merged commits. Tested against the last 5 tags."

kortix cr ls                            # confirm
```

The user can then:

```sh
kortix cr show 3                        # diff + merge-preview
kortix cr diff 3
kortix cr merge 3                       # merges into base (main)
# or
kortix cr close 3                       # close without merging
```

See `change-requests.md` next to this file for the full lifecycle,
conflict story, and data model.

## Environment variables the CLI reads

| Variable | Purpose |
| --- | --- |
| `KORTIX_CLI_TOKEN` | Project-scoped PAT the CLI authenticates with (injected in sandboxes). |
| `KORTIX_EXECUTOR_TOKEN` | Same PAT under another name; the CLI falls back to it. |
| `KORTIX_TOKEN` | Sandbox **service key** — runtime/clone/LLM auth. **Not** a CLI token; project routes reject it. |
| `KORTIX_API_URL` | API base URL. In a sandbox it already includes the `/v1` mount. |
| `KORTIX_PROJECT_ID` | Override the linked project for one command. |
| `KORTIX_CONFIG_FILE` | Override `~/.config/kortix/config.json` location (useful for tests). |
| `KORTIX_DASHBOARD_URL` | Override the dashboard URL the `login` flow opens (default: derived from API URL). |

The `KORTIX_*` env-var prefix is **reserved** for platform-injected
values. Don't declare your own project secrets with that prefix —
the secrets-manager API rejects them, and the manifest validator
warns.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Operation failed (API error, missing project, etc.). Diagnostics printed to stderr. |
| `2` | Bad flag, unknown subcommand, missing required arg. |

## What the CLI is not

- **Not a self-host installer.** That legacy lives at the old
  `~/.kortix/kortix` bash script; this binary is the cloud-native
  replacement. If you self-host, `kortix login --api http://…` still
  works against your instance — just point it at your own URL.
- **Not a `git` replacement.** `kortix cr` is the change-request
  surface; it composes with `git` rather than wrapping it.
- **Not the runtime.** The thing executing the agent in the sandbox is
  OpenCode. The CLI is the *control plane* — start sessions, manage
  secrets, fire triggers, review CRs. See the OpenCode reference
  files alongside this one for what runs *inside* a session.

## See also

- `.kortix/opencode/skills/kortix-system/SKILL.md` — entry point for
  the kortix-system skill. Mention the CLI from there.
- `change-requests.md` (alongside this file) — full CR data model,
  lifecycle, REST API, and the "MUST open a CR" agent mandate.
- `kortix.toml` — the manifest the dashboard + the CLI both read.
- `.kortix/Dockerfile` — your sandbox base image.
- `.kortix/link.json` — current dir's binding to a remote project
  (project_id + host).
