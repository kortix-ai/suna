---
name: kortix-cli
description: "Drive Kortix itself from the terminal with the `kortix` CLI — it's preinstalled and pre-authenticated in every session sandbox. Use whenever you need to act on THIS project's Kortix control plane: manage secrets, list/spawn/watch/talk-to sessions, open or inspect change requests to land work on main, fire or manage triggers, call connectors via the executor, connect Slack, or read project info. Reach for this the moment a task means 'do something to the project/session/CR/secret/trigger', not just editing files."
defaultProjectInstall: true
---

# Kortix CLI

The **`kortix`** CLI is the control plane for Kortix — the same surface a human
drives in the dashboard, fully scriptable from a terminal. It is **always
available inside a session sandbox** with **no setup**:

- the binary is on `PATH` (`/usr/local/bin/kortix`),
- it's already authenticated — a **project-scoped** token (`KORTIX_CLI_TOKEN`)
  is pre-injected, and `KORTIX_API_URL` / `KORTIX_PROJECT_ID` are set,
- so `kortix whoami`, `kortix sessions ls`, `kortix secrets set FOO=bar` Just
  Work from any shell.

Use it whenever a task means *acting on the project* (not just editing files):
secrets, sessions, change requests, triggers, connectors, Slack.

## Scripting it (agent mode)

Every **read/list** command takes `--json`: it prints the raw API payload to
stdout and nothing else (diagnostics go to stderr), so `… --json 2>/dev/null | jq`
is always clean. Mutations are flag-driven with no hidden prompts. The CLI is a
100% scriptable surface — you can orchestrate Kortix end-to-end from the shell.

## The commands you'll reach for

```bash
kortix whoami                       # which project + account this token has
kortix projects info                # the project you're running inside

# Secrets — you usually DON'T have the value; mint a link for a human to enter it:
kortix secrets ls                   # names + manifest [env] spec (marks missing)
kortix secrets request APOLLO_API_KEY   # → surface the URL; never handle the raw key
kortix secrets set NAME=VALUE           # only when you genuinely hold the value

# Sessions — spawn / watch / talk to other agents (parallel orchestration):
kortix sessions status                          # every agent + what it's doing now
kortix sessions new --json --wait --prompt "…"  # spawn a subagent, get a ready id
kortix sessions log <id>                         # read an agent's transcript (read-only)
kortix sessions chat <id> --prompt "…" --json    # synchronous call to another agent

# Executor — call any configured connector as a tool (runs server-side):
kortix executor discover "<intent>"     # find tools by natural language
kortix executor call <connector> <action> '<json>'

kortix triggers ls                  # scheduled / event triggers on this project
kortix channels connect             # THE one-click way to connect Slack (surface the URL)
```

## Landing work on `main` — the change-request flow

A session runs on its own branch; **the only sanctioned path to `main` is a
change request**, and you open it — the user reviews and merges.

```bash
git add . && git commit -m "…" && git push origin HEAD
kortix cr open --title "…" --description "…"   # head + session auto-detected in a sandbox
kortix cr ls                                    # confirm
```

Never merge your own CR — that's the user's call (`kortix cr merge <n>`).

## Going deeper

The exhaustive command reference (every flag, token-scope model, host
switching, env vars, exit codes) lives in the managed **`kortix-system`** skill
at `references/kortix/kortix-cli.md` — load it when you need a specific flag or
the full surface. For discovering and installing *more* capabilities, see
`kortix-marketplace` (the Kortix catalog) and `find-skills-sh` (the open
ecosystem).
