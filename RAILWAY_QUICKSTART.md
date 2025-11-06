# Railway Deployment Quick Start

Get Kortix/Suna running on Railway.com in under 15 minutes.

## Prerequisites

- Railway account ([sign up free](https://railway.app))
- GitHub repository access
- Supabase project ([sign up free](https://supabase.com))
- At least one LLM API key (Anthropic, OpenAI, etc.)

## 5-Minute Deployment

### 1. Fork or Clone Repository

```bash
git clone https://github.com/kortix-ai/suna.git
cd suna
```

### 2. Create Railway Project

**Option A: Using Railway Dashboard**

1. Visit [railway.app/new](https://railway.app/new)
2. Select "Deploy from GitHub repo"
3. Choose your repository
4. Click "Deploy Now"

**Option B: Using Railway CLI**

```bash
npm install -g @railway/cli
railway login
railway init
```

### 3. Add Redis Database

1. In Railway dashboard → "New" → "Database" → "Add Redis"
2. Wait for provisioning (takes ~30 seconds)

### 4. Deploy Backend API

1. Railway dashboard → "New" → "Service"
2. Select your GitHub repo
3. Configure:
   - **Name**: `backend-api`
   - **Dockerfile**: `railway.backend.Dockerfile`
   - **Port**: `8000`

4. Add environment variables (Variables tab):

```bash
# Required - Copy these from your Supabase dashboard
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbG...
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...

# Required - Add at least one LLM API key
ANTHROPIC_API_KEY=sk-ant-...

# Required - Add search API key
TAVILY_API_KEY=tvly-...

# Required - Add web scraping key
FIRECRAWL_API_KEY=fc-...

# Redis - Use Railway references (copy exactly)
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}
REDIS_PASSWORD=${{Redis.REDIS_PASSWORD}}
REDIS_SSL=true

# Environment
ENV_MODE=production
```

5. Click "Deploy"

### 5. Deploy Worker Service

1. Railway dashboard → "New" → "Service"
2. Select your GitHub repo
3. Configure:
   - **Name**: `worker`
   - **Dockerfile**: `railway.worker.Dockerfile`

4. Copy all environment variables from Backend API service
   - Or use "Copy from Service" feature in Railway

5. Click "Deploy"

### 6. Deploy Frontend

1. Railway dashboard → "New" → "Service"
2. Select your GitHub repo
3. Configure:
   - **Name**: `frontend`
   - **Dockerfile**: `railway.frontend.Dockerfile`
   - **Port**: `3000`

4. Add environment variables:

```bash
# Frontend config
NEXT_PUBLIC_ENV_MODE=production
NODE_ENV=production
PORT=3000

# Supabase (same as backend)
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...

# Backend URL - Railway will generate domain after first deploy
# Temporarily use: http://localhost:8000/api
# Update after backend deploys successfully
NEXT_PUBLIC_BACKEND_URL=https://${{backend-api.RAILWAY_PUBLIC_DOMAIN}}/api

# Frontend URL - Update after Railway generates domain
NEXT_PUBLIC_URL=https://${{frontend.RAILWAY_PUBLIC_DOMAIN}}
```

5. Click "Deploy"

### 7. Generate Public Domains

After all services deploy successfully:

1. Go to `backend-api` → Settings → Networking → "Generate Domain"
2. Go to `frontend` → Settings → Networking → "Generate Domain"
3. Copy the generated domains
4. Update `NEXT_PUBLIC_BACKEND_URL` in frontend service
5. Redeploy frontend

### 8. Verify Deployment

1. Open frontend URL: `https://your-app.railway.app`
2. Check backend health: `https://backend-api.railway.app/api/health`
3. Monitor logs in Railway dashboard

## Cost Estimate

**Developer Plan ($20/month)**
- Frontend: 1GB RAM, 1 vCPU (~$5/month)
- Backend: 2GB RAM, 2 vCPUs (~$10/month)
- Worker: 1GB RAM, 2 vCPUs (~$5/month)
- Redis: Included
- **Total: ~$40/month**

## Troubleshooting

### Build Fails

**Problem**: Out of memory during build
**Solution**:
```bash
# Add to Railway environment variables
UV_CONCURRENT_DOWNLOADS=1
```

### Services Can't Connect

**Problem**: Backend can't reach Redis
**Solution**: Verify Redis reference variables:
```bash
REDIS_HOST=${{Redis.REDIS_HOST}}  # Exact syntax required
```

### Frontend Shows "Cannot connect to backend"

**Problem**: CORS or incorrect backend URL
**Solution**:
1. Verify `NEXT_PUBLIC_BACKEND_URL` includes `/api` suffix
2. Ensure backend domain is correct
3. Check backend logs for CORS errors

## Local Testing

Test Railway Dockerfiles before deploying:

```bash
# Copy environment template
cp .env.railway.example .env.railway

# Edit .env.railway with your credentials
nano .env.railway

# Start all services
docker compose -f railway.docker-compose.yml --env-file .env.railway up

# Access locally
# Frontend: http://localhost:3000
# Backend: http://localhost:8000
```

## Next Steps

✅ Deployment complete! Now you can:

1. **Set up custom domain** (Railway Settings → Networking)
2. **Enable auto-scaling** (Team plan feature)
3. **Add monitoring** (Langfuse, Sentry)
4. **Configure CI/CD** (automatic deploys on git push)

## Full Documentation

For complete configuration options, see:
- [RAILWAY_DEPLOYMENT.md](./RAILWAY_DEPLOYMENT.md) - Full deployment guide
- [Railway Docs](https://docs.railway.app)

## Support

- **Railway Issues**: [Railway Discord](https://discord.gg/railway)
- **Kortix Issues**: [GitHub Issues](https://github.com/kortix-ai/suna/issues)

---

**Deployment Status**: ✅ Production Ready
**Last Updated**: 2025-11-06
**Estimated Setup Time**: 10-15 minutes
