---
recorded: 2026-10-08T13:48:48Z
incident_date: 2026-10-08
---
# Put a new API secret in the deployed env bundle too; .env.<env> never reaches a running ECS task

**Rule:** When a change adds an API secret, set it with `dotenvx set` in `apps/api/.env.<env>` AND add the same key to the deployed bundle `kortix-<env>-env` (AWS Secrets Manager; dev `us-east-2`, staging `eu-west-2`), then force a new ECS deployment. After the deploy, prove the running API holds it through the route that needs it, not through `/health`.

**Trigger surface:** Adding a key to `config.ts` that a deployed environment must have; any route that answers `503 <feature>_not_configured` when a secret is missing.

**Incident:** 2026-10-08, PR #9390 (app event triggers; near-miss caught in dev verification). `COMPOSIO_WEBHOOK_SECRET` was committed encrypted in `apps/api/.env.dev`, the deploy reported Live on dev, and `/health` served the merge SHA, but `POST /v1/webhooks/events/composio` answered `503 event_ingress_not_configured`: ECS tasks read `kortix-dev-env`, and nothing syncs git `.env.dev` into it. Every app event would have been refused until someone noticed.

**Enforcement:** none yet: a Deploy Dev step that lists the keys in `apps/api/.env.dev` and warns on each key missing from `kortix-dev-env` (names only, never values). Until then the route that needs the secret is the detector: `connect/triggers.mdx` → "Self-hosting event triggers" step 4 tells operators to check it.
