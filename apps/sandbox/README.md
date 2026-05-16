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
- `opencode-ai` — the OpenCode CLI the daemon supervises.
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
docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .
```

## Use as the Daytona snapshot

Push the image to a registry, then create a Daytona snapshot pointing at
that image. Update `apps/api/.env`:

```
DAYTONA_SNAPSHOT=<your-snapshot-name>
```

Restart the API. New sessions provisioned via `POST /v1/projects/:id/sessions`
will spin up this image; the daemon reads the env vars the API already
passes (`KORTIX_REPO_URL`, `KORTIX_BRANCH_NAME`, `KORTIX_GITHUB_TOKEN`,
`KORTIX_SERVICE_PORT=8000`, etc.) and brings the sandbox online.
