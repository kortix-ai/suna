# `pnpm worktree` — isolated multi-instance dev

Run **many feature branches at once**, each in its own git worktree with its own
app ports and `node_modules` — zero collisions. By default, worktrees reuse the
primary checkout's standard local Supabase project (`kortix-local` on
`54321`/`54322`) so creation is fast and auth/data state is shared. Pass `--db`
only when a branch needs a separate Supabase project/data plane.

The north star: **clone → one command → set up and running.**

```bash
pnpm worktree create --name billing-fix --yes
# …deps installed, worktree created, app ports allocated, stack booted against shared Supabase.
# web  http://localhost:13000   ·   api http://localhost:13008   ·   db shared primary Supabase

pnpm worktree create --name migration-fix --db --yes
# same app isolation, plus a separate kortix-wt-migration-fix Supabase project.
```

## Commands

| Command | What it does |
|---|---|
| `pnpm worktree create --name <n> [--branch b] [--from main] [--db] [--no-start] [--yes]` | From a fresh clone: install missing deps, create the worktree, allocate a port block, `pnpm install`, build runtime artifacts, then boot the stack against the shared primary Supabase DB. Add `--db` to render/start/migrate a separate Supabase project. Idempotent — re-run to resume. |
| `pnpm worktree new <n>` | Alias of `create` (positional name). |
| `pnpm worktree start <n>` | Boot an existing worktree's app stack on its ports. Shared mode uses primary Supabase; isolated mode starts/migrates its own Supabase. Streams logs; `Ctrl+C` stops the dev servers. |
| `pnpm worktree stop <n>` | Stop the dev servers. Isolated mode also stops that worktree's Supabase containers. **Data is preserved.** |
| `pnpm worktree nuke <n> [--force]` | Tear down the app worktree: stop, `git worktree remove`, delete the slot's store, free the port slot. Isolated mode also drops its Supabase containers **and volumes**. Shared mode leaves primary Supabase untouched. |
| `pnpm worktree list` | All worktrees with their slot, branch, status, and ports. |
| `pnpm worktree status [n]` | Live health (🟢/⚪) of web/api/Supabase per worktree. |
| `pnpm worktree doctor [--yes]` | Check (or `--yes` install) the toolchain + flag worktree/registry drift. |

`--yes` on `create`/`doctor` auto-installs anything missing for the selected
mode (`bun`, Node 22, `pnpm`, and when needed Supabase CLI, Docker, `psql`, or
`cloudflared`); without it, you get the exact install command to run.

## Ports

Each worktree gets a **slot** `N = 0,1,2,…`. App services are `base + N·100`, so
slots never overlap and stay far from the primary's `3000/8008`. Shared DB mode
uses the primary Supabase ports; isolated DB mode uses the strided Supabase ports:

| Service | slot 0 | slot 1 | slot 2 |
|---|---|---|---|
| Web (Next) | 13000 | 13100 | 13200 |
| API (Bun) | 13008 | 13108 | 13208 |
| Supabase API (`--db` only) | 13321 | 13421 | 13521 |
| Supabase DB (`--db` only) | 13322 | 13422 | 13522 |
| Supabase Studio (`--db` only) | 13323 | 13423 | 13523 |
| Supabase Inbucket (`--db` only) | 13324 | 13424 | 13524 |

A slot keeps its ports for life (stable across `stop`/`start`); the index is only
freed on `nuke`. Derived ports are probed at allocation — a foreign listener
bumps the slot rather than colliding silently.

## How isolation works

- **Ports** — deterministic per-slot blocks (above), tracked in a machine-global
  registry at `~/.kortix/worktrees/registry.json` (override with `$KORTIX_HOME`).
- **Supabase** — default shared mode reads credentials from the primary local
  `kortix-local` Supabase stack and does not run migrations or stop/delete DB
  resources. Isolated mode (`--db`) runs a separate stack under `project_id =
  kortix-wt-<name>`, which namespaces every container/volume/network
  (`supabase_db_kortix-wt-<name>`, …). The CLI is pointed at a generated project
  dir under `~/.kortix/worktrees/<name>/sb` via `supabase --workdir`, so the
  worktree's **tracked `supabase/config.toml` stays pristine** (migrations are
  symlinked back, so they're shared + branch-correct).
- **node_modules** — git worktrees have separate working trees, and each gets its
  own pnpm store (`--store-dir ~/.kortix/worktrees/<name>/pnpm-store`) so a
  sibling's `pnpm install` can never corrupt another's linked-modules layer.
- **Env** — the CLI **pre-sets** each slot's `PORT`/`WEB_PORT`/`DATABASE_URL`/
  `SUPABASE_URL`/`KORTIX_API_PROXY_TARGET`/… into the launched processes.
  `dotenvx run` does not override pre-set vars, so slot values win over the
  committed encrypted `.env` — **no committed file is ever edited.**

The only in-worktree artifact is the gitignored `.kortix-worktree.json` marker.

## The two enabling changes (default to primary behavior)

- `apps/web/next.config.ts` — the `/v1/*` proxy target reads
  `KORTIX_API_PROXY_TARGET` (unset → `localhost:8008`). Without this, every
  worktree's browser would proxy to the **primary** API.
- `apps/web/package.json` — `next dev … --port ${WEB_PORT:-3000}`.

## Notes

- Built for macOS + Linux. Shared `create --no-start` does not require Docker;
  `start` and isolated DB work require Docker running.
- `create` is idempotent and resumable: a crash leaves the registry at the last
  good step, and re-running continues from there. `doctor` reports drift.
- `start` opens a cloudflared quick tunnel by default for cloud Daytona sandbox
  callbacks. Pass `--no-tunnel` for offline/local-only work.
