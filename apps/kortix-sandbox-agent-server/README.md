# kortixd

Thin sandbox-side daemon that runs inside every Kortix project-session sandbox
— and, in a second boot mode, inside every project **monitor box**.

The compiled binary is a single, installable app named **`kortixd`**. Running
it with no arguments (or `kortixd serve`) starts the daemon described below.
It also manages its own lifecycle — see [Management CLI](#management-cli).

> **Binary name compatibility.** The npm package and the product name are now
> `kortixd`. The build still ALSO emits `dist/kortix-agent`, and the sandbox
> image still bakes `/usr/local/bin/kortix-agent`. That path is a load-bearing
> contract: `apps/sandbox/entrypoint.sh` treats it as the immutable floor, the
> snapshot bake COPYs it, and the API serves it as the runtime-assets `/agent`
> artifact for already-deployed boxes. Renaming that on-disk path is a fleet
> migration, not a build change, so both names ship from one compile.

**Boot modes** (decided by `KORTIX_WORKLOAD` at startup):

- _(default)_ **session** — everything under "Scope" below.
- **`monitor`** — the box supervises the project's monitor processes instead
  of opencode (`src/monitor-runner.ts`): it parses `KORTIX_MONITORS` (JSON
  injected by the API — the daemon never parses `kortix.yaml` itself), spawns
  one process per enabled monitor (`poll` on an interval / `stream`
  long-running, restart budget + backoff), captures stdout line-by-line
  (8 KiB truncation), batches ~200 ms, and POSTs batches to
  `POST /projects/:id/monitors/ingest` with the box's sandbox token and
  `KORTIX_MONITOR_BOX_EPOCH`. Lifecycle events (`exited`,
  `restart_budget_exhausted`, `silent`) are synthesized into the same stream.
  Opencode never starts; its routes 503 honestly. `GET /kortix/health`
  reports `workload: "monitor"` — the API's reconciler uses that field to
  detect (and recycle) a box whose baked agent binary predates monitor mode.
  Contract: `docs/specs/2026-08-12-monitors.md`.

**Scope:**

1. Process supervisor for `opencode serve`.
2. Reverse proxy that fronts opencode's HTTP + SSE surface on
   `KORTIX_SERVICE_PORT` (default `8000`).
3. Managed Kortix system-skill injection into OpenCode's native discovery
   directory.
4. Small Kortix-namespaced control surface: `GET /kortix/health` and
   `POST /kortix/refresh`.
5. Static web server on `KORTIX_STATIC_PORT` (default `3211`) — serves any
   HTML/asset the agent writes to disk, injecting a `<base>` tag so relative
   assets resolve cleanly through the sandbox proxy. Ported from main's
   always-on `core/services/static-web.js` s6 service; now runs in-process
   (see `src/static-web.ts`). `apps/web` builds preview URLs against this exact
   port via `/proxy/3211/*` and the `p3211-<sandboxId>` subdomain route.

Everything else — triggers, channels, connectors, secrets, preferences — is
deliberately **not** the daemon's concern. Those live in the cloud API and
either run there directly or are injected into the sandbox as plain
environment variables at create-time. The daemon does not read them, expose
them, or know they exist.

Replaces the legacy multi-script bootstrap and s6 service definitions with one
in-process daemon.

## Boot flow

1. Read env vars (`src/config.ts`).
2. Start the static web server on `0.0.0.0:KORTIX_STATIC_PORT` (in-process).
   It only reads files off disk, so it comes up first and stays up regardless
   of repo/opencode state — previews work while the agent is still booting.
   Non-fatal: a bind failure is logged and `static_web_port` reports `null`.
3. The sandbox entrypoint downloads and verifies the compiled `server.mjs` when
   compiled boot is enabled. `prefer` executes it with baked-agent fallback.
   `shadow` verifies it and executes the baked agent. `required` fails closed.
4. Materialize the project repo in `/workspace/.kortix`. `prefer` and
   `required` first download a compiled checkout. `shadow` validates the
   checkout without using it. `off` mode and `prefer` failures use `git clone`.
   Materialization failures are logged but non-fatal in non-required modes.
5. Inject managed system skills into `.kortix/opencode/skills`.
6. Resolve `OPENCODE_CONFIG_DIR`.
7. Start the OpenCode REST supervisor in the project directory
   (`opencode serve --port <internal> --hostname 127.0.0.1`).
   If the binary isn't found we keep going and report `opencode: 'starting'`.
8. Start the Hono proxy on `0.0.0.0:KORTIX_SERVICE_PORT`.
9. Trap signals; on shutdown, drain proxy + static web + kill child processes.

## Routes

| Path                   | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `GET /kortix/health`   | Daemon liveness + opencode state + repo info (always 200 from daemon) |
| `POST /kortix/refresh` | Signed-context protected repo fast-forward + opencode restart.        |
| `/*`                   | Reverse-proxied to opencode. 503 while `opencode !== 'ok'`.           |

### `GET /kortix/health` response shape

```json
{
  "daemon": "ok",
  "opencode": "ok",
  "uptime_s": 123,
  "opencode_pid": 4567,
  "static_web_port": 3211,
  "repo": "https://github.com/owner/name.git",
  "branch": "main",
  "commit_sha": "abc123...",
  "compiled_boot_mode": "prefer",
  "compiled_checkout": true,
  "compiled_runtime": true,
  "compiled_runtime_format": "kortix.compiled-runtime.v1",
  "compiled_runtime_source_sha": "abc123..."
}
```

- `daemon` is always `"ok"` if the route responds.
- `opencode` is `"ok" | "starting" | "down"`. `"starting"` covers both
  pre-bind and between-restart states.
- `repo`, `branch`, `commit_sha` come from `git` in `KORTIX_PROJECT_TARGET` and
  are `null` when no repo has been materialized.
- `compiled_boot_mode` reports `off`, `shadow`, `prefer`, or `required`.
- `compiled_checkout` is `true` only when the current repo came from a verified
  compiled checkout.
- `compiled_runtime` is `true` only when `server.mjs` launched the daemon.
- `compiled_runtime_source_sha` is the exact Git SHA compiled into `server.mjs`.

### `POST /kortix/refresh`

Requires a valid `X-Kortix-User-Context` signed with `KORTIX_TOKEN`. On success,
the daemon fetches origin, runs `git pull --ff-only` for the session branch, and
restarts opencode so project config changes are picked up without recreating the
sandbox. Missing/invalid context returns `401`; no materialized repo or a
non-fast-forward conflict returns `409`.

## What lives elsewhere

- **Triggers** — cloud API (`apps/api/`). The cloud API fires triggers against
  the sandbox from outside; the daemon does not host them.
- **Channels / connectors** — cloud API.
- **Secrets** — cloud API decides which secrets a sandbox needs and sets them
  as plain environment variables at create-time (via Daytona env injection).
  The daemon does not read them and has no `/kortix/secrets` route.
- **User preferences** — deferred. The frontend talks directly to opencode's
  own preference surface when it needs one.

## Env vars

```
KORTIX_SERVICE_PORT=8000
KORTIX_OPENCODE_INTERNAL_PORT=4096
KORTIX_STATIC_PORT=3211
KORTIX_WORKSPACE=/workspace
KORTIX_PROJECT_TARGET=/workspace/.kortix
KORTIX_DEFAULT_BRANCH=main
KORTIX_BRANCH_FETCH_ATTEMPTS=60
KORTIX_BRANCH_FETCH_DELAY=0.25
KORTIX_DEFAULT_OPENCODE_CONFIG_DIR=/ephemeral/kortix-master/opencode
KORTIX_PROJECT_AUTO_CLONE=0
KORTIX_COMPILED_BOOT_MODE=off
KORTIX_COMPILED_RUNTIME_FORMAT=
KORTIX_COMPILED_RUNTIME_SOURCE_SHA=
KORTIX_REPO_URL=
KORTIX_BRANCH_NAME=
KORTIX_GITHUB_TOKEN=
KORTIX_TOKEN=
```

## Build

```
bun install
bash scripts/build.sh
```

Produces `dist/kortixd` (primary) plus `dist/kortix-agent` (compatibility copy;
see the note at the top) — a single-file Bun binary targeting `bun-linux-x64`
by default. Set `BUN_COMPILE_TARGET` for another architecture. The Linux binary
built on macOS will not execute locally; that's expected. To smoke-test the
daemon on macOS, run from source:

```
KORTIX_PROJECT_AUTO_CLONE=0 KORTIX_SERVICE_PORT=9999 bun run src/main.ts
curl -s http://localhost:9999/kortix/health
```

The daemon should boot and report `opencode: "starting"` (or `"down"` if the
binary is genuinely missing) without crashing.

## Management CLI

`kortixd` is a normal installable app. Its subcommands (`src/cli.ts`) manage the
binary's own lifecycle; the default (no subcommand) and `serve` boot the daemon.

| Command                          | Effect                                                            |
| -------------------------------- | ---------------------------------------------------------------- |
| `kortixd` / `kortixd serve`      | Run the sandbox agent server (default).                          |
| `kortixd version`                | Print version + build digest (the binary's own sha256).          |
| `kortixd install [--dir <path>]` | Install the binary onto PATH. Idempotent; `--force` overwrites.  |
| `kortixd update [flags]`         | Self-update to the current published build.                      |
| `kortixd rollback`               | Revert to the previous binary (`<name>.prev`).                   |
| `kortixd --health-check`         | Smoke-test: boot a health server on an ephemeral port, exit 0.   |
| `kortixd --help`                 | Usage.                                                            |

The daemon also keeps its two pre-existing subcommands: `git-credential`
(git execs it as a credential helper) and `install-compiled-runtime`.

### Self-update reliability

`update` never bricks the app:

```
resolve target → verify content digest → smoke-test the new binary →
atomic swap (keep the replaced binary as <name>.prev) → post-swap health-check →
auto-rollback to <name>.prev on any failure
```

A half-written binary is never left on disk (write-to-temp + atomic
`rename(2)`). Exactly one previous version is kept for fast rollback.

### Boot sequence

The sandbox boot path runs, every start, idempotently:

```
kortixd install && kortixd update --boot && kortixd serve
```

- `install` is a fast no-op when the target already holds a binary (presence-
  based, so it never clobbers a binary that `update` already bumped).
- `update` does the ~700 B manifest/digest check FIRST and exits 0 with no
  download when the local binary already matches the target.
- `update --boot` is best-effort: any download/verify/health failure keeps the
  last-good binary and exits 0 so boot proceeds to `serve`. A bad publish never
  bricks a box; it serves stale-but-working and logs loudly. Manual
  `kortixd update` (no `--boot`) hard-fails non-zero instead.

### Bootstrap install

`install.sh` (curl | sh) is the one-line bootstrap that downloads the right
target binary and puts `kortixd` on PATH:

```
curl -fsSL https://<host>/kortixd/install.sh | sh
```

After it lands the first binary, `kortixd update` self-manages. Flags/env:
`--url`/`KORTIXD_URL`, `--base`/`KORTIXD_BASE_URL`, `--version`, `--dir`, and
`--from <path>` for an offline/local install.

### Relation to the sandbox supervisor

Inside a deployed box, `apps/sandbox/entrypoint.sh` is a shell supervisor that
performs the SAME kind of staged swap + crash-based rollback around the baked
`/usr/local/bin/kortix-agent` floor (via `agent.current` / `agent.next` /
`agent.prev` / exit code 75). The `kortixd update`/`rollback` subcommands bring
that reliability property into the binary itself so it works as a standalone app
on any machine, not only under the sandbox supervisor.
