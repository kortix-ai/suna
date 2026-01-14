# syntax=docker.io/docker/dockerfile:1
FROM node:22-slim AS base

# ---- Deps Stage ----
# Install workspace dependencies with pnpm, including local workspace
# packages like @agentpress/shared.
FROM base AS deps

WORKDIR /app

# Lockfile mode: use --frozen-lockfile for prod (default), --no-frozen-lockfile for local dev
ARG PNPM_LOCKFILE_MODE=--frozen-lockfile

# Copy only the files needed for dependency resolution and workspace linking.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps ./apps
COPY packages ./packages

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    build-essential \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install only the frontend workspace project (and its deps) using pnpm.
RUN corepack enable pnpm && pnpm install --filter ./apps/frontend ${PNPM_LOCKFILE_MODE}


# ---- Builder Stage ----
FROM base AS builder
WORKDIR /app

# Bring the fully-installed workspace into the builder image.
COPY --from=deps /app /app

# Build the frontend app from its workspace location.
WORKDIR /app/apps/frontend

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT=standalone

RUN corepack enable pnpm && pnpm run build


# ---- Runner Stage ----
FROM base AS runner
WORKDIR /app

ENV NEXT_PUBLIC_VERCEL_ENV=production
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built frontend assets from the workspace path.
# Next.js standalone output includes everything needed to run the server.
# The standalone directory structure mirrors the workspace, so we copy it as-is.
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/public ./apps/frontend/public

USER nextjs

EXPOSE 3000

ENV PORT=3000

ENV HOSTNAME="0.0.0.0"
# Next.js standalone output in a monorepo creates server.js at apps/frontend/server.js
# relative to the standalone root (which we copied to /app)
CMD ["node", "apps/frontend/server.js"]