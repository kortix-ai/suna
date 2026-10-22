# Production web on ECS Fargate

This stack owns the `kortix-prod-web` ECS service and
`prod-fe-ecs.kortix.com`. It reads the production VPC, subnets, and
`kortix-prod-web-env` secret. It uses the remote state key
`prod/ecs-web.tfstate`.

The service starts with two on-demand Fargate tasks across private subnets.
CPU and memory target tracking scale it from two to twelve tasks. The ECS
deployment circuit breaker rolls back unhealthy task revisions.

This stack never manages `kortix.com`. Vercel remains active during parallel
validation. Production protection is disabled in the rendered web profile.

## Canonical cutover gate

The canonical hostname remains on Vercel. The ECS service is deployed in
parallel after the API release and verified by `verify-web-ecs` in
`.github/workflows/deploy-prod.yml`. Do not disable `deploy-web-vercel` or
change the canonical DNS record in an ordinary application release.

From the same network and at the same time, run
`bun infra/scripts/compare-web-latency.mjs /api/health` and repeat for `/`.
The script measures 20 sequential complete responses per origin and fails if
ECS p75 or p95 exceeds Vercel by more than 20%. Sample from both US and EU
networks during a representative traffic window before a DNS change. This
probe measures response latency, **not** Core Web Vitals, authenticated SSR,
cache-hit ratio, or load capacity. Check those separately in production
telemetry; a green probe alone does not authorize a cutover.

A release owner must approve a separate Cloudflare DNS change to point
`kortix.com` at the prod web ALB. Confirm Cloudflare proxy/WAF, TLS, OAuth
redirects, image and static asset cache behavior, and both-region metrics
before switching. Retain the Vercel record and deployment as a rollback path
until the canonical hostname serves the expected commit and health checks
pass under real traffic. Only then remove the Vercel deployment dependency
and credentials in a separate change. DNS and production infrastructure are
not changed by this repository-only measurement tool.
