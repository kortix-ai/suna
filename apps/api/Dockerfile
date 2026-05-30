# syntax=docker.io/docker/dockerfile:1

# Shared Dockerfile for the Bun API
# Build from repo root: docker build --build-arg SERVICE=apps/api -f apps/api/Dockerfile .

ARG BUN_VERSION=1.2
FROM oven/bun:${BUN_VERSION}-slim AS base

# ---- Sandbox Agent Stage ----
# The API builds Daytona layered snapshots at runtime. Those snapshots bake the
# sandbox-side daemon from this repo, so the deployable API image must carry the
# latest compiled Linux binary even though we no longer publish a sandbox image.
FROM oven/bun:${BUN_VERSION}-slim AS sandbox-agent

WORKDIR /agent

ARG KORTIX_AGENT_BUN_TARGET=bun-linux-x64

COPY apps/kortix-sandbox-agent-server/package.json apps/kortix-sandbox-agent-server/bun.lock ./
RUN bun install --frozen-lockfile

COPY apps/kortix-sandbox-agent-server/ ./
RUN BUN_COMPILE_TARGET=${KORTIX_AGENT_BUN_TARGET} bash scripts/build.sh

# ---- CLI Stage ----
# The same layered snapshots bake the `kortix` admin CLI (apps/cli) so every
# in-sandbox agent can run `kortix cr open`, `secrets`, `sessions`, … We compile
# it to a self-contained Linux binary here, the same way as the daemon above,
# and the runner copies it to the path the snapshot builder reads
# (apps/cli/dist/kortix → KORTIX_SNAPSHOT_CLI_BIN_PATH).
FROM oven/bun:${BUN_VERSION}-slim AS sandbox-cli

WORKDIR /cli

ARG KORTIX_AGENT_BUN_TARGET=bun-linux-x64

# Minimal workspace so bun resolves the two `@kortix/*` packages the CLI imports
# to their source, then compile (inlines them + smol-toml into one binary).
COPY apps/cli ./apps/cli
COPY packages/manifest-schema ./packages/manifest-schema
COPY packages/starter ./packages/starter
RUN printf '{"name":"kortix-cli-build","private":true,"workspaces":["apps/cli","packages/*"]}\n' > package.json \
    && bun install --no-save \
    && BUN_COMPILE_TARGET=${KORTIX_AGENT_BUN_TARGET} bash apps/cli/scripts/build.sh

# ---- Deps Stage ----
# Install with pnpm (matches lockfile), run with bun
FROM node:22-slim AS deps

WORKDIR /app

ARG SERVICE

# Copy workspace root files for pnpm install
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy the target app and workspace packages it depends on
COPY ${SERVICE} ./${SERVICE}
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/agent-tunnel ./packages/agent-tunnel
COPY packages/starter ./packages/starter
COPY packages/manifest-schema ./packages/manifest-schema

# Install pnpm and deps for this app + workspace packages it depends on.
# --shamefully-hoist flattens node_modules (no symlinks) so COPY works on all Docker versions.
# Include devDeps so drizzle-kit is available for schema push at runtime.
RUN corepack enable pnpm && \
    pnpm install --filter ./${SERVICE}... --shamefully-hoist --prod=false --ignore-scripts

# ---- Runner Stage ----
FROM base AS runner

WORKDIR /app

ARG SERVICE

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    docker.io \
    git \
    openssh-client && \
    rm -rf /var/lib/apt/lists/*

# License
COPY LICENSE /LICENSE

# Copy installed node_modules and source from deps stage.
# Root node_modules contains all hoisted deps (--shamefully-hoist).
COPY --from=deps /app/node_modules ./node_modules

# Copy workspace packages — source only, skip nested node_modules
# which may contain stale symlinks to the .pnpm store.
COPY --from=deps /app/packages/shared/src ./packages/shared/src
COPY --from=deps /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=deps /app/packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY --from=deps /app/packages/db/src ./packages/db/src
COPY --from=deps /app/packages/db/drizzle.config.ts ./packages/db/drizzle.config.ts
COPY --from=deps /app/packages/db/package.json ./packages/db/package.json
COPY --from=deps /app/packages/db/tsconfig.json ./packages/db/tsconfig.json
COPY --from=deps /app/packages/agent-tunnel/src ./packages/agent-tunnel/src
COPY --from=deps /app/packages/agent-tunnel/package.json ./packages/agent-tunnel/package.json
COPY --from=deps /app/packages/starter/src ./packages/starter/src
COPY --from=deps /app/packages/starter/package.json ./packages/starter/package.json
COPY --from=deps /app/packages/starter/tsconfig.json ./packages/starter/tsconfig.json
COPY --from=deps /app/packages/manifest-schema/src ./packages/manifest-schema/src
COPY --from=deps /app/packages/manifest-schema/package.json ./packages/manifest-schema/package.json
COPY --from=deps /app/packages/manifest-schema/tsconfig.json ./packages/manifest-schema/tsconfig.json

# Copy SQL migrations used by ensureSchema() at runtime.
COPY supabase/migrations ./supabase/migrations

# Copy runtime artifacts used by the layered snapshot builder.
COPY --from=sandbox-agent /agent/dist/kortix-agent ./apps/kortix-sandbox-agent-server/dist/kortix-agent
COPY --from=sandbox-cli /cli/apps/cli/dist/kortix ./apps/cli/dist/kortix
COPY apps/sandbox/entrypoint.sh ./apps/sandbox/entrypoint.sh
COPY apps/sandbox/agent-cli ./apps/sandbox/agent-cli
COPY packages/executor-sdk ./packages/executor-sdk

# Copy the app (source + its node_modules if any)
COPY --from=deps /app/${SERVICE} ./${SERVICE}

# Fix agent-tunnel resolution.
# pnpm may resolve agent-tunnel to a workspace/file symlink target that does not
# exist in the runtime image layout. Replace it with a direct source copy.
RUN rm -f ${SERVICE}/node_modules/agent-tunnel 2>/dev/null; \
    mkdir -p ${SERVICE}/node_modules/agent-tunnel
COPY --from=deps /app/packages/agent-tunnel/src ./${SERVICE}/node_modules/agent-tunnel/src
COPY --from=deps /app/packages/agent-tunnel/package.json ./${SERVICE}/node_modules/agent-tunnel/package.json

WORKDIR /app/${SERVICE}

# Pre-create the data dir and give the bun user write access before dropping privileges.
# The queue drainer writes to .kortix-data/queue at runtime; without this it fails with EACCES.
RUN mkdir -p /app/${SERVICE}/.kortix-data && \
    chown -R bun:bun /app/${SERVICE}/.kortix-data

# Non-root user (bun image ships with 'bun' user)
USER bun

CMD ["bun", "run", "src/index.ts"]
