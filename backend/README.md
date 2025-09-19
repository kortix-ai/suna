# Suna Backend

## Quick Setup

The easiest way to get your backend configured is to use the setup wizard from the project root:

```bash
cd .. # Navigate to project root if you're in the backend directory
python setup.py
```

This will configure all necessary environment variables and services automatically.

## Running the backend

Within the backend directory, run the following command to stop and start the backend:

```bash
docker compose down && docker compose up --build
```

## Running Individual Services

You can run individual services from the docker-compose file. This is particularly useful during development:

### Running only Redis

```bash
docker compose up redis
```

### Running only the API and Worker

```bash
docker compose up api worker
```

## Development Setup

For local development, you might only need to run Redis, while working on the API locally. This is useful when:

- You're making changes to the API code and want to test them directly
- You want to avoid rebuilding the API container on every change
- You're running the API service directly on your machine

To run just Redis for development:

```bash
docker compose up redis
```

Then you can run your API service locally with the following commands:

```sh
# On one terminal
cd backend
uv run api.py

# On another terminal
cd backend
uv run dramatiq --processes 4 --threads 4 run_agent_background
```

### Environment Configuration

The setup wizard automatically creates a `.env` file with all necessary configuration. If you need to configure manually or understand the setup:

#### Required Environment Variables

```sh
# Environment Mode
ENV_MODE=local

# Database (Supabase)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Infrastructure
REDIS_HOST=redis  # Use 'localhost' when running API locally
REDIS_PORT=6379
# LLM Providers (at least one required)
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
OPENROUTER_API_KEY=your-openrouter-key
GEMINI_API_KEY=your-gemini-api-key
MODEL_TO_USE=openrouter/moonshotai/kimi-k2

# Search and Web Scraping
TAVILY_API_KEY=your-tavily-key
FIRECRAWL_API_KEY=your-firecrawl-key
FIRECRAWL_URL=https://api.firecrawl.dev

# Agent Execution
DAYTONA_API_KEY=your-daytona-key
DAYTONA_SERVER_URL=https://app.daytona.io/api
DAYTONA_TARGET=us

WEBHOOK_BASE_URL=https://yourdomain.com

# MCP Configuration
MCP_CREDENTIAL_ENCRYPTION_KEY=your-generated-encryption-key

# Optional APIs
RAPID_API_KEY=your-rapidapi-key

NEXT_PUBLIC_URL=http://localhost:3000
```

When running services individually, make sure to:

1. Check your `.env` file and adjust any necessary environment variables
2. Ensure Redis connection settings match your local setup (default: `localhost:6379`)
3. Update any service-specific environment variables if needed

### Important: Redis Host Configuration

When running the API locally with Redis in Docker, you need to set the correct Redis host in your `.env` file:

- For Docker-to-Docker communication (when running both services in Docker): use `REDIS_HOST=redis`
- For local-to-Docker communication (when running API locally): use `REDIS_HOST=localhost`

Example `.env` configuration for local development:

```sh
REDIS_HOST=localhost # (instead of 'redis')
REDIS_PORT=6379
REDIS_PASSWORD=
```

---

---

## Production Setup

For production deployments, use the following command to set resource limits

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
