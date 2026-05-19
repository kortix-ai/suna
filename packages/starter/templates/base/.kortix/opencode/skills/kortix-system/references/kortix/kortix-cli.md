# Kortix CLI — full reference

The `kortix` CLI is the canonical way to drive everything the Kortix
dashboard can do — from a terminal, from a coding agent, from a session
sandbox. It is **always available** inside a Kortix session sandbox:

- the binary is on `PATH` (`/usr/local/bin/kortix`)
- `KORTIX_TOKEN` is pre-injected as an env var, scoped to this project
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
| `kortix sessions ls` | All sessions on the project. |
| `kortix sessions info <id>` | Detail view: status, branch, base ref, agent, sandbox URL, errors. |
| `kortix sessions new [--prompt "<text>"]` | Start a new session, optionally with an initial prompt. |
| `kortix sessions restart <id>` | Re-provision a session in place. |
| `kortix sessions rm <id>` | Stop + delete. |
| `kortix sessions open <id>` | Open the dashboard URL for a session. |

**Inside a sandbox:** `KORTIX_SESSION_ID` tells you which session
you're running in. `kortix sessions info $KORTIX_SESSION_ID` gives
you the live view of yourself.

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

Kortix-native PR layer for session work landing on `main`.

| Command | Effect |
| --- | --- |
| `kortix cr ls` | Open change requests on the project. |
| `kortix cr ...` | Subcommand surface — see `kortix cr --help` for the live list. |

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
KORTIX_TOKEN=kortix_pat_…   ← project-scoped, this project only
KORTIX_API_URL=https://api.kortix.com
KORTIX_PROJECT_ID=<uuid>
KORTIX_SESSION_ID=<uuid>
```

The CLI reads `KORTIX_TOKEN` automatically (via `KORTIX_CLI_TOKEN` env
var support) and uses `KORTIX_API_URL` as the host base. No config file
needed.

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

## Environment variables the CLI reads

| Variable | Purpose |
| --- | --- |
| `KORTIX_TOKEN` | Project-scoped CLI token (preferred name in sandboxes). |
| `KORTIX_CLI_TOKEN` | Same — historical alias the CLI also accepts. |
| `KORTIX_API_URL` | Override the API base URL (default: `https://api.kortix.com`). |
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
- `kortix.toml` — the manifest the dashboard + the CLI both read.
- `.kortix/Dockerfile` — your sandbox base image.
- `.kortix/link.json` — current dir's binding to a remote project
  (project_id + host).
