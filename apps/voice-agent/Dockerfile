# syntax=docker.io/docker/dockerfile:1
#
# The voice worker, built for LiveKit Cloud's managed agent hosting.
#
#   cd apps/voice-agent && lk agent deploy
#
# LiveKit's build service builds this image and runs the worker for us; we host
# nothing. The build context is apps/voice-agent ITSELF, not the repo root —
# unlike every other Dockerfile here. That works only because this app has NO
# @kortix/* workspace dependencies (just @livekit/* and zod), so it installs
# standalone. If a workspace dep is ever added, this build breaks; the fix is to
# switch to a repo-root context with a synthetic workspace the way
# apps/llm-gateway/Dockerfile does it, not to paper over it.
#
# No secrets are baked in and none are needed at runtime: LiveKit Cloud injects
# LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET itself, every model runs
# through LiveKit Inference, and the per-call Kortix API URL and token arrive in
# the room metadata. `lk agent create` can be run with an empty secret set.

ARG BUN_VERSION=1.2

FROM oven/bun:${BUN_VERSION}-slim AS deps

WORKDIR /app

# Deps first, so editing src/ doesn't re-resolve the tree.
# The repo's pnpm-lock.yaml describes the whole workspace and is meaningless to
# a standalone install of this one package, so it is deliberately not copied.
COPY package.json ./
RUN bun install --production --no-save

FROM oven/bun:${BUN_VERSION}-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Surfaced in logs so it is obvious which build is live.
ARG KORTIX_VERSION=dev
ARG KORTIX_COMMIT=unknown
ENV KORTIX_VERSION=${KORTIX_VERSION}
ENV KORTIX_COMMIT=${KORTIX_COMMIT}

# package.json "main" points at src, so bun runs the TypeScript directly —
# no build step, same as apps/llm-gateway.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# The oven/bun image ships a non-root `bun` user.
USER bun

# The agents worker serves a small HTTP surface for liveness (verified by
# running this image: it logs "Server is listening on port 8081" and GET / on
# that port returns 200; note /health is NOT a route — it 404s).
#
# This port is for probes only. The worker takes no inbound traffic: it
# registers OUTBOUND to LiveKit and is handed jobs, which is why it needs no
# service, ingress, or load balancer wherever it runs.
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8081/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `start`, NOT `dev`. The agents CLI takes a subcommand and `dev` runs a
# hot-reloading development worker — pointing that at production traffic is a
# real hazard, so the production entrypoint is spelled out rather than inherited
# from a package.json script that could change underneath this file.
CMD ["bun", "run", "src/index.ts", "start"]
