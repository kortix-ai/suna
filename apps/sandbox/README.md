# `apps/sandbox`

The base Docker image for every Kortix project-session sandbox.

```
apps/sandbox/
  Dockerfile         # two-stage: builds the agent binary, bakes runtime
  entrypoint.sh      # exec /usr/local/bin/kortix-agent "$@"
  README.md          # this file
```

The image bundles **only what the sandbox needs to run a session**:

- `git`, `ca-certificates`, `curl` — for cloning the project repo at boot.
- `opencode-ai` — the agent runtime every session runs, over its REST
  compatibility interface.
- `claude-agent-acp`, `codex-acp`, `pi-acp`, and `pi` — baked but **unused**.
  They belong to an experimental, unreleased multi-harness runtime that is off
  by default (`KORTIX_ACP_RUNTIME=false`). No released session starts them.
- `kortix-agent` — the compiled daemon from
  [`apps/kortix-sandbox-agent-server`](../kortix-sandbox-agent-server). Its
  source is built in a Docker pre-stage so the final image carries only
  the single Bun-compiled binary.

Triggers, channels, connectors, and secrets are **NOT in the image** —
those live in the cloud API and reach the sandbox via env-var injection
at create-time (secrets) or HTTP calls from outside (triggers).

## Build

From the repo root:

```sh
docker build -f apps/sandbox/Dockerfile -t kortix/kortix-sandbox:dev .
```

## How sessions actually boot

Production sessions do **not** use a shared snapshot. The snapshot builder
(`apps/api/src/snapshots/builder.ts`) reads each project's
`.kortix/Dockerfile`, layers the Kortix runtime (OpenCode REST compatibility,
the `kortix-agent` binary, and the entrypoint) on top, and creates a per-project
Daytona snapshot named `kortix-snap-{project[:8]}-{contentHash[:12]}`.
Each session boots from that project's latest `ready` snapshot.

The image in this directory is the reference layout for the layered
runtime — useful when you want to reproduce the boot environment locally
or iterate on the entrypoint. It is not pushed to Daytona as a global
snapshot.
