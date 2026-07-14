---
name: kortix-cli
description: "Drive Kortix itself from the terminal with the `kortix` CLI — preinstalled and pre-authenticated in every session sandbox. Use whenever a task means acting on THIS project's Kortix control plane rather than just editing files: manage secrets, list/spawn/watch/talk-to sessions, open or inspect change requests to land work on main, fire or manage triggers, call connectors via the executor, connect Slack, or read project info. This is a discovery stub — the full, always-current reference is served live via `kortix skills get`."
defaultProjectInstall: true
---

# kortix-cli

The **`kortix`** CLI is the control plane for Kortix — the same surface a human
drives in the dashboard, fully scriptable from a terminal. It is **already
installed and pre-authenticated** in every session sandbox: the binary is on
`$PATH` (`/usr/local/bin/kortix`), a project-scoped token (`KORTIX_CLI_TOKEN`)
and `KORTIX_API_URL` are pre-injected, so `kortix …` just works with no setup.

## Start here

This file is a **discovery stub, not the usage guide.** The full, always-current
Kortix reference — every command, the manifest, change requests, the runtime — is
served **live by the CLI**, so it never goes stale between releases:

```bash
kortix skills                        # list the Kortix system skills served live
kortix skills get kortix-system      # THE full reference: CLI, kortix.yaml, CRs, runtime
kortix skills get kortix-cli --full  # this skill's complete command reference
```

Load `kortix skills get kortix-system` before doing anything non-trivial with
Kortix — the CLI serves version-matched content, which this static stub can't.

## The moves you'll reach for

```bash
kortix whoami                                   # which project + account this token has
kortix secrets request <NAME>                   # mint a link for a human to enter a key (never handle raw keys)
kortix sessions status                          # every agent on the project + what it's doing now
kortix sessions new --json --wait --prompt "…"  # spawn a subagent, get a ready session id
kortix executor call <connector> <action> '…'   # run a configured connector as a tool (server-side)
kortix cr open --title "…"                       # propose landing your branch on main (the user merges)
```

Every read command takes `--json` (clean payload on stdout), so the CLI is a
100% scriptable surface. For anything beyond the above — flags, the token-scope
model, host switching, orchestration patterns — run `kortix skills get
kortix-system` (or `kortix skills get <name>` for a specific system skill).

## Landing work on `main`

A session runs on its own branch; the **only** sanctioned path to `main` is a
change request, and you open it — the user reviews and merges:

```bash
git add . && git commit -m "…" && git push origin HEAD
kortix cr open --title "…" --description "…"     # head + session auto-detected in a sandbox
```

Never merge your own CR. Full CR lifecycle: `kortix skills get kortix-system`.
