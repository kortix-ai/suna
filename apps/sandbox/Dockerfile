# syntax=docker/dockerfile:1.7
#
# Kortix sandbox image — the base Daytona snapshot for every project
# session. Bakes:
#   - git + ca-certificates + curl  (project repo materialization)
#   - opencode CLI                  (the supervised child process)
#   - kortix-agent                  (compiled daemon from
#                                    apps/kortix-sandbox-agent-server)
#
# Two-stage build:
#   1. `builder`  — installs the daemon's deps and runs
#                   `bun build --compile` for the target image architecture
#                   to produce /agent/dist/kortix-agent.
#   2. final      — copies the binary onto a clean runtime base alongside
#                   git + opencode.
#
# Build from the repo root:
#   docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .
#
# To register with Daytona, push to a registry then point the snapshot
# at the resulting image:tag.

# ─── Stage 1: build the agent binary ────────────────────────────────────

FROM oven/bun:1-debian AS builder

ARG TARGETARCH

WORKDIR /agent
COPY apps/kortix-sandbox-agent-server/package.json apps/kortix-sandbox-agent-server/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/kortix-sandbox-agent-server/ ./
RUN case "${TARGETARCH:-}" in \
        amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
        arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
        *) echo "Unsupported Docker target architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac \
    && bash scripts/build.sh

# ─── Stage 2: runtime ───────────────────────────────────────────────────

FROM oven/bun:1-debian

ARG OPENCODE_VERSION=1.14.28

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

# OpenCode is distributed as an npm package. Install globally so it ends
# up on PATH as `opencode` — the daemon will auto-detect it (or prefer
# /usr/local/bin/opencode-kortix if a patched build is present).
RUN npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
    && command -v opencode \
    && opencode --version

COPY --from=builder /agent/dist/kortix-agent /usr/local/bin/kortix-agent
COPY apps/sandbox/entrypoint.sh /usr/local/bin/kortix-entrypoint
# Agent CLIs. Source ships at /opt/kortix/agent-cli; install-shims.sh
# generates a /usr/local/bin/<name> shim for every *.ts file (excluding
# the shared lib/ dir) so opencode can invoke them by bare name. Adding a
# new CLI: drop a .ts file under a category subdir, rebuild the image.
# See apps/sandbox/agent-cli/README.md for the contract.
COPY apps/sandbox/agent-cli/ /opt/kortix/agent-cli/
RUN chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix-entrypoint /opt/kortix/agent-cli/install-shims.sh \
    && bash /opt/kortix/agent-cli/install-shims.sh /opt/kortix/agent-cli

ENV KORTIX_WORKSPACE=/workspace
WORKDIR /workspace

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
