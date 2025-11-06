# Railway.com Deployment Guide for Kortix/Suna

This guide walks you through deploying the Kortix platform on Railway.com with a two-pronged architecture (Frontend + Backend/Worker).

## Architecture Overview

```
┌─────────────────┐
│   Frontend      │ ← Next.js (Port 3000)
│   (railway.    │
│   frontend.     │
│   Dockerfile)   │
└────────┬────────┘
         │
         │ API Calls
         ▼
┌─────────────────┐      ┌─────────────────┐
│   Backend API   │◄────►│  Redis Service  │
│   (railway.     │      │  (Railway       │
│   backend.      │      │   Plugin)       │
│   Dockerfile)   │      └─────────────────┘
└────────┬────────┘
         │
         │ Shared Queue
         ▼
┌─────────────────┐
│   Worker        │
│   (railway.     │
│   worker.       │
│   Dockerfile)   │
└─────────────────┘
```

## Prerequisites

1. **Railway Account**: Sign up at [railway.app](https://railway.app)
2. **GitHub Repository**: Connect your Kortix repository to Railway
3. **Supabase Project**: Set up a Supabase project (cloud or self-hosted)
4. **API Keys**: Prepare the following:
   - Supabase credentials
   - At least one LLM provider API key (Anthropic, OpenAI, etc.)
   - Tavily or RapidAPI key (for search)
   - Firecrawl API key (for web scraping)

## Step 1: Create Railway Project

### Option A: Using Railway Dashboard

1. Go to [railway.app/new](https://railway.app/new)
2. Select "Deploy from GitHub repo"
3. Authorize Railway to access your GitHub repository
4. Select the `kortix-ai/suna` repository

### Option B: Using Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Initialize project
railway init

# Link to existing project (if already created)
railway link
```

## Step 2: Add Redis Service

1. In your Railway project dashboard, click "New"
2. Select "Database" → "Add Redis"
3. Railway will automatically provision a Redis instance
4. Note the connection details (automatically injected as env vars):
   - `REDIS_HOST`
   - `REDIS_PORT`
   - `REDIS_PASSWORD`
   - `REDIS_URL`

## Step 3: Deploy Backend API Service

### Create Backend Service

1. In Railway dashboard, click "New" → "Service"
2. Select "GitHub Repo" (your repository)
3. Name it: `backend-api`
4. Configure build settings:
   - **Root Directory**: Leave empty (repo root)
   - **Dockerfile Path**: `railway.backend.Dockerfile`
   - **Port**: `8000`

### Set Backend Environment Variables

Go to the `backend-api` service → Variables tab and add:

#### Required Variables

```bash
# Environment
ENV_MODE=production

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

# Redis Configuration (use Railway's provided values)
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}
REDIS_PASSWORD=${{Redis.REDIS_PASSWORD}}
REDIS_SSL=true

# LLM Provider API Keys (at least one required)
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
GROQ_API_KEY=your-groq-key

# Search API (at least one required)
TAVILY_API_KEY=your-tavily-key
# OR
RAPID_API_KEY=your-rapid-api-key

# Web Scraping
FIRECRAWL_API_KEY=your-firecrawl-key

# Worker Configuration (optional, defaults are set)
MIN_WORKERS=2
MAX_WORKERS=4
THREADS=2
WORKER_CONNECTIONS=1000
```

#### Optional Variables

```bash
# Sandbox Execution
DAYTONA_API_KEY=your-daytona-key
DAYTONA_SERVER_URL=https://your-daytona-server.com

# E2B Code Interpreter
E2B_API_KEY=your-e2b-key

# Observability
LANGFUSE_PUBLIC_KEY=your-langfuse-public-key
LANGFUSE_SECRET_KEY=your-langfuse-secret-key
LANGFUSE_HOST=https://cloud.langfuse.com

# Sentry
SENTRY_DSN=your-sentry-dsn

# Stripe Billing
STRIPE_SECRET_KEY=your-stripe-secret-key
STRIPE_WEBHOOK_SECRET=your-stripe-webhook-secret

# Additional LLM Providers
GEMINI_API_KEY=your-gemini-key
XAI_API_KEY=your-xai-key
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
AWS_REGION_NAME=us-west-2

# OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Composio Integration
COMPOSIO_API_KEY=your-composio-key
```

### Configure Railway Reference Variables

Railway allows services to reference each other's variables using `${{ServiceName.VARIABLE}}` syntax:

```bash
# Backend API references Redis
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}
REDIS_PASSWORD=${{Redis.REDIS_PASSWORD}}
```

## Step 4: Deploy Worker Service

### Create Worker Service

1. In Railway dashboard, click "New" → "Service"
2. Select "GitHub Repo" (your repository)
3. Name it: `worker`
4. Configure build settings:
   - **Root Directory**: Leave empty (repo root)
   - **Dockerfile Path**: `railway.worker.Dockerfile`
   - **Port**: Not required (no external port)

### Set Worker Environment Variables

Copy all environment variables from the Backend API service, plus:

```bash
# Worker-specific configuration
MIN_PROCESSES=2
MAX_PROCESSES=4
THREADS_PER_PROCESS=4
```

You can use the same reference variables:

```bash
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}
REDIS_PASSWORD=${{Redis.REDIS_PASSWORD}}
REDIS_SSL=true
```

## Step 5: Deploy Frontend Service

### Create Frontend Service

1. In Railway dashboard, click "New" → "Service"
2. Select "GitHub Repo" (your repository)
3. Name it: `frontend`
4. Configure build settings:
   - **Root Directory**: Leave empty (repo root)
   - **Dockerfile Path**: `railway.frontend.Dockerfile`
   - **Port**: `3000`

### Set Frontend Environment Variables

```bash
# Environment
NEXT_PUBLIC_ENV_MODE=production
NODE_ENV=production
PORT=3000

# Supabase Configuration (client-side)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here

# Backend API URL (use Railway's generated domain)
NEXT_PUBLIC_BACKEND_URL=https://${{backend-api.RAILWAY_PUBLIC_DOMAIN}}/api

# Frontend URL (use Railway's generated domain)
NEXT_PUBLIC_URL=https://${{frontend.RAILWAY_PUBLIC_DOMAIN}}

# Analytics (optional)
NEXT_PUBLIC_POSTHOG_KEY=your-posthog-key

# Admin API Key (optional)
KORTIX_ADMIN_API_KEY=your-admin-key
```

### Generate Public Domains

1. Go to each service (backend-api, frontend)
2. Click "Settings" → "Networking"
3. Click "Generate Domain" to get a public URL
4. Update the environment variables with these domains

## Step 6: Configure Build Order

To ensure services start in the correct order:

1. **Redis** → No dependencies
2. **Backend API** → Depends on Redis
3. **Worker** → Depends on Redis and Backend API
4. **Frontend** → Depends on Backend API

Railway automatically handles this through service references (`${{service.VAR}}`).

## Step 7: Deploy and Monitor

### Trigger Deployment

Railway automatically deploys when you:
- Push to your connected GitHub branch
- Update environment variables
- Manually click "Deploy" in the dashboard

### Monitor Deployment

1. Go to each service in Railway dashboard
2. Click "Deployments" to see build logs
3. Check "Metrics" for CPU/Memory usage
4. View "Logs" for runtime logs

### Health Checks

All services include health checks:
- **Backend API**: `GET /api/health` (every 30s)
- **Frontend**: `GET /api/health` (every 30s)
- **Worker**: Process check (every 60s)

Railway will automatically restart unhealthy services.

## Step 8: Optimize for Cost

### Resource Allocation Recommendations

Based on Railway pricing tiers:

#### Starter Plan ($5/month - 512MB RAM, 1 vCPU)
```
Frontend: 512MB RAM, 1 vCPU
Backend:  Not recommended (too small)
```

#### Developer Plan ($20/month - 8GB RAM, 8 vCPU)
```
Frontend:     1GB RAM, 1 vCPU
Backend API:  2GB RAM, 2 vCPUs
Worker:       1GB RAM, 2 vCPUs
Redis:        512MB RAM
Total:        4.5GB RAM, 5 vCPUs
```

#### Team Plan ($100/month - 32GB RAM, 32 vCPU)
```
Frontend:     2GB RAM, 2 vCPUs
Backend API:  8GB RAM, 8 vCPUs
Worker:       4GB RAM, 4 vCPUs
Redis:        2GB RAM
Total:        16GB RAM, 14 vCPUs
```

### Adjust Worker Counts

Modify environment variables to control resource usage:

```bash
# Backend API (lower settings for smaller instances)
MIN_WORKERS=1
MAX_WORKERS=2
THREADS=2
WORKER_CONNECTIONS=500

# Worker (lower settings for smaller instances)
MIN_PROCESSES=1
MAX_PROCESSES=2
THREADS_PER_PROCESS=2
```

## Step 9: Set Up Custom Domain (Optional)

1. Go to Frontend service → Settings → Networking
2. Click "Custom Domain"
3. Add your domain (e.g., `app.yourdomain.com`)
4. Update DNS records as instructed by Railway
5. Update `NEXT_PUBLIC_URL` environment variable

## Step 10: Set Up CI/CD (Optional)

### Automatic Deployments

Railway automatically deploys on git push when connected to GitHub.

### Branch Deployments

1. Go to Project Settings → Environments
2. Create new environment (e.g., "staging", "production")
3. Connect different branches to each environment
4. Each environment gets separate services and domains

## Troubleshooting

### Build Fails with "Out of Memory"

**Solution**: Reduce concurrent build processes or upgrade Railway plan.

Add to backend/worker Dockerfiles:
```dockerfile
ENV UV_CONCURRENT_DOWNLOADS=1
```

### Frontend Build Fails

**Solution**: Ensure all `NEXT_PUBLIC_*` variables are set as build arguments.

Check Railway logs for missing environment variables during build.

### Worker Not Processing Tasks

**Solution**: Verify Redis connection.

```bash
# Check worker logs for Redis connection errors
# Ensure REDIS_SSL=true for Railway's Redis
```

### Backend API High Memory Usage

**Solution**: Reduce worker count.

```bash
MAX_WORKERS=2  # Instead of 4 or 7
THREADS=1      # Instead of 2
```

### Services Can't Communicate

**Solution**: Use Railway's private networking.

Services within the same project can communicate using private URLs:
```bash
BACKEND_URL=${{backend-api.RAILWAY_PRIVATE_DOMAIN}}
```

## Local Testing with Railway Environment

### Test Railway Dockerfiles Locally

```bash
# Build and test backend
docker build -f railway.backend.Dockerfile -t kortix-backend:railway ./

# Build and test frontend
docker build -f railway.frontend.Dockerfile -t kortix-frontend:railway ./

# Build and test worker
docker build -f railway.worker.Dockerfile -t kortix-worker:railway ./
```

### Test with Docker Compose

See `railway.docker-compose.yml` for local testing setup that mimics Railway environment.

```bash
docker compose -f railway.docker-compose.yml up
```

## Monitoring and Scaling

### Enable Metrics

Railway provides built-in metrics:
- CPU usage
- Memory usage
- Network traffic
- Request count

### Auto-scaling (Team Plan)

1. Go to Service → Settings → Autoscaling
2. Configure:
   - Min replicas: 1
   - Max replicas: 3
   - Target CPU: 70%
   - Target Memory: 80%

### Horizontal Scaling

For high traffic:
1. Increase max replicas for Backend API
2. Add more Worker instances
3. Use Railway's Redis with higher memory

## Cost Estimation

### Monthly Costs (Developer Plan Example)

```
Railway Developer Plan:       $20/month base
Redis (512MB):                Included
Backend API (2GB, 2 vCPU):    ~$10/month
Worker (1GB, 2 vCPU):         ~$5/month
Frontend (1GB, 1 vCPU):       ~$5/month
────────────────────────────────────────
Total:                        ~$40/month
```

### Cost Optimization Tips

1. **Use Railway's free trial** ($5 credit, no card required)
2. **Combine Worker and Backend** if traffic is low
3. **Use Supabase free tier** for database
4. **Start with Developer plan**, scale to Team as needed
5. **Monitor unused services** and remove them

## Security Best Practices

### Environment Variables

1. Never commit `.env` files
2. Use Railway's encrypted variable storage
3. Rotate API keys regularly
4. Use separate keys for staging/production

### Network Security

1. Use Railway's private networking for service-to-service communication
2. Enable Railway's DDoS protection
3. Use Supabase Row Level Security (RLS)
4. Implement rate limiting in FastAPI

### Access Control

1. Use Railway Teams for collaboration
2. Set up role-based access
3. Enable 2FA on Railway account
4. Use separate Railway projects for staging/production

## Additional Resources

- [Railway Documentation](https://docs.railway.app)
- [Railway Templates](https://railway.app/templates)
- [Railway Discord Community](https://discord.gg/railway)
- [Kortix Documentation](https://github.com/kortix-ai/suna)

## Support

If you encounter issues:
1. Check Railway service logs
2. Review this deployment guide
3. Search Railway Discord community
4. Open an issue on [Kortix GitHub](https://github.com/kortix-ai/suna/issues)

---

**Last Updated**: 2025-11-06
**Tested on Railway**: Developer Plan (8GB RAM, 8 vCPU)
**Status**: ✅ Production Ready
