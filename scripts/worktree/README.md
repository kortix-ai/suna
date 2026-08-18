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
| `pnpm worktree start <n> [--billing] [--stripe]` | Boot an existing worktree's app stack on its ports. Add `--billing` for local billing routes without webhooks. Add `--stripe` for live test-mode webhook forwarding. Shared mode uses primary Supabase; isolated mode starts/migrates its own Supabase. Streams logs; `Ctrl+C` stops the dev servers. |
| `pnpm worktree stop <n>` | Stop the dev servers — the whole process tree, verified dead before the registry records it. Isolated mode also stops that worktree's Supabase containers. **Data is preserved.** |
| `pnpm worktree stop --all` | Stop every worktree in one pass. The end-of-day sweep, and the way back from stacks orphaned by an OOM kill. |
| `pnpm worktree nuke <n> [--force]` | Tear down the app worktree: stop, `git worktree remove`, delete the slot's store, free the port slot. Isolated mode also drops its Supabase containers **and volumes**. Shared mode leaves primary Supabase untouched. |
| `pnpm worktree nuke --all [--older-than 2d] [--idle 12h] [--include-dirty] [--dry-run] [--yes]` | Bulk teardown. Always keeps running stacks; frees slots whose directory is gone; keeps dirty checkouts unless `--include-dirty`; time rules filter on `createdAt` / last activity. Prints keep/nuke reasons before acting. |
| `pnpm worktree list` | Every worktree with its live status and web/api ports, running first then alphabetical. Status comes from a real listening-port scan, not the registry, so it cannot go stale. |
| `pnpm worktree list <name>` | Filter by substring. A single match expands to full clickable URLs (web, api, studio) plus its path. |
| `pnpm worktree list [name] --json` | The same data as JSON on stdout for scripting — effective ports, both the probed and recorded status, and URLs. |
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
- **node_modules** — git worktrees have separate working trees, so each worktree
  gets its own isolated `node_modules` (and `node_modules/.pnpm` virtual layer) —
  a sibling's `pnpm install` can never touch it. Package **content** comes from
  the **shared global pnpm store** (default `~/Library/pnpm/store`), which is
  concurrency-safe and hardlinked, so N worktrees cost ~one copy on disk. (We used
  to pass `--store-dir ~/.kortix/worktrees/<name>/pnpm-store`, giving each worktree
  a full private ~2.8GB store; that defeated dedup and leaked 244GB across 91
  abandoned slots. Don't reintroduce it.)
- **Env** — the CLI **pre-sets** each slot's `PORT`/`WEB_PORT`/`DATABASE_URL`/
  `SUPABASE_URL`/`KORTIX_API_PROXY_TARGET`/… into the launched processes.
  `dotenvx run` does not override pre-set vars, so slot values win over the
  committed encrypted `.env` — **no committed file is ever edited.**

The only in-worktree artifact is the gitignored `.kortix-worktree.json` marker.

## Stopping: why it kills trees, not ports

A running stack is not three processes, it is three trees — `pnpm … dev` forks a
dotenvx wrapper, which forks the dev server, which forks a worker pool. Next dev
alone leaves ~15 (`webpack-loaders`, `postcss`, an esbuild service), and **only
the leaf holds the port**.

Stopping by "kill whatever listens on the port" therefore reclaimed 3 of ~19
processes and leaked the rest. Leaked workers reparent to launchd, keep their
1–3 GB Turbopack heap, lose their terminal, and can no longer be reached by
`Ctrl+C` or by `stop` — so they survive until reboot. Enough of them exhausts
swap; the OOM kill then takes a supervisor with it, orphaning another stack.
That loop is why this is tree-based:

- **Roots come from observable state**, never stored pids — a stale pid file plus
  pid reuse means signalling a stranger. Three probes, because no one of them
  sees everything: processes whose **cwd** is in the worktree (the servers and
  their workers), processes **listening** on a slot port (anything that outlived
  its parent), and `cloudflared` / `stripe listen` matched by the **slot's API
  port** in their command line (they run from the CLI's cwd, so the cwd probe
  misses them).
- **A cwd match alone is not enough to be a root.** A shell pipeline, an editor,
  or an agent working in the worktree shares its cwd; only argv[0] looking like
  the toolchain (`node`/`bun`/`pnpm`/`next`/`esbuild`/…) promotes it. Everything
  else dies only by being a descendant of something that does.
- **The reaper never descends through itself** or its ancestors, so `stop` run
  from inside the worktree cannot kill the shell it was typed into.
- **Every kill is verified** (SIGTERM → SIGKILL → re-check). `stopped` is only
  recorded when nothing survived; an unverified write is what used to make `list`
  report stacks as stopped while 20 of their processes were resident.

`pnpm worktree doctor` counts what is actually alive per worktree and reports
registry drift in both directions; `pnpm worktree stop --all` clears the lot.

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
