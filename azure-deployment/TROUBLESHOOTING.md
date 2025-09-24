# 🚨 Azure Deployment Troubleshooting Guide

This guide helps you diagnose and fix common issues with Kusor Azure deployments.

## 🔍 Quick Diagnostics

### 1. Pre-deployment Validation
```bash
cd azure-deployment
./validate-env.sh
```

### 2. Check Deployment Status
```bash
# List all container apps
az containerapp list --resource-group kusor-rg --output table

# Check specific app status
az containerapp show --name kusor-backend --resource-group kusor-rg --query "properties.provisioningState"
```

### 3. View Application Logs
```bash
# Backend logs
az containerapp logs show --name kusor-backend --resource-group kusor-rg --tail 100

# Frontend logs  
az containerapp logs show --name kusor-frontend --resource-group kusor-rg --tail 100

# Worker logs
az containerapp logs show --name kusor-worker --resource-group kusor-rg --tail 100
```

## 🚨 Common Issues & Solutions

### Issue 1: Container Apps Failing to Start

**Symptoms:**
- Containers stuck in "Pending" or "Failed" state
- Health checks failing repeatedly

**Diagnosis:**
```bash
# Check container app status
az containerapp show --name kusor-backend --resource-group kusor-rg --query "properties.configuration.ingress"

# Check recent events
az containerapp logs show --name kusor-backend --resource-group kusor-rg --tail 50
```

**Common Causes & Solutions:**

#### A. Environment Variables Missing
```bash
# Check environment variables
az containerapp show --name kusor-backend --resource-group kusor-rg --query "properties.template.containers[0].env"
```

**Fix:** Ensure all required environment variables are set:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` 
- `REDIS_URL`

#### B. Health Check Failures
**Symptoms:** Containers restart repeatedly, health checks return 500/404

**Diagnosis:**
```bash
# Test health endpoint manually
curl https://your-backend-url/api/health
```

**Solutions:**
1. **Check if health endpoint exists** - Ensure `/api/health` returns 200 OK
2. **Increase health check timeouts** - Health checks may be too aggressive
3. **Verify port configuration** - Ensure app listens on correct port (8000 for backend)

#### C. Resource Constraints
**Symptoms:** Containers crash with OOMKilled or CPU throttling

**Fix:** Increase resource allocation in `azure-resources.bicep`:
```bicep
resources: {
  cpu: json('2.0')    // Increase from 1.0
  memory: '4.0Gi'     // Increase from 2.0Gi
}
```

### Issue 2: Database Connection Failures

**Symptoms:**
- "Database connection failed" errors
- Supabase authentication errors
- 401/403 responses from API

**Diagnosis:**
```bash
# Check database connectivity from logs
az containerapp logs show --name kusor-backend --resource-group kusor-rg | grep -i "database\|supabase\|connection"
```

**Solutions:**

#### A. Invalid Supabase Credentials
1. Verify Supabase URL format: `https://your-project.supabase.co`
2. Check Supabase keys are valid JWT tokens starting with `eyJ`
3. Ensure service key has proper permissions

#### B. Network Connectivity Issues
1. Check if Azure region can reach Supabase
2. Verify no firewall rules blocking outbound connections
3. Test from Azure Cloud Shell: `curl https://your-project.supabase.co`

### Issue 3: Redis Connection Issues

**Symptoms:**
- "Redis connection failed" errors
- Background tasks not processing
- Worker container crashes

**Diagnosis:**
```bash
# Check Redis connectivity
az containerapp logs show --name kusor-worker --resource-group kusor-rg | grep -i "redis"

# Test Redis connection string
echo $REDIS_CONNECTION_STRING
```

**Solutions:**

#### A. Redis Connection String Format
Ensure connection string format is correct:
```
redis://:password@hostname:6380
```

#### B. Redis SSL Issues
Try without SSL if SSL connection fails:
```bash
# In deploy.sh, change:
REDIS_CONNECTION_STRING="redis://:$REDIS_KEY@$REDIS_HOST:6380"
```

#### C. Redis Authentication
Verify Redis key is correct:
```bash
# Get Redis key
az redis list-keys --resource-group kusor-rg --name kusor-redis --query primaryKey --output tsv
```

### Issue 4: Docker Image Build Failures

**Symptoms:**
- "Image not found" errors during deployment
- Build process fails with errors

**Diagnosis:**
```bash
# Check if images exist in registry
az acr repository list --name kusorregistry --output table

# Check build logs
docker build -t test-image ./backend
```

**Solutions:**

#### A. Build Context Issues
Ensure Docker build context includes all necessary files:
```bash
# From project root
docker build -t kusor-backend:latest ./backend
docker build -t kusor-frontend:latest ./frontend
```

#### B. Missing Dependencies
Check if all required files are present:
- `pyproject.toml` and `uv.lock` for backend
- `package.json` and lockfile for frontend

#### C. ACR Authentication
```bash
# Login to ACR
az acr login --name kusorregistry

# Test push
docker tag test-image kusorregistry.azurecr.io/test:latest
docker push kusorregistry.azurecr.io/test:latest
```

### Issue 5: Frontend Build Failures

**Symptoms:**
- Frontend container fails to start
- Build process errors during Docker build

**Common Causes:**

#### A. Missing Environment Variables
Frontend needs these at build time:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_URL`

#### B. Node.js Version Issues
Ensure Dockerfile uses compatible Node.js version:
```dockerfile
FROM node:22-slim AS base
```

#### C. Build Dependencies
Install system dependencies in Dockerfile:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ build-essential pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

## 🔧 Advanced Debugging

### Enable Verbose Logging

Add to container environment variables:
```bash
LOG_LEVEL=debug
ENV_MODE=development
```

### Test Individual Components

#### Test Backend API
```bash
# Get backend URL
BACKEND_URL=$(az containerapp show --name kusor-backend --resource-group kusor-rg --query "properties.configuration.ingress.fqdn" --output tsv)

# Test health endpoint
curl "https://$BACKEND_URL/api/health"

# Test with authentication
curl "https://$BACKEND_URL/api/health" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

#### Test Redis Connection
```bash
# Get Redis connection details
REDIS_HOST=$(az redis show --resource-group kusor-rg --name kusor-redis --query hostName --output tsv)
REDIS_KEY=$(az redis list-keys --resource-group kusor-rg --name kusor-redis --query primaryKey --output tsv)

# Test connection
redis-cli -h $REDIS_HOST -p 6380 -a $REDIS_KEY ping
```

### Container App Configuration Debug

```bash
# View full container app configuration
az containerapp show --name kusor-backend --resource-group kusor-rg --output json > backend-config.json

# Check specific configuration sections
az containerapp show --name kusor-backend --resource-group kusor-rg --query "properties.template.containers[0]"
```

## 🚀 Recovery Procedures

### Complete Redeployment

If all else fails, perform a clean redeployment:

```bash
# 1. Delete existing resources
az group delete --name kusor-rg --yes --no-wait

# 2. Wait for deletion to complete
az group wait --deleted --name kusor-rg

# 3. Validate environment
./validate-env.sh

# 4. Redeploy
./deploy.sh
```

### Partial Recovery

#### Restart Container Apps
```bash
# Restart all container apps
az containerapp restart --name kusor-backend --resource-group kusor-rg
az containerapp restart --name kusor-frontend --resource-group kusor-rg
az containerapp restart --name kusor-worker --resource-group kusor-rg
```

#### Update Container Images
```bash
# Rebuild and push images
./deploy.sh  # This will rebuild and update containers
```

#### Scale Down and Up
```bash
# Scale to 0 and back up
az containerapp update --name kusor-backend --resource-group kusor-rg --min-replicas 0 --max-replicas 1
sleep 30
az containerapp update --name kusor-backend --resource-group kusor-rg --min-replicas 1 --max-replicas 5
```

## 📊 Monitoring & Health Checks

### Set Up Alerts

```bash
# Create alert for failed containers
az monitor metrics alert create \
  --name "Kusor Container Failures" \
  --resource-group kusor-rg \
  --scopes /subscriptions/YOUR_SUBSCRIPTION_ID/resourceGroups/kusor-rg/providers/Microsoft.App/containerApps \
  --condition "count 'Microsoft.App/containerApps' > 0" \
  --description "Alert when containers fail"
```

### Health Check Endpoints

- **Backend Health**: `https://your-backend-url/api/health`
- **Backend Detailed Health**: `https://your-backend-url/api/health-docker`
- **Frontend**: `https://your-frontend-url/`

## 🆘 Getting Help

### Useful Commands for Support

```bash
# Collect diagnostic information
echo "=== Azure CLI Version ==="
az version

echo "=== Resource Group Status ==="
az group show --name kusor-rg

echo "=== Container Apps Status ==="
az containerapp list --resource-group kusor-rg --output table

echo "=== Recent Logs ==="
az containerapp logs show --name kusor-backend --resource-group kusor-rg --tail 50
```

### Log Collection

```bash
# Collect all logs for analysis
mkdir -p logs
az containerapp logs show --name kusor-backend --resource-group kusor-rg > logs/backend.log
az containerapp logs show --name kusor-frontend --resource-group kusor-rg > logs/frontend.log
az containerapp logs show --name kusor-worker --resource-group kusor-rg > logs/worker.log
```

---

## 🎯 Prevention Tips

1. **Always run validation** before deployment: `./validate-env.sh`
2. **Monitor resource usage** and scale appropriately
3. **Keep dependencies updated** in Dockerfiles
4. **Test locally** before deploying to Azure
5. **Use staging environment** for testing changes
6. **Monitor costs** regularly in Azure portal

For additional support, check the [Azure Container Apps documentation](https://docs.microsoft.com/en-us/azure/container-apps/) or create an issue in the project repository.
