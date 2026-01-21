# Development Guide

> Setup instructions, development workflows, testing, and common commands for working with SprintLab/Suna.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [BACKEND.md](./BACKEND.md) | [FRONTEND.md](./FRONTEND.md) | [DATABASE.md](./DATABASE.md)

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Quick Start](#quick-start)
4. [Backend Development](#backend-development)
5. [Frontend Development](#frontend-development)
6. [Database Workflows](#database-workflows)
7. [Docker Development](#docker-development)
8. [Testing](#testing)
9. [Code Quality](#code-quality)
10. [Debugging Tips](#debugging-tips)

---

## Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | 20.x | Frontend runtime |
| **Python** | 3.11 | Backend runtime |
| **pnpm** | 8.x+ | Frontend package manager |
| **uv** | 0.6.5+ | Python package manager |
| **Docker** | 24.x+ | Local services |
| **Git** | 2.x+ | Version control |

### Version Management (mise)

The project uses [mise](https://mise.jdx.dev/) for tool version management:

```bash
# Install mise
curl https://mise.run | sh

# Install required tool versions
mise install

# Verify versions
mise current
```

**mise.toml:**
```toml
[tools]
node = "20"
python = "3.11"
uv = "0.6.5"
```

---

## Environment Setup

### 1. Clone Repository

```bash
git clone https://github.com/sprintlab/suna.git
cd suna
```

### 2. Run Setup Wizard

```bash
python setup.py
```

The wizard will:
- Check required tools
- Create `.env` files
- Guide through API key configuration
- Initialize database (if using local Supabase)

### 3. Manual Environment Setup

If not using the wizard:

**Backend (.env):**

```bash
# Copy example
cp backend/.env.example backend/.env

# Edit with your values
```

Required variables:

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-jwt-secret

# Redis
REDIS_URL=redis://localhost:6379

# LLM Providers (at least one required)
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
OPENROUTER_API_KEY=your-key

# Sandbox (Daytona)
DAYTONA_API_KEY=your-key
DAYTONA_SERVER_URL=your-url
SANDBOX_SNAPSHOT_NAME=sprintlab/suna:0.1.3.28

# Optional: Search
TAVILY_API_KEY=your-key
FIRECRAWL_API_KEY=your-key
```

**Frontend (.env.local):**

```bash
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

---

## Quick Start

### Start All Services

```bash
python start.py
```

Or manually:

```bash
# Terminal 1: Backend
cd backend
uv sync
uv run api.py

# Terminal 2: Frontend
cd apps/frontend
pnpm install
pnpm dev

# Terminal 3: Redis (if not using Docker)
docker run -p 6379:6379 redis:alpine
```

### Access Points

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000 |
| API Docs (Swagger) | http://localhost:8000/docs |
| API Docs (ReDoc) | http://localhost:8000/redoc |

---

## Backend Development

### Install Dependencies

```bash
cd backend
uv sync
```

### Run Server

```bash
# Development (with reload)
uv run api.py

# Or directly with uvicorn
uv run uvicorn api:app --host 0.0.0.0 --port 8000 --reload
```

### Add New Dependency

```bash
uv add package-name

# With version constraint
uv add "package-name>=1.0.0"
```

### Common Commands

```bash
# Sync dependencies
uv sync

# Run any Python script
uv run python script.py

# Verify build
uv run python core/utils/scripts/verify_build.py

# Format code
make format

# Lint code
make lint

# Fix lint issues
make lint-fix
```

### Project Structure

```
backend/
├── api.py              # Entry point
├── core/
│   ├── agentpress/     # Agent orchestration
│   ├── agents/         # Agent management
│   ├── tools/          # Tool implementations
│   ├── services/       # External services
│   └── utils/          # Utilities
├── pyproject.toml      # Dependencies
└── tests/              # Test suite
```

---

## Frontend Development

### Install Dependencies

```bash
cd apps/frontend
pnpm install
```

### Run Development Server

```bash
pnpm dev
```

### Build for Production

```bash
pnpm build
```

### Common Commands

```bash
# Development
pnpm dev

# Build
pnpm build

# Start production server
pnpm start

# Lint
pnpm lint

# Format
pnpm format

# Type check
pnpm typecheck
```

### Project Structure

```
apps/frontend/
├── src/
│   ├── app/              # Next.js pages
│   ├── components/       # React components
│   ├── hooks/            # Custom hooks
│   ├── stores/           # Zustand stores
│   ├── lib/              # Utilities
│   └── types/            # TypeScript types
├── package.json
└── next.config.js
```

### Monorepo Commands

From root directory:

```bash
# Dev frontend only
pnpm dev:frontend

# Build frontend
pnpm build:frontend

# Install all dependencies
pnpm install
```

---

## Database Workflows

### Supabase CLI

```bash
# Install Supabase CLI
npm install -g supabase

# Link to project
cd backend
supabase link --project-ref your-project-ref

# Check status
supabase status
```

### Migrations

```bash
# Create new migration
supabase migration new add_feature_name

# Apply migrations (local)
supabase db reset

# Push migrations (remote)
supabase db push

# Pull remote changes
supabase db pull
```

### Database Reset (Local)

```bash
# Reset and apply all migrations
cd backend
supabase db reset
```

### View Database

```bash
# Start Supabase Studio locally
supabase start

# Opens at http://localhost:54323
```

### Common SQL Operations

```sql
-- Check table structure
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'threads';

-- Check RLS policies
SELECT * FROM pg_policies WHERE tablename = 'threads';

-- Enable RLS
ALTER TABLE your_table ENABLE ROW LEVEL SECURITY;
```

---

## Docker Development

### Start All Services

```bash
docker compose up -d
```

### Start Specific Services

```bash
# Just Redis and Backend
docker compose up -d redis backend

# Just Redis
docker compose up -d redis
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
```

### Stop Services

```bash
docker compose down

# Remove volumes too
docker compose down -v
```

### Rebuild Images

```bash
# Rebuild specific service
docker compose build backend

# Rebuild and start
docker compose up -d --build
```

### Docker Compose Services

| Service | Port | Purpose |
|---------|------|---------|
| `redis` | 6379 | Redis for caching/streams |
| `backend` | 8000 | FastAPI backend |
| `frontend` | 3000 | Next.js frontend |

---

## Testing

### Backend Tests

```bash
cd backend

# Run all tests
pytest

# Run specific test file
pytest tests/test_agents.py

# Run specific test
pytest tests/test_agents.py::test_agent_creation

# Run with markers
pytest -m e2e        # End-to-end tests
pytest -m slow       # Slow tests
pytest -m large_context  # Large context tests

# Run with coverage
pytest --cov=core --cov-report=html

# Verbose output
pytest -v

# Show print statements
pytest -s
```

### Test Markers

| Marker | Description | Usage |
|--------|-------------|-------|
| `e2e` | End-to-end tests | `pytest -m e2e` |
| `slow` | Slow-running tests | `pytest -m slow` |
| `large_context` | Large context tests | `pytest -m large_context` |

### Writing Tests

```python
# tests/test_example.py
import pytest
from core.tools.example_tool import ExampleTool

@pytest.fixture
def mock_thread_manager():
    """Fixture for mocked ThreadManager."""
    return Mock(spec=ThreadManager)

@pytest.mark.asyncio
async def test_example_function(mock_thread_manager):
    """Test example function works correctly."""
    tool = ExampleTool(mock_thread_manager)
    result = await tool.example_function(param="value")

    assert result.success is True
    assert "expected_key" in result.output

@pytest.mark.e2e
async def test_end_to_end_flow():
    """End-to-end test for complete flow."""
    # This test hits real APIs
    pass
```

### Frontend Tests

```bash
cd apps/frontend

# Run tests (if configured)
pnpm test

# Run with watch mode
pnpm test:watch
```

---

## Code Quality

### Backend Linting

```bash
cd backend

# Run linter
make lint

# Fix issues
make lint-fix

# Format code
make format
```

### Frontend Linting

```bash
cd apps/frontend

# Lint
pnpm lint

# Fix issues
pnpm lint --fix

# Format
pnpm format
```

### Pre-commit Hooks

```bash
# Install pre-commit
pip install pre-commit

# Install hooks
pre-commit install

# Run manually
pre-commit run --all-files
```

### Type Checking

```bash
# Backend (Python)
cd backend
uv run mypy core/

# Frontend (TypeScript)
cd apps/frontend
pnpm typecheck
```

---

## Debugging Tips

### Backend Debugging

#### Enable Debug Logging

```python
# In .env
LOG_LEVEL=DEBUG
```

#### Use structlog Context

```python
import structlog

# Bind context for request
structlog.contextvars.bind_contextvars(
    thread_id=thread_id,
    agent_run_id=agent_run_id
)

logger.info("Processing request")  # Includes context
```

#### Debug Agent Runs

```bash
# Check active runs
curl http://localhost:8000/v1/debug

# Check Redis health
curl http://localhost:8000/v1/debug/redis

# View metrics
curl http://localhost:8000/v1/metrics
```

### Frontend Debugging

#### React DevTools

Install React DevTools browser extension for component inspection.

#### TanStack Query DevTools

```typescript
// Already included in dev mode
// Opens panel in bottom-left corner
```

#### Debug Streaming

```typescript
// In useAgentStream hook
onMessage: (data) => {
  console.log('[Stream]', JSON.parse(data));
  // ...
}
```

### Database Debugging

```sql
-- Check recent agent runs
SELECT * FROM agent_runs
ORDER BY created_at DESC
LIMIT 10;

-- Check thread messages
SELECT * FROM messages
WHERE thread_id = 'your-thread-id'
ORDER BY created_at;

-- Check running agents (should be 0 after stop)
SELECT * FROM agent_runs
WHERE status = 'running';
```

### Redis Debugging

```bash
# Connect to Redis CLI
redis-cli

# List all streams
KEYS agent_run:*:stream

# Check stream length
XLEN agent_run:your-run-id:stream

# Read stream entries
XRANGE agent_run:your-run-id:stream - +

# Check TTL
TTL agent_run:your-run-id:stream
```

---

## Common Issues

### Port Already in Use

```bash
# Find process using port
lsof -i :8000

# Kill process
kill -9 <PID>
```

### Redis Connection Failed

```bash
# Check if Redis is running
docker ps | grep redis

# Start Redis
docker compose up -d redis
```

### Database Connection Issues

```bash
# Check Supabase URL in .env
echo $SUPABASE_URL

# Test connection
curl $SUPABASE_URL/rest/v1/ \
  -H "apikey: $SUPABASE_ANON_KEY"
```

### Module Not Found (Python)

```bash
# Ensure you're using uv
uv sync
uv run api.py
```

### Node Modules Issues

```bash
# Clean and reinstall
rm -rf node_modules
rm pnpm-lock.yaml
pnpm install
```

---

## IDE Setup

### VS Code Extensions

- **Python**: ms-python.python
- **Pylance**: ms-python.vscode-pylance
- **ESLint**: dbaeumer.vscode-eslint
- **Prettier**: esbenp.prettier-vscode
- **Tailwind CSS**: bradlc.vscode-tailwindcss

### VS Code Settings

```json
{
  "python.defaultInterpreterPath": ".venv/bin/python",
  "python.formatting.provider": "none",
  "[python]": {
    "editor.defaultFormatter": "ms-python.python"
  },
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

---

## Key File Locations

| Purpose | Path |
|---------|------|
| Setup Wizard | `setup.py` |
| Start Script | `start.py` |
| Backend Entry | `backend/api.py` |
| Backend Config | `backend/core/utils/config.py` |
| Frontend Entry | `apps/frontend/src/app/layout.tsx` |
| Docker Compose | `docker-compose.yaml` |
| Migrations | `backend/supabase/migrations/` |
| Test Suite | `backend/tests/` |

---

*For architecture overview, see [ARCHITECTURE.md](../ARCHITECTURE.md). For backend details, see [BACKEND.md](./BACKEND.md).*
