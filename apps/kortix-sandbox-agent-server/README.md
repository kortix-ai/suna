# @kortix/sandbox-agent-server

Thin sandbox-side daemon that runs inside every Kortix project-session sandbox.

## Scope

1. ACP harness runtime for official Claude/Codex adapters, native `opencode acp`,
   and `pi-acp` (spawn, raw JSON-RPC, SSE replay, drain).
2. Small Kortix control surface: `/kortix/health`, `/kortix/refresh`,
   `/kortix/env`, `/kortix/git`.
3. Generic workspace routes: `/file`, `/find`, `/presentation`, `/proxy`,
   `/web-proxy`.
4. Static web server on `KORTIX_STATIC_PORT` (default `3211`) for files the
   agent writes to disk.

Everything else - triggers, channels, connectors, secrets, preferences, session
lifecycle - lives in the cloud API. The daemon receives only the compiled
runtime env and exposes ACP as the client protocol.

## Boot Flow

1. Read env vars (`src/config.ts`).
2. Start the static web server.
3. Configure git identity and managed credential helpers.
4. Write the session agent environment file.
5. Materialize the project repo when `KORTIX_PROJECT_AUTO_CLONE=1`.
6. Spawn the compiled ACP harness process for `KORTIX_SESSION_ID` and
   `KORTIX_RUNTIME_HARNESS`.
7. Start the Hono daemon on `KORTIX_SERVICE_PORT`.
8. Run optional `sandbox.on_boot` in the materialized workspace.
9. Trap signals and drain the proxy, static server, and ACP child processes.

## Routes

| Path | Purpose |
| --- | --- |
| `GET /kortix/health` | Daemon liveness, repo state, and ACP readiness. Public. |
| `POST /kortix/refresh` | Signed-context protected repo fast-forward. |
| `POST /kortix/env` | Sandbox-service bearer protected env hot-sync. |
| `POST /kortix/git/*` | Git helper/control routes. |
| `GET /acp` | List live ACP process instances. |
| `POST /acp/:serverId?agent=<harness>` | Start/reuse a harness and send one raw ACP JSON-RPC envelope. |
| `GET /acp/:serverId` | Stream agent-originated ACP envelopes as replayable SSE. |
| `DELETE /acp/:serverId` | Stop an ACP process; idempotent. |
| `/file`, `/find`, `/presentation`, `/proxy`, `/web-proxy` | Generic daemon-owned workspace and preview routes. |

Unknown native runtime paths return `404`. There is no native OpenCode HTTP
reverse proxy and no PTY websocket in this daemon.

### `GET /kortix/health`

```json
{
  "daemon": "ok",
  "status": "ok",
  "runtimeReady": true,
  "runtime": "acp",
  "acp_harness": "codex",
  "acp_server_id": "session-id",
  "acp_ready": true,
  "uptime_s": 123,
  "static_web_port": 3211,
  "repo_required": true,
  "repo_ready": true,
  "repo": "https://github.com/owner/name.git",
  "branch": "main",
  "commit_sha": "abc123...",
  "boot_error": null,
  "boot_timeline": [],
  "auth": "configured"
}
```

`daemon` is `"ok"` if the route responds. `runtimeReady` means the repo branch
gate passed and the compiled ACP harness process is ready.

## Env Vars

```sh
KORTIX_SERVICE_PORT=8000
KORTIX_STATIC_PORT=3211
KORTIX_WORKSPACE=/workspace
KORTIX_PROJECT_TARGET=/workspace
KORTIX_DEFAULT_BRANCH=main
KORTIX_BRANCH_FETCH_ATTEMPTS=60
KORTIX_BRANCH_FETCH_DELAY=0.25
KORTIX_PROJECT_AUTO_CLONE=0
KORTIX_PROJECT_ID=
KORTIX_API_URL=
KORTIX_REPO_URL=
KORTIX_BRANCH_NAME=
KORTIX_SESSION_ID=
KORTIX_RUNTIME_HARNESS=codex
KORTIX_COMPILED_RUNTIME_PLAN=1
KORTIX_RUNTIME_CONFIG_DIR=.kortix/runtimes/codex
KORTIX_SANDBOX_TOKEN=
KORTIX_TOKEN=
KORTIX_ACP_CLAUDE_PATH=
KORTIX_ACP_CLAUDE_ARGS='[...]'
KORTIX_ACP_CODEX_PATH=
KORTIX_ACP_CODEX_ARGS='[...]'
KORTIX_ACP_OPENCODE_PATH=opencode
KORTIX_ACP_OPENCODE_ARGS='["acp"]'
KORTIX_ACP_PI_PATH=
KORTIX_ACP_PI_ARGS='[...]'
```

`KORTIX_RUNTIME_CONFIG_DIR` is mapped to the harness-native config variable:
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, or
`PI_CODING_AGENT_DIR`.

Each `KORTIX_ACP_<HARNESS>_ARGS` override is a JSON string array. ACP routes use
the same `X-Kortix-User-Context` HMAC gate as the rest of the signed daemon
surface.

## Build

```sh
bun install
bash scripts/build.sh
```

Produces `dist/kortix-agent`, a single-file Bun binary. Set
`BUN_COMPILE_TARGET` when building for a specific Docker/runtime architecture.
To smoke-test from source:

```sh
KORTIX_PROJECT_AUTO_CLONE=0 \
KORTIX_SERVICE_PORT=9999 \
KORTIX_SESSION_ID=test-session \
KORTIX_RUNTIME_HARNESS=codex \
KORTIX_COMPILED_RUNTIME_PLAN=1 \
bun run src/main.ts

curl -s http://localhost:9999/kortix/health
```
