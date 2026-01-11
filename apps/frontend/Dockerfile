# syntax=docker.io/docker/dockerfile:1
# ---- Base Stage ----
FROM node:22-slim AS base

# Install dependencies only when needed
FROM base AS deps

WORKDIR /app

# Copy workspace configuration and lockfile from root
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# Copy package.json files for workspace packages
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/shared/package.json ./packages/shared/

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

# Install dependencies using pnpm workspace
RUN corepack enable pnpm && pnpm i --frozen-lockfile


# ---- Builder Stage ----
FROM base AS builder
WORKDIR /app

# Accept build arguments
ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_URL
ARG NEXT_PUBLIC_ENV_MODE
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY

# Set build-time environment variables
ENV NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL}
ENV NEXT_PUBLIC_URL=${NEXT_PUBLIC_URL}
ENV NEXT_PUBLIC_ENV_MODE=${NEXT_PUBLIC_ENV_MODE}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

# Copy all source files
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT=standalone

# Build from frontend directory
WORKDIR /app/apps/frontend
# Increase Node.js heap size to 6GB for the build
# Skip linting and type checking during Docker build to save memory
ENV NODE_OPTIONS="--max-old-space-size=6144"
ENV SKIP_ENV_VALIDATION=true
ENV NEXT_SKIP_LINT=true
ENV NEXT_SKIP_TYPE_CHECK=true
RUN corepack enable pnpm && pnpm run build

# ---- Runner Stage ----
FROM base AS runner
WORKDIR /app

# Accept build arguments for runtime
ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_URL
ARG NEXT_PUBLIC_ENV_MODE
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY

# Set runtime environment variables
ENV NEXT_PUBLIC_VERCEL_ENV=production
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL}
ENV NEXT_PUBLIC_URL=${NEXT_PUBLIC_URL}
ENV NEXT_PUBLIC_ENV_MODE=${NEXT_PUBLIC_ENV_MODE}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy public folder
COPY --from=builder /app/apps/frontend/public ./public

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/static ./.next/static

# When building from a subdirectory, Next.js standalone mode preserves the directory structure
# The server.js runs from apps/frontend/, so we need static files accessible from there too
# Copy static files to the subdirectory location where the server expects them
RUN mkdir -p apps/frontend/.next && \
    cp -r .next/static apps/frontend/.next/static && \
    chown -R nextjs:nodejs apps/frontend/.next

USER nextjs

EXPOSE 3000

ENV PORT=3000

# server.js is created by next build from the standalone output
# When building from apps/frontend subdirectory, Next.js may preserve the directory structure
# So server.js might be at ./server.js or ./apps/frontend/server.js
# https://nextjs.org/docs/pages/api-reference/config/next-config-js/output
ENV HOSTNAME="0.0.0.0"
CMD ["sh", "-c", "if [ -f server.js ]; then exec node server.js; elif [ -f apps/frontend/server.js ]; then exec node apps/frontend/server.js; else exec node $(find . -name server.js -type f | head -1); fi"]