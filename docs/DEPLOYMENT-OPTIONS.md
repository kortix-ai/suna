# Kortix Deployment Options - Complete Guide

This document provides a comprehensive comparison of all deployment options for the Kortix AI agent platform.

## 📋 Quick Comparison Table

| Option | Cost/Month | Difficulty | Scalability | Best For |
|--------|-----------|------------|-------------|----------|
| **AWS ECS** | $260-400 | Medium | Excellent | Production, Enterprise |
| **Render** | $100-200 | Easy | Good | Startups, Fast deployment |
| **Railway** | $100-180 | Easy | Good | Solo devs, Small teams |
| **DigitalOcean** | $150-250 | Medium | Good | Mid-size teams, Cost-conscious |
| **Fly.io** | $80-150 | Medium | Excellent | Global distribution, Hobby |
| **Google Cloud Run** | $150-300 | Medium | Excellent | Serverless fans, Burst traffic |
| **Azure Container Apps** | $200-350 | Medium | Excellent | Enterprise, Microsoft shops |
| **Self-Hosted VPS** | $40-120 | Hard | Limited | Full control, Learning |
| **Kubernetes** | $200-500 | Hard | Excellent | Large scale, DevOps teams |

---

## Option 2: Render ⚡ (Easiest Production Deploy)

### Why Render:
- ✅ Zero-config deployments from Git
- ✅ Automatic SSL certificates
- ✅ Built-in Redis (managed)
- ✅ Native Docker support
- ✅ Auto-scaling included
- ✅ Free PostgreSQL available (or use Supabase)
- ⚠️ More expensive at scale
- ⚠️ US/EU regions only

### Cost: ~$100-200/month

| Service | Plan | Cost |
|---------|------|------|
| Backend Web Service | Standard (2 CPU, 4GB) | $85/mo |
| Worker Background Service | Standard (2 CPU, 4GB) | $85/mo |
| Redis | 1GB | $10/mo |
| Static Site (Frontend) | Free | $0 |
| **Total** | | **~$180/mo** |

### Deployment Steps:

1. **Connect GitHub Repository**
   - Go to https://dashboard.render.com
   - Click "New +" → "Blueprint"
   - Connect your GitHub repo

2. **Create `render.yaml` in project root:**

```yaml
services:
  # Backend API
  - type: web
    name: kortix-backend
    env: docker
    dockerfilePath: ./backend/Dockerfile
    dockerContext: ./backend
    plan: standard
    region: oregon
    healthCheckPath: /api/health
    autoDeploy: true
    envVars:
      - key: ENV_MODE
        value: production
      - key: REDIS_HOST
        fromService:
          name: kortix-redis
          type: redis
          property: host
      - key: REDIS_PORT
        fromService:
          name: kortix-redis
          type: redis
          property: port
      - key: REDIS_SSL
        value: true
      - key: SUPABASE_URL
        sync: false  # Add in dashboard
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: TAVILY_API_KEY
        sync: false
      - key: FIRECRAWL_API_KEY
        sync: false
      - key: RAPID_API_KEY
        sync: false
      - key: DAYTONA_API_KEY
        sync: false
      - key: DAYTONA_SERVER_URL
        value: https://app.daytona.io/api
      - key: DAYTONA_TARGET
        value: us
      - key: MCP_CREDENTIAL_ENCRYPTION_KEY
        generateValue: true
      - key: WEBHOOK_BASE_URL
        value: https://kortix-backend.onrender.com

  # Background Worker
  - type: worker
    name: kortix-worker
    env: docker
    dockerfilePath: ./backend/Dockerfile
    dockerContext: ./backend
    dockerCommand: uv run dramatiq --skip-logging --processes 4 --threads 4 run_agent_background
    plan: standard
    region: oregon
    autoDeploy: true
    envVars:
      - key: ENV_MODE
        value: production
      - key: REDIS_HOST
        fromService:
          name: kortix-redis
          type: redis
          property: host
      - key: REDIS_PORT
        fromService:
          name: kortix-redis
          type: redis
          property: port
      - key: REDIS_SSL
        value: true
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: TAVILY_API_KEY
        sync: false
      - key: FIRECRAWL_API_KEY
        sync: false
      - key: RAPID_API_KEY
        sync: false
      - key: DAYTONA_API_KEY
        sync: false

  # Frontend
  - type: web
    name: kortix-frontend
    env: docker
    dockerfilePath: ./frontend/Dockerfile
    dockerContext: ./frontend
    plan: starter
    region: oregon
    autoDeploy: true
    envVars:
      - key: NEXT_PUBLIC_ENV_MODE
        value: production
      - key: NEXT_PUBLIC_BACKEND_URL
        value: https://kortix-backend.onrender.com
      - key: NEXT_PUBLIC_SUPABASE_URL
        sync: false
      - key: NEXT_PUBLIC_SUPABASE_ANON_KEY
        sync: false
      - key: NEXT_PUBLIC_URL
        value: https://kortix-frontend.onrender.com

# Redis
databases:
  - name: kortix-redis
    plan: standard
    ipAllowList: []  # Allow all IPs (Render services)
```

3. **Add Environment Secrets** in Render Dashboard:
   - Go to each service → Environment
   - Add all sensitive keys marked `sync: false`

4. **Deploy:**
   - Push to GitHub main branch
   - Render auto-deploys on every push
   - Monitor logs in dashboard

### Custom Domain Setup:
1. Go to service settings → "Custom Domains"
2. Add your domain
3. Update DNS:
   - Type: CNAME
   - Name: @
   - Value: kortix-frontend.onrender.com

---

## Option 3: Railway 🚂 (Developer-Friendly)

### Why Railway:
- ✅ Excellent DX (developer experience)
- ✅ One-click deployments
- ✅ Built-in observability
- ✅ Usage-based pricing
- ✅ Great for monorepos
- ⚠️ Can get expensive under heavy load

### Cost: ~$100-180/month

| Component | Resource | Cost |
|-----------|----------|------|
| Backend API | 2GB RAM, 2 vCPU | $60/mo |
| Worker | 2GB RAM, 2 vCPU | $60/mo |
| Redis | 1GB | $10/mo |
| Frontend | Hobby (static) | $5/mo |
| Bandwidth | ~100GB | $10/mo |
| **Total** | | **~$145/mo** |

### Deployment Steps:

1. **Install Railway CLI:**
```bash
npm i -g @railway/cli
railway login
```

2. **Create Project:**
```bash
railway init
railway link
```

3. **Create `railway.json`:**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "numReplicas": 1,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

4. **Deploy Services:**

```bash
# Deploy backend
cd backend
railway up --service backend

# Deploy worker
railway up --service worker

# Deploy frontend
cd ../frontend
railway up --service frontend
```

5. **Add Redis:**
```bash
railway add redis
```

6. **Set Environment Variables:**
```bash
# Backend
railway variables set ENV_MODE=production --service backend
railway variables set SUPABASE_URL=<your-url> --service backend
railway variables set ANTHROPIC_API_KEY=<your-key> --service backend
# ... add all other env vars

# Frontend
railway variables set NEXT_PUBLIC_BACKEND_URL=${{backend.RAILWAY_PUBLIC_DOMAIN}} --service frontend
railway variables set NEXT_PUBLIC_SUPABASE_URL=<your-url> --service frontend
```

### Auto-deploy on Git Push:
```bash
railway link
# Connect to GitHub in dashboard
# Enable auto-deploy in settings
```

---

## Option 4: DigitalOcean App Platform 🌊

### Why DigitalOcean:
- ✅ Predictable pricing
- ✅ Simple UI
- ✅ Good global coverage
- ✅ Managed databases
- ⚠️ Less flexible than AWS
- ⚠️ Limited auto-scaling

### Cost: ~$150-250/month

| Service | Plan | Cost |
|---------|------|------|
| Backend App | Pro (2GB RAM, 2 vCPU) | $84/mo |
| Worker App | Pro (2GB RAM, 2 vCPU) | $84/mo |
| Managed Redis | 1GB | $15/mo |
| Static Site | Free | $0 |
| Spaces (CDN) | 250GB | $5/mo |
| **Total** | | **~$188/mo** |

### Deployment:

1. **Create `.do/app.yaml`:**

```yaml
name: kortix
region: nyc

services:
  - name: backend
    github:
      repo: your-username/kortix
      branch: main
      deploy_on_push: true
    source_dir: /backend
    dockerfile_path: backend/Dockerfile
    http_port: 8000
    instance_count: 2
    instance_size_slug: professional-xs
    routes:
      - path: /api
    health_check:
      http_path: /api/health
    envs:
      - key: ENV_MODE
        value: production
      - key: REDIS_HOST
        scope: RUN_TIME
        type: SECRET
      - key: SUPABASE_URL
        scope: RUN_TIME
        type: SECRET
      - key: ANTHROPIC_API_KEY
        scope: RUN_TIME
        type: SECRET

  - name: worker
    github:
      repo: your-username/kortix
      branch: main
      deploy_on_push: true
    source_dir: /backend
    dockerfile_path: backend/Dockerfile
    run_command: uv run dramatiq --skip-logging --processes 4 --threads 4 run_agent_background
    instance_count: 2
    instance_size_slug: professional-xs
    envs:
      - key: ENV_MODE
        value: production
      - key: REDIS_HOST
        scope: RUN_TIME
        type: SECRET

  - name: frontend
    github:
      repo: your-username/kortix
      branch: main
      deploy_on_push: true
    source_dir: /frontend
    dockerfile_path: frontend/Dockerfile
    http_port: 3000
    instance_count: 1
    instance_size_slug: basic-xxs
    envs:
      - key: NEXT_PUBLIC_BACKEND_URL
        value: ${backend.PUBLIC_URL}
      - key: NEXT_PUBLIC_SUPABASE_URL
        scope: RUN_TIME
        type: SECRET

databases:
  - name: redis
    engine: REDIS
    production: true
    version: "7"
```

2. **Deploy via CLI:**
```bash
# Install doctl
brew install doctl  # or snap install doctl

# Authenticate
doctl auth init

# Create app
doctl apps create --spec .do/app.yaml

# Update app
doctl apps update <app-id> --spec .do/app.yaml
```

Or deploy via web UI:
1. Go to https://cloud.digitalocean.com/apps
2. Click "Create App"
3. Connect GitHub
4. Choose repo and branch
5. Follow wizard

---

## Option 5: Fly.io 🪂 (Global Edge)

### Why Fly.io:
- ✅ Global edge deployment
- ✅ Low latency worldwide
- ✅ Great for WebSockets
- ✅ Affordable
- ✅ Excellent CLI
- ⚠️ Smaller ecosystem
- ⚠️ Learning curve

### Cost: ~$80-150/month

| Service | Resources | Cost |
|---------|-----------|------|
| Backend (2 instances) | shared-cpu-2x, 2GB | $48/mo |
| Worker (2 instances) | shared-cpu-2x, 2GB | $48/mo |
| Redis (Upstash) | 1GB | $10/mo |
| Static Assets | Volumes 10GB | $2.30/mo |
| **Total** | | **~$108/mo** |

### Deployment:

1. **Install flyctl:**
```bash
curl -L https://fly.io/install.sh | sh
flyctl auth login
```

2. **Create `fly.backend.toml`:**

```toml
app = "kortix-backend"
primary_region = "iad"

[build]
  dockerfile = "backend/Dockerfile"

[env]
  ENV_MODE = "production"
  REDIS_SSL = "true"

[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 2

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/api/health"

[[services]]
  protocol = "tcp"
  internal_port = 8000

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

[[vm]]
  cpu_kind = "shared"
  cpus = 2
  memory_mb = 2048
```

3. **Create `fly.worker.toml`:**

```toml
app = "kortix-worker"
primary_region = "iad"

[build]
  dockerfile = "backend/Dockerfile"

[env]
  ENV_MODE = "production"

[processes]
  worker = "uv run dramatiq --skip-logging --processes 4 --threads 4 run_agent_background"

[[vm]]
  cpu_kind = "shared"
  cpus = 2
  memory_mb = 2048
  processes = ["worker"]
```

4. **Deploy:**

```bash
# Create apps
flyctl apps create kortix-backend
flyctl apps create kortix-worker
flyctl apps create kortix-frontend

# Set secrets
flyctl secrets set SUPABASE_URL=xxx -a kortix-backend
flyctl secrets set ANTHROPIC_API_KEY=xxx -a kortix-backend
# ... set all secrets

# Deploy
flyctl deploy --config fly.backend.toml --ha=false
flyctl deploy --config fly.worker.toml --ha=false

# Scale up
flyctl scale count 2 -a kortix-backend
flyctl scale count 2 -a kortix-worker
```

5. **Add Redis (Upstash):**
```bash
flyctl redis create --name kortix-redis
# Attach to apps
flyctl redis connect -a kortix-backend
flyctl redis connect -a kortix-worker
```

---

## Option 6: Google Cloud Run ☁️ (Serverless)

### Why Cloud Run:
- ✅ True serverless (pay per request)
- ✅ Scales to zero
- ✅ Excellent for burst traffic
- ✅ Fast cold starts
- ⚠️ 60 minute request timeout (good for long tasks)
- ⚠️ Stateless (need Redis/Memorystore)

### Cost: ~$150-300/month (varies with traffic)

### Deployment:

1. **Install gcloud CLI:**
```bash
curl https://sdk.cloud.google.com | bash
gcloud init
gcloud auth configure-docker
```

2. **Create `cloudbuild.yaml`:**

```yaml
steps:
  # Build backend
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/kortix-backend', './backend']
  
  # Build worker
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/kortix-worker', './backend']
    env:
      - 'DOCKER_BUILDKIT=1'
  
  # Build frontend
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/kortix-frontend', './frontend']

images:
  - 'gcr.io/$PROJECT_ID/kortix-backend'
  - 'gcr.io/$PROJECT_ID/kortix-worker'
  - 'gcr.io/$PROJECT_ID/kortix-frontend'
```

3. **Deploy:**

```bash
# Set project
gcloud config set project your-project-id

# Enable APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable redis.googleapis.com

# Create Redis instance (Memorystore)
gcloud redis instances create kortix-redis \
  --size=1 \
  --region=us-central1 \
  --tier=basic

# Build images
gcloud builds submit --config cloudbuild.yaml

# Deploy backend
gcloud run deploy kortix-backend \
  --image gcr.io/$PROJECT_ID/kortix-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars="ENV_MODE=production,REDIS_HOST=<redis-ip>" \
  --set-secrets="SUPABASE_URL=supabase-url:latest" \
  --timeout=3600 \
  --memory=4Gi \
  --cpu=2 \
  --min-instances=1 \
  --max-instances=10

# Deploy worker
gcloud run jobs create kortix-worker \
  --image gcr.io/$PROJECT_ID/kortix-worker \
  --region us-central1 \
  --set-env-vars="ENV_MODE=production,REDIS_HOST=<redis-ip>" \
  --set-secrets="SUPABASE_URL=supabase-url:latest" \
  --memory=4Gi \
  --cpu=2 \
  --parallelism=2

# Deploy frontend
gcloud run deploy kortix-frontend \
  --image gcr.io/$PROJECT_ID/kortix-frontend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars="NEXT_PUBLIC_BACKEND_URL=https://kortix-backend-xxx.run.app"
```

---

## Option 7: Self-Hosted VPS (Hetzner/Linode) 💻

### Why Self-Hosted:
- ✅ Maximum control
- ✅ Lowest cost
- ✅ No vendor lock-in
- ✅ Custom configurations
- ⚠️ You manage everything
- ⚠️ No auto-scaling
- ⚠️ Manual security updates

### Cost: $40-120/month

| Provider | Specs | Cost |
|----------|-------|------|
| Hetzner CPX41 | 8 vCPU, 16GB RAM, 240GB SSD | €28/mo (~$31) |
| Linode 16GB | 6 vCPU, 16GB RAM, 320GB SSD | $96/mo |
| DigitalOcean | 8GB RAM, 4 vCPU, 160GB SSD | $48/mo |

### Deployment (Ubuntu 22.04):

```bash
# SSH into server
ssh root@your-server-ip

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
apt install docker-compose-plugin

# Clone repo
git clone https://github.com/your-org/kortix.git
cd kortix

# Setup environment
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
# Edit env files with nano/vim

# Start services
docker compose up -d

# Install Nginx
apt install nginx certbot python3-certbot-nginx

# Configure Nginx
cat > /etc/nginx/sites-available/kortix << 'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location /api {
        proxy_pass http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1800s;
    }

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

ln -s /etc/nginx/sites-available/kortix /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx

# Get SSL certificate
certbot --nginx -d your-domain.com

# Setup auto-restart on reboot
cat > /etc/systemd/system/kortix.service << 'EOF'
[Unit]
Description=Kortix Platform
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/root/kortix
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
EOF

systemctl enable kortix
```

---

## Mobile App Deployment

### iOS (App Store)

1. **Setup:**
```bash
cd apps/mobile
npm install
```

2. **Build for iOS:**
```bash
# Install EAS CLI
npm install -g eas-cli
eas login

# Configure
eas build:configure

# Build
eas build --platform ios --profile production

# Submit
eas submit --platform ios
```

3. **Update app.json:**
```json
{
  "expo": {
    "name": "Kortix",
    "slug": "kortix",
    "version": "1.0.0",
    "ios": {
      "bundleIdentifier": "com.yourcompany.kortix",
      "buildNumber": "1"
    }
  }
}
```

### Android (Google Play)

```bash
# Build for Android
eas build --platform android --profile production

# Submit
eas submit --platform android
```

### Over-the-Air Updates (OTA)

```bash
# Publish update
eas update --branch production --message "Bug fixes"

# Auto-update configuration in app.json
{
  "expo": {
    "updates": {
      "enabled": true,
      "checkAutomatically": "ON_LOAD",
      "fallbackToCacheTimeout": 0
    }
  }
}
```

---

## Recommended Deployment Path

### For Startups (0-1000 users):
1. **Start**: Render (easiest)
2. **When**: Sub-second response times matter
3. **Scale to**: AWS or GCP

### For Solo Developers:
1. **Start**: Fly.io or Railway
2. **When**: Need lower costs
3. **Scale to**: Self-hosted VPS

### For Enterprises:
1. **Start**: AWS ECS or Azure
2. **When**: Day 1
3. **Scale**: Add CDN, multi-region

### For Learning/Hobby:
1. **Start**: Self-hosted VPS (Hetzner)
2. **When**: Want full control
3. **Scale**: Add monitoring, backups

---

## Security Checklist (All Options)

- [ ] Enable HTTPS/TLS everywhere
- [ ] Set up firewall rules
- [ ] Use secrets management (not plain text env vars)
- [ ] Enable rate limiting
- [ ] Configure CORS properly
- [ ] Use MCP_CREDENTIAL_ENCRYPTION_KEY
- [ ] Enable Redis password
- [ ] Set up monitoring/alerts
- [ ] Regular backups of Supabase
- [ ] DDoS protection (Cloudflare)
- [ ] Security headers (CSP, HSTS)
- [ ] Regular dependency updates

---

## Performance Optimization

### Backend:
- Enable Gunicorn with 4-8 workers
- Use Redis for caching
- Enable gzip compression
- Connection pooling for Supabase
- Implement request timeouts

### Frontend:
- Enable Next.js Image Optimization
- Use CDN for static assets
- Implement code splitting
- Enable ISR (Incremental Static Regeneration)
- Compress images

### Database:
- Add indexes on frequently queried columns
- Enable connection pooling
- Use read replicas for heavy loads
- Implement query caching

---

## Monitoring Setup

### Essential Metrics:
1. **Application**:
   - Request latency (p50, p95, p99)
   - Error rate (5xx responses)
   - Active agents/tasks
   - Queue depth

2. **Infrastructure**:
   - CPU utilization
   - Memory usage
   - Redis hit rate
   - Network bandwidth

3. **Business**:
   - Daily active users
   - Agent task completion rate
   - API usage per user
   - Cost per request

### Tools:
- **Free**: Built-in platform metrics
- **Paid**: Datadog, New Relic, Sentry
- **Open Source**: Prometheus + Grafana

---

## Support and Help

- **Documentation**: https://docs.kortix.ai
- **Discord**: https://discord.gg/Py6pCBUUPw
- **GitHub Issues**: https://github.com/kortix-ai/suna/issues
- **Email**: support@kortix.ai


