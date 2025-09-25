# Third-Party Providers Overview

This document lists all external services used by the project, what each one is for, whether it’s required to run locally/in production, and the exact environment variables used by the codebase. Use this as a checklist when setting up a new environment.

> Tip: The setup wizard (`python setup.py`) will guide you through most of these. See also `docs/SELF-HOSTING.md` for end‑to‑end environment setup.

## Core (Required)

- Supabase (Postgres, Auth, Storage)
  - Purpose: primary database, authentication, and file storage (buckets)
  - Required: Yes (backend will not boot without it)
  - Env vars (backend): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
  - Env vars (frontend): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - Notes: expose the `basejump` schema in Supabase Project Settings → API.

- Redis
  - Purpose: background jobs (Dramatiq), caching
  - Required: Yes (runs as a Docker service via `docker compose`)
  - Env vars (backend): `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (optional), `REDIS_SSL`
  - Note: use `REDIS_HOST=redis` when both services run in Docker; use `localhost` if API runs locally.

- Agent Sandbox (Daytona)
  - Purpose: isolated runtime for agent actions
  - Required: Yes (for agent execution features)
  - Env vars (backend): `DAYTONA_API_KEY`, `DAYTONA_SERVER_URL` (default `https://app.daytona.io/api`), `DAYTONA_TARGET` (e.g., `us`)

- Search & Web Scraping
  - Tavily (web search)
    - Required: Yes
    - Env vars (backend): `TAVILY_API_KEY`
  - Firecrawl (web crawl/scrape)
    - Required: Yes
    - Env vars (backend): `FIRECRAWL_API_KEY`, `FIRECRAWL_URL` (default `https://api.firecrawl.dev`)

- LLM Provider (choose at least one)
  - Purpose: model inference via LiteLLM
  - Required: Functionally yes (pick one of these to actually run LLM features)
  - Supported env vars (backend):
    - OpenAI: `OPENAI_API_KEY`
    - Anthropic: `ANTHROPIC_API_KEY`
    - OpenRouter: `OPENROUTER_API_KEY`, optional `OPENROUTER_API_BASE` (default `https://openrouter.ai/api/v1`)
    - Google Gemini: `GEMINI_API_KEY`
    - Groq: `GROQ_API_KEY`
    - xAI: `XAI_API_KEY`
    - OpenAI‑Compatible: `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_API_BASE`
    - AWS Bedrock: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME`

## Important (Production or Feature‑Driven)

- Stripe (billing, subscriptions, credits)
  - Purpose: plans, trials, top‑ups, and subscription sync
  - Required: Only if billing is enabled
  - Env vars (backend): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - Notes: There are many price IDs defined in code. See `backend/core/utils/config.py` for plan IDs.

- Webhooks (public URL)
  - Purpose: receive callbacks (e.g., Supabase Cron → backend)
  - Required: Yes (production); For local dev, you can use ngrok/Cloudflare Tunnel to expose `http://localhost:8000`
  - Env vars (backend): `WEBHOOK_BASE_URL`, `TRIGGER_WEBHOOK_SECRET`

- MCP (secure user credentials for tools)
  - Purpose: encrypt and store per‑user credentials for MCP integrations
  - Required: Yes (to use MCP credentials safely)
  - Env vars (backend): `MCP_CREDENTIAL_ENCRYPTION_KEY`

## Observability & Analytics (Optional but Recommended)

- Sentry (errors)
  - Backend env var: `SENTRY_DSN`
  - Frontend env var: `NEXT_PUBLIC_SENTRY_DSN`

- Langfuse (LLM traces/metrics)
  - Backend env vars: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (default `https://cloud.langfuse.com`)

- PostHog (frontend analytics)
  - Frontend env var: `NEXT_PUBLIC_POSTHOG_KEY`

## Integrations (Optional)

- Composio (tool integrations + triggers)
  - Purpose: connect to Slack/Notion/etc. via MCP
  - Env vars (backend): `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET`, optional `COMPOSIO_API_BASE` (default `https://backend.composio.dev`)

- RapidAPI (extra tools like LinkedIn scraping, optional)
  - Env vars (backend): `RAPID_API_KEY`

- Google OAuth (optional; e.g., Google Slides upload)
  - Backend env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
  - Frontend env var: `NEXT_PUBLIC_GOOGLE_CLIENT_ID`

- Vercel Edge Config (feature flags on FE)
  - Frontend env var: `EDGE_CONFIG`

- Supabase Auth providers (optional)
  - Email via SMTP (SendGrid/Postmark/etc.): configure in `backend/supabase/config.toml`
  - SMS (Twilio): configure in `backend/supabase/config.toml` (`auth.sms.twilio`)
  - OAuth (GitHub/Google/etc.): configure in `backend/supabase/config.toml` under `[auth.external.*]`

## Quick Start: minimal env for local dev

Backend (`backend/.env`):

- Required
  - `ENV_MODE=local`
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - `REDIS_HOST=redis` (or `localhost` if API is not in Docker)
  - `TAVILY_API_KEY`
  - `FIRECRAWL_API_KEY`
  - `DAYTONA_API_KEY`, `DAYTONA_SERVER_URL`, `DAYTONA_TARGET`
  - One LLM key (e.g., `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`)
- Recommended
  - `MCP_CREDENTIAL_ENCRYPTION_KEY`
  - `WEBHOOK_BASE_URL` (use an ngrok URL when testing external callbacks)
  - `TRIGGER_WEBHOOK_SECRET`
- Optional
  - `RAPID_API_KEY`, `SENTRY_DSN`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `STRIPE_SECRET_KEY`

Frontend (`frontend/.env.local`):

- Required
  - `NEXT_PUBLIC_ENV_MODE=local`
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_BACKEND_URL=http://localhost:8000`
  - `NEXT_PUBLIC_URL=http://localhost:3000`
- Optional
  - `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `EDGE_CONFIG`

## Where this is used (code map)

- LLM provider configuration: `backend/core/services/llm.py`
- App configuration (env types/required fields): `backend/core/utils/config.py`
- Sentry: backend `backend/sentry.py`; frontend `frontend/src/app/monitoring/route.ts`
- Langfuse client: `backend/core/services/langfuse.py`
- Billing (Stripe): `backend/core/billing/*`, plus IDs in `backend/core/utils/config.py`
- Supabase client and storage: `backend/core/services/supabase.py`, knowledge base modules, and `backend/supabase/migrations/*`
- Composio endpoints: `backend/api.py` via `core/composio_integration`
- Frontend Supabase auth: `frontend/src/lib/supabase/*`, middleware, and auth pages
- PostHog: `frontend/instrumentation-client.ts` and various UI components
- Vercel Edge Config: `frontend/src/lib/edge-flags.ts`

## Notes on AWS

- AWS Bedrock is supported via LiteLLM if you supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION_NAME`.
- Direct S3 access is not required for this project. File storage is handled by Supabase Storage. You can optionally configure S3‑compatible backends in Supabase self‑hosting if desired.

---

If you need a single place to populate values, copy `backend/.env.example` → `backend/.env` and `frontend/.env.example` → `frontend/.env.local`, then run `python setup.py` at the repo root.
