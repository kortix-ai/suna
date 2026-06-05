# `pnpm worktree` — isolated multi-instance dev

Run **many feature branches at once**, each in its own git worktree with its own
ports, its own Supabase, and its own `node_modules` — zero collisions. Your
primary `pnpm dev` (ports `3000`/`8008`, Supabase project `kortix-local`) is
never touched.

The north star: **clone → one command → set up and running.**

```bash
pnpm worktree create --name billing-fix --yes
# …deps installed, worktree created, ports allocated, Supabase up + migrated, stack booted.
# web  http://localhost:13000   ·   api http://localhost:13008   ·   studio http://localhost:13323
```

## Commands

| Command | What it does |
|---|---|
| `pnpm worktree create --name <n> [--branch b] [--from main] [--no-start] [--yes]` | From a fresh clone: install missing deps, create the worktree, allocate a port block, render an isolated Supabase project, `pnpm install`, `supabase start` + migrate, then boot the stack. Idempotent — re-run to resume. |
| `pnpm worktree new <n>` | Alias of `create` (positional name). |
| `pnpm worktree start <n>` | Boot an existing worktree's stack on its ports (Supabase + API + web). Streams logs; `Ctrl+C` stops the dev servers. |
| `pnpm worktree stop <n>` | Stop the dev servers + Supabase containers. **Data is preserved.** |
| `pnpm worktree nuke <n> [--force]` | Tear down everything: stop, drop Supabase containers **and volumes**, `git worktree remove`, delete the slot's store, free the port slot. |
| `pnpm worktree list` | All worktrees with their slot, branch, status, and ports. |
| `pnpm worktree status [n]` | Live health (🟢/⚪) of web/api/Supabase per worktree. |
| `pnpm worktree doctor [--yes]` | Check (or `--yes` install) the toolchain + flag worktree/registry drift. |

`--yes` on `create`/`doctor` auto-installs anything missing (`bun`, Node 22,
`pnpm`, Supabase CLI, `cloudflared`); without it, you get the exact install
command to run.

## Ports

Each worktree gets a **slot** `N = 0,1,2,…`. Every service is `base + N·100`, so
slots never overlap and stay far from the primary's `3000/8008/5432x`:

| Service | slot 0 | slot 1 | slot 2 |
|---|---|---|---|
| Web (Next) | 13000 | 13100 | 13200 |
| API (Bun) | 13008 | 13108 | 13208 |
| Supabase API | 13321 | 13421 | 13521 |
| Supabase DB | 13322 | 13422 | 13522 |
| Supabase Studio | 13323 | 13423 | 13523 |
| Supabase Inbucket | 13324 | 13424 | 13524 |

A slot keeps its ports for life (stable across `stop`/`start`); the index is only
freed on `nuke`. Derived ports are probed at allocation — a foreign listener
bumps the slot rather than colliding silently.

## How isolation works

- **Ports** — deterministic per-slot blocks (above), tracked in a machine-global
  registry at `~/.kortix/worktrees/registry.json` (override with `$KORTIX_HOME`).
- **Supabase** — each worktree runs a separate stack under `project_id =
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

- Built for macOS + Linux. Requires Docker running.
- `create` is idempotent and resumable: a crash leaves the registry at the last
  good step, and re-running continues from there. `doctor` reports drift.
- This does not start a cloudflared tunnel per worktree (cloud Daytona sandbox
  callbacks). Local web+API+Supabase work fully offline; a `--tunnel` flag is a
  natural follow-up.
