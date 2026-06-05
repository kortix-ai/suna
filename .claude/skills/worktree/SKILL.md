---
name: worktree
description: "How to do TRULY ISOLATED feature work in this repo with git worktrees via `pnpm worktree`. Each worktree gets its own branch, its own block of ports, its own Supabase project, and its own node_modules — so any number run at once and the primary `pnpm dev` (3000/8008) is never disturbed. Load WHENEVER starting a feature, bugfix, refactor, experiment, or any change you'll want to run/test in isolation; whenever the user mentions worktrees, isolated/parallel dev instances, running multiple branches at once, or 'spin up a worktree'; and whenever you need the exact non-interactive `pnpm worktree` commands and flags. Enforces: every non-trivial change happens in its own worktree."
---

# Worktrees (`pnpm worktree`)

Isolated, multi-instance dev environments for this monorepo. One command from a
clean checkout provisions a complete, collision-free stack on its own branch:
unique ports for every service (web, api, the full Supabase set), its own
Supabase project, its own `node_modules` + pnpm store, and a tunnel for cloud
sandbox callbacks. The CLI lives at `scripts/worktree/cli.ts`, run via the
root `package.json` script `pnpm worktree`.

## THE RULE — always work in a worktree

**Default to a worktree for any feature, bugfix, refactor, or experiment** that
spans more than a one-line edit or that you'll want to run, migrate, or test.
Never do feature work directly in the primary checkout — it keeps `main`/your
base clean, lets work run in parallel without port/DB/dependency collisions, and
gives each change its own branch automatically.

Carve-outs (a worktree is *not* required):
- Read-only investigation / answering questions.
- A trivial single-file typo/comment fix on the branch you're already on.
- Operating on the primary `pnpm dev` stack itself.

When in doubt, spin a worktree. They're cheap to create and `nuke` cleans up
everything (containers, volumes, the git worktree, and the branch).

## Agent quick start (non-interactive, non-blocking)

```sh
pnpm worktree create --name <feat> --yes --no-start
```

- `--name <feat>` names the worktree (letters/numbers/dashes; lowercased).
- `--yes` auto-installs any missing toolchain deps and skips prompts.
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

## Prerequisite: the base branch must carry Drizzle migrations

`create` builds the schema with `pnpm db:migrate` and **fails loudly** if the
base ref has no Drizzle migrations (`packages/db/drizzle/*.sql`). Fork from a
base that has them. If you see *"schema not built — branch X has no Drizzle
migrations"*, recreate with `--from <branch-with-migrations>` (e.g.
`--from migrations/drizzle-rebuild`, or merge that into `main` first). The
default base is `HEAD`, so if you're already on a branch that has the
migrations, plain `create` inherits them.

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
| `--name <n>` / positional `<n>` | — (required) | Worktree name → branch name + `kortix-wt-<n>` Supabase project. |
| `--branch <b>` | `<n>` | Branch to use. If it already exists it's checked out; otherwise created from `--from`. |
| `--from <ref>` | `HEAD` | Base ref for a newly created branch. Must carry Drizzle migrations (see above). |
| `--no-start` | off | **Provision only, don't boot servers.** Use this for agent/CI runs. |
| `--yes` | off | Auto-install missing deps; non-interactive. |
| `--no-tunnel` | off | Skip the Cloudflare tunnel (offline; cloud sandboxes won't be reachable). |

What it does, in order: toolchain preflight → allocate the lowest free slot
(probing ports, skipping any in use) → `git worktree add` (new branch from
`--from`, or checkout existing `--branch`) → render an isolated Supabase project
→ `pnpm install` into the worktree's own store → `supabase start` → `pnpm
db:migrate` → verify the `kortix` schema exists → (unless `--no-start`) boot the
stack. Re-running `create` for an existing name resumes it idempotently.

### `start` — boot an existing worktree (FOREGROUND, BLOCKS)

```sh
pnpm worktree start <n> [--no-tunnel]
```

Ensures Supabase is up, applies pending migrations, then runs **api + web in the
foreground and blocks until Ctrl+C** (clean shutdown stops the servers, force-
kills stragglers, and marks the worktree stopped). Requires Docker running.

- **Agents:** do not call this inline — it will hang the turn. If you need the
  stack running to test, launch it as a background process and poll, or ask the
  user to run `pnpm worktree start <n>` in their own terminal.
- A Cloudflare quick tunnel starts by default so cloud Daytona sandboxes can
  call back to the local API (`KORTIX_URL` → the `*.trycloudflare.com` URL).
  `--no-tunnel` skips it; if `cloudflared` is missing it warns and continues.

### `stop` — pause a worktree (keeps data)

```sh
pnpm worktree stop <n>
```

Kills the web/api processes and stops the worktree's Supabase. Data (DB volume,
branch, files) is preserved; `start` resumes it.

### `nuke` (alias `rm`) — tear down and free the slot

```sh
pnpm worktree nuke <n> [--force]
```

Stops servers + Supabase, removes the project's Docker containers/volumes/
network, removes the git worktree, **deletes the branch**, drops the slot, and
frees the ports. By default the branch is deleted with `git branch -d` (safe —
refuses if unmerged); `--force` uses `git worktree remove --force` **and**
`git branch -D` (drops unmerged commits). Only `nuke` after the work is merged
or pushed.

### `list` (alias `ls`) — table of all worktrees

```sh
pnpm worktree list
```

Shows name, slot, status, branch, and the web/api/db/studio ports.

### `status` — live health

```sh
pnpm worktree status [<n>]    # all worktrees, or just <n>
```

Per-worktree: whether web/api ports are listening and whether Supabase is up.

### `doctor` — verify toolchain + integrity

```sh
pnpm worktree doctor [--yes]
```

Checks required tools (bun, node ≥22, pnpm, supabase, dotenvx, docker) and the
optional `cloudflared`, then flags any worktree whose dir is missing, isn't a
registered git worktree, or has orphaned containers. `--yes` auto-installs
missing deps.

## What each worktree isolates

| Resource | Primary `pnpm dev` | Worktree slot N |
| --- | --- | --- |
| web | 3000 | **13000 + N·100** |
| api | 8008 | **13008 + N·100** |
| Supabase API / DB / Studio / Inbucket | local default | 13321 / 13322 / 13323 / 13324 (+N·100) |
| Supabase project | `kortix-local` | `kortix-wt-<n>` (own containers/volumes/network) |
| branch | your current branch | dedicated `<n>` (or `--branch`) |
| deps | repo `node_modules` | own `node_modules` + pnpm store |

Slot 0 → web 13000 / api 13008 / db 13322; slot 1 → web 13100 / api 13108 /
db 13422; and so on. Slots are assigned lowest-free and skip any port already in
use, so worktrees never collide with each other or with `pnpm dev`.

## State & layout

- Checkout: `../suna-<n>` (sibling of the repo root).
- Control state: `~/.kortix/worktrees/` — `registry.json` (the slot ledger) and
  a per-worktree dir holding the rendered Supabase config (`sb/`) and pnpm store.
  Lives entirely outside any checkout, so nothing dirties a tracked tree. Set
  `KORTIX_HOME` to relocate it.
- In-worktree marker: a gitignored `.kortix-worktree.json` (slot/ports/project).

## Scope & safety

This is **local-dev tooling only** (`scripts/worktree/*`, invoked via `pnpm
worktree`). It is not imported by any app, build, CI, or Docker image, and it
never touches cloud/production infrastructure — production reads its env from
AWS Secrets Manager, a separate path. The tunnel and `KORTIX_URL` injection
affect only the locally-spawned worktree API process.
