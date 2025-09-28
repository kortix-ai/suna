# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
# Setup and install
python setup.py   # Run initial setup wizard
python start.py   # Start the platform

# Frontend development (in frontend/)
npm run dev       # Start development server with Turbopack
npm run build     # Build for production
npm run lint      # Run linting
npm run format    # Format code with Prettier

# Backend development (in backend/)
uv run uvicorn api:app --reload  # Start FastAPI development server
uv run dramatiq --processes 4 --threads 4 run_agent_background  # Start background worker
uv run pytest     # Run all tests
./run_tests.py    # Alternative test runner with options

# Docker
docker-compose up -d     # Start all services
docker-compose down      # Stop all services
docker-compose logs -f   # View logs
```

### Testing
```bash
# Backend tests (from backend/)
uv run pytest -v                           # Run all tests verbose
uv run pytest core/tools/test_*.py -v     # Run specific test files
uv run pytest -m "not slow" -v            # Skip slow tests
./run_tests.py --coverage                 # Run with coverage report
```

## Architecture

### Overall Structure
Adentic is an open-source platform for building and managing AI agents, with Adentic as the flagship generalist AI worker demonstrating platform capabilities.

**Key Components:**
- **Frontend**: Next.js 15 with React 18, Turbopack, TypeScript, Tailwind CSS v4, Supabase client
- **Backend**: FastAPI (Python 3.11+), LiteLLM for LLM providers, Dramatiq for background jobs, Redis for caching
- **Database**: Supabase (PostgreSQL) for authentication, user data, agent configurations
- **Agent Runtime**: Daytona SDK for secure execution environments, Docker containers for isolation

### Backend Architecture

**Core modules** (`backend/core/`):
- `agent_crud.py`: Agent CRUD operations and management
- `auth.py`: Authentication and JWT handling  
- `run.py`: Main agent execution logic
- `adentic_config.py`: Agent configuration management
- `tools/`: Extensible tool system for agent capabilities
  - Browser automation, file management, API integrations
  - MCP (Model Context Protocol) tool wrapper support
  - Data providers for various external services

**Background Processing**:
- `run_agent_background.py`: Dramatiq worker for async agent execution
- Redis for job queue and session management

### Frontend Architecture

**Key directories** (`frontend/src/`):
- `app/`: Next.js app router pages and layouts
- `components/`: Reusable UI components (shadcn/ui based)
- `contexts/`: React contexts for global state
- `hooks/`: Custom React hooks
- `lib/`: Utilities, API clients, Supabase client

**State Management**: 
- Zustand for client state
- React Query for server state and caching
- Supabase real-time subscriptions

### Tool System

Agents use an extensible tool system to interact with external services:
- Browser automation via Daytona SDK
- File operations and document processing
- Web search and data extraction (Tavily, Firecrawl)
- API integrations (configurable per deployment)
- MCP protocol support for third-party tools

### Deployment

- Docker Compose for local development and self-hosting
- Three main services: backend API, worker, frontend
- Redis for caching and job queue
- Environment-based configuration via `.env` files

## Key Files

- `setup.py`: Automated setup wizard for initial configuration
- `start.py`: Platform startup script
- `docker-compose.yaml`: Service orchestration
- `backend/api.py`: Main FastAPI application
- `backend/run_agent_background.py`: Background job processor
- `frontend/src/app/(dashboard)/dashboard/page.tsx`: Main dashboard

## Workflow Automation

The repository includes workflow automation tools in `context2/.claude/commands/`:
- `/specify`: Create feature specifications from natural language descriptions
- `/clarify`: Interactive clarification workflow for ambiguous requirements
- `/plan`: Generate implementation plans and technical design artifacts
- `/implement`: Execute implementation based on task specifications
- `/tasks`: Break down features into executable task lists
- `/analyze`: Analyze existing features and codebase structure
- `/constitution`: Review and update project standards and guidelines

These commands integrate with the `.specify/` directory structure for artifact management.