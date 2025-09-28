# Suna Self-Hosting Guide

This guide walks you through hosting your own Suna instance, including required environment variables and two deployment options: with Docker and without Docker.

## Table of Contents

- Overview
- Prerequisites
  - 1.  Supabase Project
  - 2.  API Keys (Required vs Optional)
  - 3.  Required Software
- Installation Steps
- Environment Configuration
  - Backend (.env)
  - Frontend (.env.local)
- Hosting Options
  - A. With Docker (recommended)
  - B. Without Docker (manual)
- Post‑Installation Checks
- Troubleshooting

## Overview

Suna is composed of:

1. Backend API (FastAPI) - REST endpoints, thread management, LLM orchestration
2. Backend Worker (Dramatiq) - background agent task execution
3. Frontend (Next.js) - web UI
4. Agent Sandbox (Daytona) - isolated runtime for agent actions
5. Supabase - database and auth

## Prerequisites

### 1. Supabase Project

1. Create a project at https://supabase.com/
2. From Project Settings → API, copy:
   - Project URL (e.g., https://<your>.supabase.co)
   - anon key
   - service role key

Also expose the basejump schema: Project Settings → API → Add `basejump` to Exposed Schemas.

### 2. API Keys

Below is a summary of environment variables detected from the codebase and whether they are required for the backend to boot. Some are optional in the code, but functionally you’ll want at least one LLM provider.

Backend keys (by purpose):

| Purpose       | Key                           |                         Required to boot | Default                    | Notes                                                               |
| ------------- | ----------------------------- | ---------------------------------------: | -------------------------- | ------------------------------------------------------------------- |
| Environment   | ENV_MODE                      |                                       No | local                      | local, staging, production                                          |
| Database/Auth | SUPABASE_URL                  |                                      Yes | -                          | Supabase project URL                                                |
|               | SUPABASE_ANON_KEY             |                                      Yes | -                          | Supabase anon key                                                   |
|               | SUPABASE_SERVICE_ROLE_KEY     |                                      Yes | -                          | Supabase service role key                                           |
| Redis         | REDIS_HOST                    |                                      Yes | redis                      | Use `redis` with Docker, `localhost` without                        |
|               | REDIS_PORT                    |                                       No | 6379                       |                                                                     |
|               | REDIS_PASSWORD                |                                       No | -                          |                                                                     |
|               | REDIS_SSL                     |                                       No | true                       | Set false for local/Docker compose                                  |
| LLM providers | ANTHROPIC_API_KEY             | Functionally required (at least one LLM) | -                          | Any one of Anthropic/OpenAI/Groq/OpenRouter/Gemini/X.ai/AWS Bedrock |
|               | OPENAI_API_KEY                |                                        " | -                          |                                                                     |
|               | GROQ_API_KEY                  |                                        " | -                          |                                                                     |
|               | OPENROUTER_API_KEY            |                                        " | -                          |                                                                     |
|               | GEMINI_API_KEY                |                                        " | -                          |                                                                     |
|               | XAI_API_KEY                   |                                        " | -                          |                                                                     |
|               | AWS_ACCESS_KEY_ID             |                     " (if using Bedrock) | -                          |                                                                     |
|               | AWS_SECRET_ACCESS_KEY         |                     " (if using Bedrock) | -                          |                                                                     |
|               | AWS_REGION_NAME               |                     " (if using Bedrock) | -                          |                                                                     |
| Web search    | TAVILY_API_KEY                |                                      Yes | -                          | Used by search tools                                                |
| Web scraping  | FIRECRAWL_API_KEY             |                                      Yes | -                          | Used by scraping tools                                              |
| Data APIs     | RAPID_API_KEY                 |                                      Yes | -                          | Enables LinkedIn scraping and other data tools                      |
| Agent sandbox | DAYTONA_API_KEY               |                                      Yes | -                          | Required by Daytona SDK                                             |
|               | DAYTONA_SERVER_URL            |                                      Yes | https://app.daytona.io/api |                                                                     |
|               | DAYTONA_TARGET                |                                      Yes | us                         | region/target                                                       |
| Observability | LANGFUSE_PUBLIC_KEY           |                                       No | -                          | Optional tracing                                                    |
|               | LANGFUSE_SECRET_KEY           |                                       No | -                          |                                                                     |
|               | LANGFUSE_HOST                 |                                       No | https://cloud.langfuse.com |                                                                     |
| Credentials   | MCP_CREDENTIAL_ENCRYPTION_KEY |                              Recommended | -                          | Used to encrypt stored credentials; generated if missing            |
| Triggers      | WEBHOOK_BASE_URL              |                                       No | http://localhost:8000      | Public base URL for inbound webhooks                                |
|               | TRIGGER_WEBHOOK_SECRET        |                              Recommended | -                          | Verifies inbound triggers                                           |
| Billing       | STRIPE\_\*                    |                                       No | -                          | Only if you enable billing                                          |
| Admin         | KORTIX_ADMIN_API_KEY          |                                       No | -                          | Protects admin APIs                                                 |
| Integrations  | COMPOSIO_API_KEY              |                                       No | -                          | Optional Composio integration for tool connections                  |
|               | COMPOSIO_WEBHOOK_SECRET       |                                       No | -                          | Optional Composio webhook secret                                    |

Frontend keys:

| Key                           | Required | Default               | Notes                               |
| ----------------------------- | -------: | --------------------- | ----------------------------------- |
| NEXT_PUBLIC_ENV_MODE          |       No | local                 |                                     |
| NEXT_PUBLIC_SUPABASE_URL      |      Yes | -                     | Must match backend Supabase project |
| NEXT_PUBLIC_SUPABASE_ANON_KEY |      Yes | -                     | Supabase anon key                   |
| NEXT_PUBLIC_BACKEND_URL       |      Yes | http://localhost:8000 | Backend API base URL                |
| NEXT_PUBLIC_URL               |       No | http://localhost:3000 | Public site URL                     |

Notes:

- At least one LLM provider key is functionally required to run agents.
- Daytona keys are required by configuration. If you don’t plan to use sandboxes, you can supply placeholder values to boot, but related features won’t be usable.

### 3. Required Software

- Docker
- Git
- Python 3.11+
- Node.js 18+ and npm

Optional (but supported):

- uv (Python package manager/runner)
- Supabase CLI

## Installation Steps

1. Clone the repository

```bash
git clone https://github.com/kortix-ai/suna.git
cd suna
```

2. Prepare environment files

- Backend: copy `backend/.env.example` to `backend/.env` and fill the required keys
- Frontend: copy `frontend/.env.example` to `frontend/.env.local` and fill the required keys

## Environment Configuration

### Backend (`backend/.env`)

Minimal example (required keys only):

```env
ENV_MODE=local

SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY

# Redis: use redis for Docker, localhost for manual
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_SSL=false

# LLM provider: provide at least one
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...

TAVILY_API_KEY=YOUR_TAVILY_API_KEY
FIRECRAWL_API_KEY=YOUR_FIRECRAWL_API_KEY

DAYTONA_API_KEY=YOUR_DAYTONA_API_KEY
DAYTONA_SERVER_URL=https://app.daytona.io/api
DAYTONA_TARGET=us

# Data APIs required by configuration
RAPID_API_KEY=YOUR_RAPID_API_KEY

MCP_CREDENTIAL_ENCRYPTION_KEY=GENERATED_FERNET_KEY
WEBHOOK_BASE_URL=http://localhost:8000
TRIGGER_WEBHOOK_SECRET=your_random_string
```

To generate a Fernet key for MCP_CREDENTIAL_ENCRYPTION_KEY:

```bash
python - << 'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
```

### Frontend (`frontend/.env.local`)

```env
NEXT_PUBLIC_ENV_MODE=local
NEXT_PUBLIC_SUPABASE_URL=YOUR_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_URL=http://localhost:3000
```

## Hosting Options

### A. With Docker (recommended)

This uses the root `docker-compose.yaml` to bring up Redis, backend, worker, and frontend.

1. Ensure `backend/.env` and `frontend/.env.local` are filled.
2. From the project root:

```bash
docker compose up -d --build
```

3. Access:

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000

4. Logs and lifecycle:

```bash
docker compose logs -f
docker compose ps
docker compose down
```

Redis is already included in this compose file. No extra steps are needed.

### B. Without Docker (manual)

You’ll run Redis in Docker, then start backend and worker locally, and the frontend via npm.

1. Start Redis in Docker

```bash
docker compose up -d redis
```

2. Backend API and Worker (Python venv)

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate
python -m pip install -e .

# Start the worker (terminal 1)
python -m dramatiq run_agent_background --processes 4 --threads 4

# Start the API (terminal 2)
uvicorn api:app --host 0.0.0.0 --port 8000 --reload
```

Alternative using uv:

```bash
# terminal 1
cd backend
uv run dramatiq --processes 4 --threads 4 run_agent_background

# terminal 2
cd backend
uv run uvicorn api:app --host 0.0.0.0 --port 8000 --reload
```

3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Visit http://localhost:3000 and sign up via Supabase auth.

## Post‑Installation Checks

- Frontend loads at http://localhost:3000
- Backend health: http://localhost:8000/health returns OK
- Create an account and start an agent; verify logs for worker activity

## Troubleshooting

- Docker services fail: check `docker compose logs -f` and port conflicts (3000, 8000, 6379)
- Supabase errors: confirm URL and keys; basejump schema is exposed
- LLM errors: ensure at least one LLM API key is set and not rate-limited
- Daytona errors: verify API key/URL/target; sandbox operations require valid Daytona setup
- Redis connection errors: ensure `REDIS_HOST=redis` when using Docker, `localhost` when fully local
- if you get an issue saying `ghcr.io/suna-ai/suna-backend:latest` already exists, then try running the docker command again, it should work the second time automatically.

If you get a startup error complaining about missing configuration fields, it means a required key from the table above is missing in `backend/.env`.

For help, join the Suna Discord or open an issue on GitHub.
