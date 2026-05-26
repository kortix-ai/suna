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
#   docker build -f apps/sandbox/Dockerfile -t kortix/kortix-sandbox:dev .
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
# Keep in sync with AGENT_BROWSER_VERSION / PLAYWRIGHT_VERSION in
# apps/api/src/snapshots/{builder,dockerfile-layer}.ts
ARG AGENT_BROWSER_VERSION=0.27.0
ARG PLAYWRIGHT_VERSION=1.60.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nodejs \
        npm \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# OpenCode is distributed as an npm package. Install globally so it ends
# up on PATH as `opencode` — the daemon will auto-detect it (or prefer
# /usr/local/bin/opencode-kortix if a patched build is present).
RUN npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
    && command -v opencode \
    && opencode --version

# agent-browser (Vercel agent-browser): browser-automation CLI for the agent.
# Chrome for Testing (what `agent-browser install` fetches) has no linux-arm64
# build, so we source Chromium from Playwright instead — it ships both
# linux-x64 and linux-arm64 builds and installs the OS libs via --with-deps —
# and point agent-browser at it with AGENT_BROWSER_EXECUTABLE_PATH below.
RUN npm install -g --no-audit --no-fund "agent-browser@${AGENT_BROWSER_VERSION}" \
    && apt-get update \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf "$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)" /usr/local/bin/chromium \
    && /usr/local/bin/chromium --version \
    && agent-browser --version
# --no-sandbox: container runs as root and Chromium refuses its own sandbox there.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage

COPY --from=builder /agent/dist/kortix-agent /usr/local/bin/kortix-agent
COPY apps/sandbox/entrypoint.sh /usr/local/bin/kortix-entrypoint
# Keep the repo-relative layout under /opt/kortix so agent CLIs can import
# shared workspace packages the same way they do in local tests.
COPY apps/sandbox/agent-cli/ /opt/kortix/apps/sandbox/agent-cli/
COPY packages/executor-sdk/ /opt/kortix/packages/executor-sdk/
RUN chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix-entrypoint /opt/kortix/apps/sandbox/agent-cli/install-shims.sh \
    && bash /opt/kortix/apps/sandbox/agent-cli/install-shims.sh /opt/kortix/apps/sandbox/agent-cli

ENV KORTIX_WORKSPACE=/workspace
WORKDIR /workspace

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
