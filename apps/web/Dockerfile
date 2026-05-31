# syntax=docker.io/docker/dockerfile:1
#
# Lightweight runner-only image.
#
# Build the frontend on the HOST first:
#   cd apps/web && NEXT_OUTPUT=standalone pnpm run build
#
# Then from repo root:
#   docker build -f apps/web/Dockerfile -t kortix/kortix-frontend:latest .
#
# For CLOUD builds (kortix.ai), override billing at build time:
#   NEXT_PUBLIC_BILLING_ENABLED=true pnpm build
#   docker build -f apps/web/Dockerfile -t kortix/kortix-frontend:cloud .
#
# Build-time env vars (baked into the image):
#   NEXT_PUBLIC_BILLING_ENABLED - "true" for cloud, "false" for self-hosted
#   NEXT_PUBLIC_BACKEND_URL   - API URL
#   NEXT_PUBLIC_URL           - Frontend URL
#   NEXT_PUBLIC_SUPABASE_URL  - Supabase URL
#   NEXT_PUBLIC_SUPABASE_ANON_KEY - Supabase anon key
#
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# License
COPY LICENSE /LICENSE

# Copy pre-built standalone output from the host.
COPY --chown=nextjs:nodejs apps/web/.next/standalone ./
COPY --chown=nextjs:nodejs apps/web/.next/static ./apps/web/.next/static
COPY --chown=nextjs:nodejs apps/web/public ./apps/web/public

# Remove any .env files from the standalone output — runtime env vars
# (set in docker-compose) must take precedence. Next.js .env files override
# process.env for server components, which breaks local/VPS deploys.
RUN rm -f /app/apps/web/.env /app/apps/web/.env.local /app/apps/web/.env.production /app/.env

# Copy entrypoint script (needs to run as root for VPS URL rewriting)
COPY apps/web/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# In local mode (no KORTIX_PUBLIC_URL), runs as nextjs user via CMD.
# In VPS mode, entrypoint does sed as root, then exec's node as nextjs.
USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Use entrypoint for VPS URL rewriting support
ENTRYPOINT ["/docker-entrypoint.sh"]
