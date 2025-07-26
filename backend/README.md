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

### Running only Redis and RabbitMQ

```bash
docker compose up redis rabbitmq
```

### Running only the API and Worker

```bash
docker compose up api worker
```

## Development Setup

For local development, you might only need to run Redis and RabbitMQ, while working on the API locally. This is useful when:

- You're making changes to the API code and want to test them directly
- You want to avoid rebuilding the API container on every change
- You're running the API service directly on your machine

To run just Redis and RabbitMQ for development:

```bash
docker compose up redis rabbitmq
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
RABBITMQ_HOST=rabbitmq  # Use 'localhost' when running API locally
RABBITMQ_PORT=5672

# LLM Providers (at least one required)
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
OPENROUTER_API_KEY=your-openrouter-key
GEMINI_API_KEY=your-gemini-api-key
MODEL_TO_USE=anthropic/claude-sonnet-4-20250514

# Search and Web Scraping
TAVILY_API_KEY=your-tavily-key
FIRECRAWL_API_KEY=your-firecrawl-key
FIRECRAWL_URL=https://api.firecrawl.dev

# Agent Execution
DAYTONA_API_KEY=your-daytona-key
DAYTONA_SERVER_URL=https://app.daytona.io/api
DAYTONA_TARGET=us

# Background Job Processing (Required)
QSTASH_URL=https://qstash.upstash.io
QSTASH_TOKEN=your-qstash-token
QSTASH_CURRENT_SIGNING_KEY=your-current-signing-key
QSTASH_NEXT_SIGNING_KEY=your-next-signing-key
WEBHOOK_BASE_URL=https://yourdomain.com

# MCP Configuration
MCP_CREDENTIAL_ENCRYPTION_KEY=your-generated-encryption-key

# Optional APIs
RAPID_API_KEY=your-rapidapi-key
SMITHERY_API_KEY=your-smithery-key

NEXT_PUBLIC_URL=http://localhost:3000
```

When running services individually, make sure to:

1. Check your `.env` file and adjust any necessary environment variables
2. Ensure Redis connection settings match your local setup (default: `localhost:6379`)
3. Ensure RabbitMQ connection settings match your local setup (default: `localhost:5672`)
4. Update any service-specific environment variables if needed

### Important: Redis Host Configuration

When running the API locally with Redis in Docker, you need to set the correct Redis host in your `.env` file:

- For Docker-to-Docker communication (when running both services in Docker): use `REDIS_HOST=redis`
- For local-to-Docker communication (when running API locally): use `REDIS_HOST=localhost`

### Important: RabbitMQ Host Configuration

When running the API locally with RabbitMQ in Docker, you need to set the correct RabbitMQ host in your `.env` file:

- For Docker-to-Docker communication (when running both services in Docker): use `RABBITMQ_HOST=rabbitmq`
- For local-to-Docker communication (when running API locally): use `RABBITMQ_HOST=localhost`

Example `.env` configuration for local development:

```sh
REDIS_HOST=localhost # (instead of 'redis')
REDIS_PORT=6379
REDIS_PASSWORD=

RABBITMQ_HOST=localhost # (instead of 'rabbitmq')
RABBITMQ_PORT=5672
```

---

## Feature Flags

The backend includes a Redis-backed feature flag system that allows you to control feature availability without code deployments.

### Setup

The feature flag system uses the existing Redis service and is automatically available when Redis is running.

### CLI Management

Use the CLI tool to manage feature flags:

```bash
cd backend/flags
python setup.py <command> [arguments]
```

#### Available Commands

**Enable a feature flag:**

```bash
python setup.py enable test_flag "Test decsription"
```

**Disable a feature flag:**

```bash
python setup.py disable test_flag
```

**List all feature flags:**

```bash
python setup.py list
```

### API Endpoints

Feature flags are accessible via REST API:

**Get all feature flags:**

```bash
GET /feature-flags
```

**Get specific feature flag:**

```bash
GET /feature-flags/{flag_name}
```

Example response:

```json
{
  "test_flag": {
    "enabled": true,
    "description": "Test flag",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

### Backend Integration

Use feature flags in your Python code:

```python
from flags.flags import is_enabled

# Check if a feature is enabled
if await is_enabled('test_flag'):
    # Feature-specific logic
    pass

# With fallback value
enabled = await is_enabled('new_feature', default=False)
```

### Current Feature Flags

The system currently supports these feature flags:

- **`custom_agents`**: Controls custom agent creation and management
- **`agent_marketplace`**: Controls agent marketplace functionality

### Error Handling

The feature flag system includes robust error handling:

- If Redis is unavailable, flags default to `False`
- API endpoints return empty objects on Redis errors
- CLI operations show clear error messages

### Caching

- Backend operations are direct Redis calls (no caching)
- Frontend includes 5-minute caching for performance
- Use `clearCache()` in frontend to force refresh

---

## Production Setup

For production deployments, use the following command to set resource limits

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
