# syntax=docker.io/docker/dockerfile:1

# Shared Dockerfile for the Bun API
# Build from repo root: docker build --build-arg SERVICE=apps/api -f apps/api/Dockerfile .

ARG BUN_VERSION=1.2
FROM oven/bun:${BUN_VERSION}-slim AS base

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
    docker.io \
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

# Copy SQL migrations used by ensureSchema() at runtime.
COPY supabase/migrations ./supabase/migrations

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
