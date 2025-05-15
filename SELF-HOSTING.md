# Suna Self-Hosting Guide

This guide provides detailed instructions for setting up and hosting your own instance of Suna, an open-source generalist AI agent.

## Table of Contents

- [Overview](#overview)
- [System Requirements](#system-requirements)
- [Prerequisites](#prerequisites)
- [Installation Steps](#installation-steps)
- [Manual Configuration](#manual-configuration)
- [Post-Installation Steps](#post-installation-steps)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)

## Overview

Suna consists of four main components:

1. **Backend API** - Python/FastAPI service for REST endpoints, thread management, and LLM integration
2. **Frontend** - Next.js/React application providing the user interface
3. **Agent Docker** - Isolated execution environment for each agent
4. **Supabase Database** - Handles data persistence and authentication

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

- **Search and Web Scraping**:
  - [Tavily](https://tavily.com/) - For enhanced search capabilities
  - [Firecrawl](https://firecrawl.dev/) - For web scraping capabilities

- **Agent Execution**:
  - [Daytona](https://app.daytona.io/) - For secure agent execution

#### Optional

- **RapidAPI** - For accessing additional API services (optional)

### 3. Required Software

Ensure the following tools are installed on your system:

- **Git**
- **Docker**
- **Python 3.11**
- **Poetry**
- **Node.js & npm**
- **Supabase CLI**

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
3. Create a Docker image:
   - Image name: `kortix/suna:0.1.2`
   - Entrypoint: `/usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf`

## Manual Configuration

If you prefer to configure your installation manually, or if you need to modify the configuration after installation, here's what you need to know:

### Backend Configuration (.env)

```
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

# LLM Providers
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
MODEL_TO_USE=anthropic/claude-3-7-sonnet-latest

# WEB SEARCH
TAVILY_API_KEY=your-tavily-key

# WEB SCRAPE
FIRECRAWL_API_KEY=your-firecrawl-key
FIRECRAWL_URL=https://api.firecrawl.dev

# Sandbox container provider
DAYTONA_API_KEY=your-daytona-key
DAYTONA_SERVER_URL=https://app.daytona.io/api
DAYTONA_TARGET=us

NEXT_PUBLIC_URL=http://localhost:3000
```

### Frontend Configuration (.env.local)

The frontend configuration is stored in `frontend/.env.local` and includes:

- Supabase connection details
- Backend API URL

Example configuration:
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_BACKEND_URL=http://backend:8000/api
NEXT_PUBLIC_URL=http://localhost:3000
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
# Using pre-built images (faster)
docker compose -f docker-compose.ghcr.yaml up -d

# OR building images locally (customizable)
docker compose up -d
```

### 2. Manual Startup

This method requires you to start each component separately:

1. Start Redis (required for backend):
```bash
cd backend
docker compose up redis -d
```

2. Start the frontend (in one terminal):
```bash
cd frontend
npm run dev
```

3. Start the backend (in another terminal):
```bash
cd backend
poetry run python3.11 api.py
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

### Logs

To view logs and diagnose issues:

```bash
# Docker Compose logs
docker compose logs -f

# Frontend logs (manual setup)
cd frontend
npm run dev

# Backend logs (manual setup)
cd backend
poetry run python3.11 api.py
```

---

For further assistance, join the [Suna Discord Community](https://discord.gg/Py6pCBUUPw) or check the [GitHub repository](https://github.com/kortix-ai/suna) for updates and issues. 
