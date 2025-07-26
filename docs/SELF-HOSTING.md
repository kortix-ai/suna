# Suna Self-Hosting Guide

This guide provides detailed instructions for setting up and hosting your own instance of Suna, an open-source generalist AI agent.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Installation Steps](#installation-steps)
- [Manual Configuration](#manual-configuration)
- [Post-Installation Steps](#post-installation-steps)
- [Troubleshooting](#troubleshooting)

## Overview

Suna consists of four main components:

1. **Backend API** - Python/FastAPI service for REST endpoints, thread management, and LLM integration
2. **Backend Worker** - Python/Dramatiq worker service for handling agent tasks
3. **Frontend** - Next.js/React application providing the user interface
4. **Agent Docker** - Isolated execution environment for each agent
5. **Supabase Database** - Handles data persistence and authentication

## Prerequisites

Before starting the installation process, you'll need to set up the following:

### 1. Supabase Project

1. Create an account at [Supabase](https://supabase.com/)
2. Create a new project
3. Note down the following information (found in Project Settings → API):
   - Project URL (e.g., `https://abcdefg.supabase.co`)
   - API keys (anon key and service role key)

### 2. API Keys

Obtain the following API keys:

#### Required

- **LLM Provider** (at least one of the following):

  - [Anthropic](https://console.anthropic.com/) - Recommended for best performance
  - [OpenAI](https://platform.openai.com/)
  - [Groq](https://console.groq.com/)
  - [OpenRouter](https://openrouter.ai/)
  - [AWS Bedrock](https://aws.amazon.com/bedrock/)

- **AI-Powered Code Editing (Optional but Recommended)**:
  - [Morph](https://morphllm.com/api-keys) - For intelligent code editing capabilities

- **Search and Web Scraping**:

  - [Tavily](https://tavily.com/) - For enhanced search capabilities
  - [Firecrawl](https://firecrawl.dev/) - For web scraping capabilities

- **Agent Execution**:
  - [Daytona](https://app.daytona.io/) - For secure agent execution

- **Background Job Processing**:
  - [QStash](https://console.upstash.com/qstash) - For workflows, automated tasks, and webhook handling

#### Optional

- **RapidAPI** - For accessing additional API services (enables LinkedIn scraping and other tools)
- **Smithery** - For custom agents and workflows ([Get API key](https://smithery.ai/))

### 3. Required Software

Ensure the following tools are installed on your system:

- **[Docker](https://docs.docker.com/get-docker/)**
- **[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)**
- **[Git](https://git-scm.com/downloads)**
- **[Python 3.11](https://www.python.org/downloads/)**

For manual setup, you'll also need:

- **[uv](https://docs.astral.sh/uv/)**
- **[Node.js & npm](https://nodejs.org/en/download/)**

## Installation Steps

### 1. Clone the Repository

```bash
git clone https://github.com/kortix-ai/suna.git
cd suna
```

### 2. Run the Setup Wizard

The setup wizard will guide you through the installation process:

```bash
python setup.py
```

The wizard will:

- Check if all required tools are installed
- Collect your API keys and configuration information
- Set up the Supabase database
- Configure environment files
- Install dependencies
- Start Suna using your preferred method

The setup wizard has 14 steps and includes progress saving, so you can resume if interrupted.

### 3. Supabase Configuration

During setup, you'll need to:

1. Log in to the Supabase CLI
2. Link your local project to your Supabase project
3. Push database migrations
4. Manually expose the 'basejump' schema in Supabase:
   - Go to your Supabase project
   - Navigate to Project Settings → API
   - Add 'basejump' to the Exposed Schema section

### 4. Daytona Configuration

As part of the setup, you'll need to:

1. Create a Daytona account
2. Generate an API key
3. Create a Snapshot:
   - Name: `kortix/suna:0.1.3`
   - Image name: `kortix/suna:0.1.3`
   - Entrypoint: `/usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf`

### 5. QStash Configuration

QStash is required for background job processing, workflows, and webhook handling:

1. Create an account at [Upstash Console](https://console.upstash.com/qstash)
2. Get your QStash token and signing keys
3. Configure a publicly accessible webhook base URL for workflow callbacks

## Manual Configuration

If you prefer to configure your installation manually, or if you need to modify the configuration after installation, here's what you need to know:

### Backend Configuration (.env)

The backend configuration is stored in `backend/.env`

Example configuration:

```sh
# Environment Mode
ENV_MODE=local

# DATABASE
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# REDIS
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_SSL=false

# RABBITMQ
RABBITMQ_HOST=rabbitmq
RABBITMQ_PORT=5672

# LLM Providers
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
OPENROUTER_API_KEY=your-openrouter-key
GEMINI_API_KEY=your-gemini-api-key
MORPH_API_KEY=
MODEL_TO_USE=anthropic/claude-sonnet-4-20250514

# WEB SEARCH
TAVILY_API_KEY=your-tavily-key

# WEB SCRAPE
FIRECRAWL_API_KEY=your-firecrawl-key
FIRECRAWL_URL=https://api.firecrawl.dev

# Sandbox container provider
DAYTONA_API_KEY=your-daytona-key
DAYTONA_SERVER_URL=https://app.daytona.io/api
DAYTONA_TARGET=us

# Background job processing (Required)
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

### Frontend Configuration (.env.local)

The frontend configuration is stored in `frontend/.env.local` and includes:

- Supabase connection details
- Backend API URL

Example configuration:

```sh
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000/api
NEXT_PUBLIC_URL=http://localhost:3000
NEXT_PUBLIC_ENV_MODE=LOCAL
```

## Post-Installation Steps

After completing the installation, you'll need to:

1. **Create an account** - Use Supabase authentication to create your first account
2. **Verify installations** - Check that all components are running correctly

## Startup Options

Suna can be started in two ways:

### 1. Using Docker Compose (Recommended)

This method starts all required services in Docker containers:

```bash
docker compose up -d # Use `docker compose down` to stop it later
# or
python start.py # Use the same to stop it later
```

### 2. Manual Startup

This method requires you to start each component separately:

1. Start Redis and RabbitMQ (required for backend):

```bash
docker compose up redis rabbitmq -d
# or
python start.py # Use the same to stop it later
```

2. Start the frontend (in one terminal):

```bash
cd frontend
npm run dev
```

3. Start the backend (in another terminal):

```bash
cd backend
uv run api.py
```

4. Start the worker (in one more terminal):

```bash
cd backend
uv run dramatiq run_agent_background
```

## Troubleshooting

### Common Issues

1. **Docker services not starting**

   - Check Docker logs: `docker compose logs`
   - Ensure Docker is running correctly
   - Verify port availability (3000 for frontend, 8000 for backend)

2. **Database connection issues**

   - Verify Supabase configuration
   - Check if 'basejump' schema is exposed in Supabase

3. **LLM API key issues**

   - Verify API keys are correctly entered
   - Check for API usage limits or restrictions

4. **Daytona connection issues**

   - Verify Daytona API key
   - Check if the container image is correctly configured

5. **QStash/Webhook issues**

   - Verify QStash token and signing keys
   - Ensure webhook base URL is publicly accessible
   - Check QStash console for delivery status

6. **Setup wizard issues**

   - Delete `.setup_progress` file to reset the setup wizard
   - Check that all required tools are installed and accessible

### Logs

To view logs and diagnose issues:

```bash
# Docker Compose logs
docker compose logs -f

# Frontend logs (manual setup)
cd frontend
npm run dev -- --turbopack

# Backend logs (manual setup)
cd backend
uv run api.py

# Worker logs (manual setup)
cd backend
uv run dramatiq run_agent_background
```

### Resuming Setup

If the setup wizard is interrupted, you can resume from where you left off by running:

```bash
python setup.py
```

The wizard will detect your progress and continue from the last completed step.

---

For further assistance, join the [Suna Discord Community](https://discord.gg/Py6pCBUUPw) or check the [GitHub repository](https://github.com/kortix-ai/suna) for updates and issues.
