# Apple Container compatibility spike

This optional spike checks the stateless Rust health image with Apple's
`container` CLI. It is for macOS 26 or newer on Apple silicon.

This spike does not change the production Dockerfile, OCI image, deployment, or
release workflow. It does not provide or claim Docker Compose compatibility.

## Prerequisites

1. Use an Apple silicon Mac with macOS 26 or newer.
2. Install the Apple `container` CLI from
   <https://github.com/apple/container>.
3. Make sure `rust/Dockerfile` exists.
4. Make sure port `18080` is available on the host.

The first run starts Apple Container services. The CLI can ask to install its
Linux kernel. Follow the Apple Container installation instructions if startup
fails.

## Run

From the repository root:

```sh
./scripts/apple-container-spike.sh
```

The script performs these checks:

1. Detects macOS 26 or newer and the `arm64` host architecture.
2. Detects the Apple `container` CLI.
3. Builds `rust/Dockerfile` as `linux/arm64` without changing production files.
4. Inspects the built OCI image and requires the `arm64` architecture.
5. Runs the stateless image with host port `18080` mapped to container port
   `8008`.
6. Requires `GET /health`, `/health/live`, `/health/ready`, and `/v1/health`
   to return a `2xx` status.
7. Stops and deletes the test container.

Unsupported hosts and a missing Apple `container` CLI return exit code `0` with
a `SKIP:` message. A supported host returns a nonzero exit code for a missing
Dockerfile, build error, wrong image architecture, startup error, or failed
health check.

## Overrides

Use environment variables for local experiments:

```sh
APPLE_CONTAINER_HOST_PORT=28080 \
APPLE_CONTAINER_HEALTH_PATH=/health \
APPLE_CONTAINER_HEALTH_ATTEMPTS=60 \
./scripts/apple-container-spike.sh
```

Other overrides are `APPLE_CONTAINER_DOCKERFILE`,
`APPLE_CONTAINER_CONTEXT`, `APPLE_CONTAINER_IMAGE`,
`APPLE_CONTAINER_PORT`, and `APPLE_CONTAINER_CLI`.
The `APPLE_CONTAINER_HOST_OS`, `APPLE_CONTAINER_HOST_ARCH`, and
`APPLE_CONTAINER_MACOS_MAJOR` overrides exist only to test detection logic.
