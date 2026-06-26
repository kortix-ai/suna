---
name: worktree
description: "How to do feature work in this repo with git worktrees via `pnpm worktree`. Each worktree gets its own branch, its own block of app ports, its own node_modules, and by default shares the primary checkout's standard local Supabase DB for fast setup; pass `--db` only when a separate Supabase project/data plane is needed. Load WHENEVER starting a feature, bugfix, refactor, experiment, or any change you'll want to run/test in isolation; whenever the user mentions worktrees, isolated/parallel dev instances, running multiple branches at once, or 'spin up a worktree'; and whenever you need the exact non-interactive `pnpm worktree` commands and flags. Enforces: every non-trivial change happens in its own worktree."
---

# Worktrees (`pnpm worktree`)

Multi-instance dev environments for this monorepo. One command from a clean
checkout provisions a collision-free app stack on its own branch: unique ports
for web/api/gateway, its own `node_modules` + pnpm store, and a tunnel for cloud
sandbox callbacks. By default the worktree uses the primary checkout's standard
local Supabase DB (`kortix-local` on 54321/54322) so setup is fast and auth/data
state is shared. Pass `--db` only when the work needs a separate Supabase
project, schema, auth users, storage, or destructive data changes. The CLI lives
at `scripts/worktree/cli.ts`, run via the root `package.json` script
`pnpm worktree`.

## THE RULE — always work in a worktree

**Default to a worktree for any feature, bugfix, refactor, or experiment** that
spans more than a one-line edit or that you'll want to run, migrate, or test.
Never do feature work directly in the primary checkout — it keeps `main`/your
base clean, lets work run in parallel without port/dependency collisions, and
gives each change its own branch automatically. Use shared DB mode for ordinary
UI/API work; opt into `--db` when database isolation is materially required.

Carve-outs (a worktree is *not* required):
- Read-only investigation / answering questions.
- A trivial single-file typo/comment fix on the branch you're already on.
- Operating on the primary `pnpm dev` stack itself.

When in doubt, spin a worktree. Shared-DB worktrees are cheap to create and
`nuke` removes only the app worktree resources; isolated-DB worktrees also clean
up their own Supabase containers and volumes.

> **Session start:** `AGENTS.md` ("First, at session start: where do you work?")
> has you *ask the user* which environment to use before non-trivial work — a
> new worktree (this skill, the recommended default), straight in the primary
> `pnpm dev` checkout, or an existing worktree. A fresh worktree is the default
> answer, but honour the user's choice.

## Agent quick start (non-interactive, non-blocking)

```sh
pnpm worktree create --name <feat> --yes --no-start
```

- `--name <feat>` names the worktree (letters/numbers/dashes; lowercased).
- `--yes` auto-installs any missing toolchain deps and skips prompts.
- Uses the shared primary Supabase DB by default. Add `--db` only for work that
  needs a separate database/data plane.
- **`--no-start` is mandatory for agents** — without it, `create` ends by
  booting the dev servers **in the foreground and blocks until Ctrl+C**, which
  will hang your turn. `--no-start` provisions everything and returns.

The new checkout lands at a **sibling** of the repo: `../suna-<feat>`
(e.g. repo `…/kortix/suna` → worktree `…/kortix/suna-<feat>`). It is on a **new
branch `<feat>`** auto-created from your current `HEAD`. Do all subsequent
edits, `git`, and runs against that path:

```sh
WT=../suna-<feat>          # resolve to an absolute path in practice
# edit files under $WT, then:
git -C "$WT" add -A && git -C "$WT" commit -m "..."
```

When the branch is merged/pushed and you're done: `pnpm worktree nuke <feat>`.
In shared-DB mode this leaves the primary Supabase DB running and untouched.

## Prerequisite for `--db`: the base branch must carry database migrations

Current migrations live in `packages/db/migrations` and are applied with
node-pg-migrate (`pnpm --filter @kortix/db migrate`; see
`packages/db/MIGRATIONS.md`). The worktree runner still has an open bug from the
cutover where it calls the old `db:migrate` script and emits Drizzle-era error
text; if worktree schema setup fails there, track/fix
https://github.com/kortix-ai/suna/issues/3630 rather than treating the old command
as authoritative.

## All commands (non-interactive)

Run bare `pnpm worktree` (TTY) for an interactive menu; everything below is the
scriptable form. `<n>` = worktree name. Aliases shown with `|`.

### `create` (alias `new`) — provision a worktree

```sh
pnpm worktree create --name <n> [flags]
pnpm worktree create <n>        [flags]   # positional name also works
```

| Flag | Default | Effect |
| --- | --- | --- |
| `--name <n>` / positional `<n>` | — (required) | Worktree name → branch name + slot identity. |
| `--branch <b>` | `<n>` | Branch to use. If it already exists it's checked out; otherwise created from `--from`. |
| `--from <ref>` | `HEAD` | Base ref for a newly created branch. Must carry current `packages/db/migrations` (see above). |
| `--db` / `--with-db` / `--isolated-db` | off | Opt into the old full isolated Supabase project (`kortix-wt-<n>`) with its own containers/volumes/migrations. |
| `--no-db` / `--shared-db` | on | Explicitly use the default shared primary Supabase DB. |
| `--no-start` | off | **Provision only, don't boot servers.** Use this for agent/CI runs. |
| `--yes` | off | Auto-install missing deps; non-interactive. |
| `--no-tunnel` | off | Skip the Cloudflare tunnel (offline; cloud sandboxes won't be reachable). |

What it does, in order: toolchain preflight → allocate the lowest free slot
(probing app ports, skipping any in use) → `git worktree add` (new branch from
`--from`, or checkout existing `--branch`) → `pnpm install` into the worktree's
own store → build runtime artifacts → (unless `--no-start`) boot the stack
against the shared primary Supabase DB. With `--db`, it also renders an isolated
Supabase project, starts it, applies database migrations, verifies the `kortix`
schema exists, and starts that Supabase stack. Re-running `create` for an
existing name resumes it idempotently; a worktree's DB mode is fixed until you
`nuke` and recreate it.

### `start` — boot an existing worktree (FOREGROUND, BLOCKS)

```sh
pnpm worktree start <n> [--stripe] [--no-tunnel]
```

In shared-DB mode, ensures the primary local Supabase is reachable, checks that
the `kortix` schema exists, then runs **api + web in the foreground and blocks
until Ctrl+C**. In isolated-DB mode, starts that worktree's Supabase, applies
pending migrations, then boots the app stack. Clean shutdown stops the worktree
app servers, force-kills stragglers, and marks the worktree stopped. Requires
Docker running when Supabase needs to be reached or started.

- **Agents:** do not call this inline — it will hang the turn. If you need the
  stack running to test, launch it as a background process and poll, or ask the
  user to run `pnpm worktree start <n>` in their own terminal.
- A Cloudflare quick tunnel starts by default so cloud Daytona sandboxes can
  call back to the local API (`KORTIX_URL` → the `*.trycloudflare.com` URL).
  `--no-tunnel` skips it; if `cloudflared` is missing it warns and continues.
- `--stripe` turns billing **on** for the worktree and runs `stripe listen`
  forwarding test-mode webhooks to *this* worktree's API
  (`…:<api>/v1/billing/webhooks/stripe`), injecting the `whsec_…` signing secret
  so signatures verify. Needs the `stripe` CLI logged in (`stripe login`) and a
  test `STRIPE_SECRET_KEY` in the worktree's local `.env` (billing won't boot
  without it). Lets you exercise checkout/subscription/webhook flows end-to-end
  in isolation.

### `stop` — pause a worktree (keeps data)

```sh
pnpm worktree stop <n>
```

Kills the web/api/gateway processes. Shared-DB mode leaves the primary Supabase
running. Isolated-DB mode also stops the worktree's Supabase. Data (DB volume
for isolated mode, branch, files) is preserved; `start` resumes it.

### `nuke` (alias `rm`) — tear down and free the slot

```sh
pnpm worktree nuke <n> [--force]
```

Stops servers, removes the git worktree, **deletes the branch**, drops the slot,
and frees the app ports. In shared-DB mode it does **not** stop or delete the
primary Supabase DB. In isolated-DB mode it also stops Supabase and removes that
worktree project's Docker containers/volumes/network. By default the branch is
deleted with `git branch -d` (safe — refuses if unmerged); `--force` uses
`git worktree remove --force` **and** `git branch -D` (drops unmerged commits).
Only `nuke` after the work is merged or pushed.

### `pr` — push the branch and open a pull request

```sh
pnpm worktree pr <n> [--title "…"] [--body "…"] [--base main] [--repo owner/name] [--draft] [--web]
```

Closes the loop (create → work → `pr`). Refuses if the branch has no commits
ahead of `--base` (default `main`); warns if the tree is dirty (uncommitted work
won't be in the PR). Pushes `origin/<branch>` (`-u`), then runs `gh pr create`.
Title/body come from the branch's commit messages via `gh --fill` unless
`--title` is given. `--draft` opens a draft; `--web` finishes in the browser.
If `gh` isn't installed it still pushes and prints a compare URL. On a fork, gh
may ask which base repo — answer the prompt (or pass `--repo`). Requires the
push remote (`origin`) to be authenticated for your account.

### `list` (alias `ls`) — table of all worktrees

```sh
pnpm worktree list
```

Shows name, slot, status, DB mode, branch, and the web/api/db/studio ports.

### `status` — live health

```sh
pnpm worktree status [<n>]    # all worktrees, or just <n>
```

Per-worktree: whether web/api ports are listening and whether its configured
Supabase target is up.

### `doctor` — verify toolchain + integrity

```sh
pnpm worktree doctor [--yes]
```

Checks required tools (bun, node >=22, pnpm, dotenvx, plus Supabase/Docker/psql
for DB modes) and the optional `cloudflared`, then flags any worktree whose dir
is missing, isn't a registered git worktree, or has orphaned isolated-DB
containers. `--yes` auto-installs missing deps.

## What each worktree isolates

| Resource | Primary `pnpm dev` | Worktree slot N |
| --- | --- | --- |
| web | 3000 | **13000 + N·100** |
| api | 8008 | **13008 + N·100** |
| Supabase API / DB / Studio / Inbucket | local default | shared default: 54321 / 54322 / 54323 / 54324; with `--db`: 13321 / 13322 / 13323 / 13324 (+N·100) |
| Supabase project | `kortix-local` | shared default: `kortix-local`; with `--db`: `kortix-wt-<n>` (own containers/volumes/network) |
| branch | your current branch | dedicated `<n>` (or `--branch`) |
| deps | repo `node_modules` | own `node_modules` + pnpm store |

Slot 0 → web 13000 / api 13008 / gateway 13090; slot 1 → web 13100 / api 13108 /
gateway 13190; and so on. Isolated DB ports follow the same stride. Slots are
assigned lowest-free and skip any app port already in use, so worktrees never
collide with each other or with `pnpm dev`.

## State & layout

- Checkout: `../suna-<n>` (sibling of the repo root).
- Control state: `~/.kortix/worktrees/` — `registry.json` (the slot ledger) and
  a per-worktree dir holding the rendered Supabase config (`sb/`) and pnpm store.
  Lives entirely outside any checkout, so nothing dirties a tracked tree. Set
  `KORTIX_HOME` to relocate it.
- In-worktree marker: a gitignored `.kortix-worktree.json` (slot/ports/project/DB mode).

## Scope & safety

This is **local-dev tooling only** (`scripts/worktree/*`, invoked via `pnpm
worktree`). It is not imported by any app, build, CI, or Docker image, and it
never touches cloud/production infrastructure — production reads its env from
AWS Secrets Manager, a separate path. The tunnel and `KORTIX_URL` injection
affect only the locally-spawned worktree API process.
