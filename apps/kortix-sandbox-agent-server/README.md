# @kortix/sandbox-agent-server

Thin sandbox-side daemon that runs inside every Kortix project-session sandbox.

**Scope:**

1. Process supervisor for `opencode serve` (spawn, restart on crash, drain on
   SIGTERM/SIGINT).
2. Reverse proxy that fronts opencode's HTTP + SSE surface on
   `KORTIX_SERVICE_PORT` (default `8000`).
3. Small Kortix-namespaced control surface: `GET /kortix/health` and
   `POST /kortix/refresh`.
4. Static web server on `KORTIX_STATIC_PORT` (default `3211`) — serves any
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
3. If `KORTIX_PROJECT_AUTO_CLONE=1`, `git clone` the project repo to
   `/workspace/.kortix` and check out the requested branch. Failures are
   logged but non-fatal — the daemon still serves `/kortix/health`.
4. Resolve `OPENCODE_CONFIG_DIR` (project overlay wins over the baked default).
5. Start the opencode supervisor in the cloned project directory (`opencode serve --port <internal> --hostname 127.0.0.1`).
   If the binary isn't found we keep going and report `opencode: 'starting'`.
6. Start the Hono proxy on `0.0.0.0:KORTIX_SERVICE_PORT`.
7. Trap signals; on shutdown, drain proxy + static web + kill child.

## Routes

| Path             | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `GET /kortix/health` | Daemon liveness + opencode state + repo info (always 200 from daemon) |
| `POST /kortix/refresh` | Signed-context protected repo fast-forward + opencode restart.     |
| `/*`             | Reverse-proxied to opencode. 503 while `opencode !== 'ok'`.              |

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
  "commit_sha": "abc123..."
}
```

- `daemon` is always `"ok"` if the route responds.
- `opencode` is `"ok" | "starting" | "down"`. `"starting"` covers both
  pre-bind and between-restart states.
- `repo`, `branch`, `commit_sha` come from `git` in `KORTIX_PROJECT_TARGET` and
  are `null` when no repo has been materialized.

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

Produces `dist/kortix-agent` — a single-file Bun binary targeting the current
host architecture by default (`bun-linux-x64` or `bun-linux-arm64`). Set
`BUN_COMPILE_TARGET` when building for a specific Docker/runtime architecture.
The binary built on macOS will not execute locally; that's expected. To
smoke-test the daemon on macOS, run from source:

```
KORTIX_PROJECT_AUTO_CLONE=0 KORTIX_SERVICE_PORT=9999 bun run src/main.ts
curl -s http://localhost:9999/kortix/health
```

The daemon should boot and report `opencode: "starting"` (or `"down"` if the
binary is genuinely missing) without crashing.
