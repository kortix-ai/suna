# syntax=docker.io/docker/dockerfile:1
#
# Standalone LLM gateway (apps/llm-gateway): an OpenAI-compatible proxy that
# every sandbox model call routes through. Build from the repo root:
#   docker build -f apps/llm-gateway/Dockerfile -t kortix-gateway .
#
# Far simpler than apps/api — no sandbox-agent/CLI stages, no migrations. Just
# the Bun+Hono server plus its two workspace packages (@kortix/llm-gateway →
# @kortix/shared) and hono + langfuse.

ARG BUN_VERSION=1.2

# ---- Deps Stage ----
# A MINIMAL synthetic workspace (only the gateway + its two packages) so we don't
# drag in the real root package.json's deps (@kortix/agent-tunnel, …). Same trick
# the API Dockerfile uses for the CLI. bun resolves the @kortix/* workspaces to
# source + pulls hono + langfuse.
FROM oven/bun:${BUN_VERSION}-slim AS deps

WORKDIR /app

COPY apps/llm-gateway ./apps/llm-gateway
COPY packages/llm-gateway ./packages/llm-gateway
COPY packages/shared ./packages/shared

RUN printf '{"name":"kortix-gateway-build","private":true,"workspaces":["apps/llm-gateway","packages/*"]}\n' > package.json \
    && bun install --no-save

# ---- Runner Stage ----
FROM oven/bun:${BUN_VERSION}-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Baked once at build; surfaced by /health and traces so we know which code is live.
ARG KORTIX_VERSION=dev
ARG KORTIX_COMMIT=unknown
ENV KORTIX_VERSION=${KORTIX_VERSION}
ENV KORTIX_COMMIT=${KORTIX_COMMIT}

# Hoisted deps + the two workspace package sources the app imports as
# @kortix/llm-gateway (→ @kortix/shared). package.json "main" points at src, so
# bun runs the TypeScript directly — no separate build step.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/packages/shared ./packages/shared
COPY --from=deps /app/packages/llm-gateway ./packages/llm-gateway
COPY --from=deps /app/apps/llm-gateway ./apps/llm-gateway

WORKDIR /app/apps/llm-gateway

# Non-root (the oven/bun image ships a 'bun' user).
USER bun

# Chart sets PORT from containerPort (8090); the server reads it from config.
EXPOSE 8090

CMD ["bun", "run", "src/main.ts"]
