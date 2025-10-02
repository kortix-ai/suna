# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Adentic is an open-source platform for building, managing, and training AI agents. The platform demonstrates its capabilities as a generalist AI worker platform. The platform consists of a Python FastAPI backend, Next.js frontend, Docker-based agent runtime environments, and Supabase for data/auth.

## Architecture

### Backend (Python/FastAPI)
- **Entry Point**: `backend/api.py` - Main FastAPI application with 4 uvicorn workers
- **Background Worker**: `backend/run_agent_background.py` - Dramatiq worker for async agent execution
- **Core Logic**: `backend/core/` contains 199+ Python modules
- **Agent Execution**: `backend/core/run.py` - Main agent orchestration with tool registration and LLM interaction
- **Thread Management**: `backend/core/agentpress/thread_manager.py` - Conversation state and LLM API calls
- **Sandboxing**: `backend/core/sandbox/` - Daytona-based Docker containers for secure agent code execution

### Frontend (Next.js/React)
- **Framework**: Next.js 15 with TypeScript, using Turbopack in dev
- **UI**: Radix UI components with Tailwind CSS
- **State**: Zustand for state management, TanStack Query for data fetching
- **Auth**: Supabase SSR authentication

### Infrastructure
- **Database**: Supabase (PostgreSQL) with basejump schema for multi-tenancy
- **Cache**: Redis for session state and background job queue (Dramatiq broker)
- **Execution**: Daytona manages isolated Docker sandbox instances (adentic/adentic:0.1.3.20 snapshot)
- **LLM**: LiteLLM for unified interface to Anthropic, OpenAI, Gemini, OpenRouter
- **Tools**: Tavily (search), Firecrawl (scraping), Exa (people search), optional RapidAPI

## Key Development Commands

### Setup
```bash
# Initial configuration (interactive wizard)
python setup.py

# Start services (Docker or manual based on setup choice)
python start.py
```

### Backend Development
```bash
cd backend

# Install dependencies
uv sync

# Run API server locally (requires Redis running)
uv run api.py

# Run background worker
uv run dramatiq --processes 4 --threads 4 run_agent_background

# Run tests
./test                    # All tests
./test --unit            # Fast unit tests only
./test --integration     # Integration tests
./test --llm            # LLM tests (costs money)
./test --coverage       # With coverage report
./test --path core/services  # Specific directory

# Docker-based backend services
docker compose down && docker compose up --build
docker compose up redis  # Redis only for local dev
```

### Frontend Development
```bash
cd frontend

# Install dependencies
npm install

# Development server
npm run dev

# Production build
npm run build

# Linting and formatting
npm run lint
npm run format
npm run format:check
```

### Full Stack (Docker Compose)
```bash
# Start all services
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f

# Stop all services
docker compose down
```

## Environment Configuration

### Backend `.env`
Critical variables set by `setup.py`:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- `REDIS_HOST` (use `redis` for Docker, `localhost` for local dev)
- `DAYTONA_API_KEY`, `DAYTONA_SERVER_URL`, `DAYTONA_TARGET`
- At least one LLM provider: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`
- `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `FIRECRAWL_URL`
- `WEBHOOK_BASE_URL`, `TRIGGER_WEBHOOK_SECRET`
- `MCP_CREDENTIAL_ENCRYPTION_KEY`
- `KORTIX_ADMIN_API_KEY`
- Optional: `RAPID_API_KEY`, `MORPH_API_KEY`, `COMPOSIO_API_KEY`, `EXA_API_KEY`

### Frontend `.env.local`
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_BACKEND_URL=http://localhost:8000/api`
- `NEXT_PUBLIC_URL=http://localhost:3000`
- `NEXT_PUBLIC_ENV_MODE=LOCAL`

## Important Implementation Details

### Agent Tool System
Tools are registered in `backend/core/run.py` via `ToolManager`. Each tool class inherits from `core.agentpress.tool.Tool` and defines functions as class methods decorated with tool schemas. Tools can be disabled per agent via `disabled_tools` list.

### Sandbox Execution
Agents run code in Daytona-managed Docker containers (snapshot: `kortix/suna:0.1.3.20`). The sandbox includes Chrome, VNC, web server (port 8080), and full sudo access. Customize by modifying `backend/core/sandbox/docker/` and rebuilding the snapshot.

### LLM Integration
All LLM calls go through `core.services.llm.make_llm_api_call()` using LiteLLM. Thread-based conversation management via `ThreadManager` stores messages in Supabase. Anthropic caching is applied automatically via `core.agentpress.prompt_caching`.

### Database Migrations
Supabase migrations in `backend/supabase/migrations/`. After setup, manually expose the `basejump` schema in Supabase dashboard (Project Settings → Data API → Exposed schemas).

### Background Jobs
Dramatiq actors in `run_agent_background.py` handle async agent execution. Redis serves as the broker. Each agent run acquires a lock to prevent duplicate execution.

### Testing
Tests use pytest with markers: `@pytest.mark.unit`, `@pytest.mark.integration`, `@pytest.mark.llm`. Test files must end with `.test.py` and live in `tests/` subdirectories within modules. Coverage target is 60%.

## Development Workflow

1. **Making changes**: Edit code, ensure Redis is running if testing backend locally
2. **Local API testing**: Set `REDIS_HOST=localhost` in backend/.env, run `uv run api.py` and `uv run dramatiq` in separate terminals
3. **Testing**: Use `./test --unit` for fast feedback, full suite before committing
4. **Frontend changes**: `npm run dev` with hot reload, backend must be running
5. **Docker rebuild**: After changing Dockerfile or dependencies, use `docker compose up --build`

## Notes

- The setup wizard (`setup.py`) is idempotent and can resume from interruption
- The `start.py` script detects setup method (Docker vs manual) and manages services accordingly
- Agent versions and configurations are managed via `backend/core/agent_crud.py`
- Billing integration via Stripe is in `backend/core/billing/`
- MCP (Model Context Protocol) support for external tool integrations in `backend/core/mcp_module/`
