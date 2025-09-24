# Kusor Azure Deployment Guide

This directory contains all the necessary files and scripts to deploy Kusor to Microsoft Azure using Azure Container Apps.

## 🏗️ Architecture Overview

Kusor will be deployed with the following Azure services:

- **Azure Container Apps**: For hosting the frontend, backend, and worker containers
- **Azure Container Registry**: For storing Docker images
- **Azure Cache for Redis**: For task queuing and caching
- **Azure Log Analytics**: For monitoring and logging

## 📋 Prerequisites

1. **Azure CLI** installed and logged in to your account
2. **Docker** installed for building images
3. **Supabase project** set up with database
4. **Required API keys** (OpenAI, Anthropic, etc.)

## 🚀 Quick Start

### Step 1: Set up environment variables

```bash
cd azure-deployment
chmod +x setup-env.sh
./setup-env.sh
```

This will prompt you for all required environment variables and create a `.env` file.

### Step 2: Deploy to Azure

```bash
chmod +x deploy.sh
./deploy.sh
```

The deployment script will:
- Create all Azure resources
- Build and push Docker images
- Deploy the application containers
- Configure networking and scaling

### Step 3: Access your application

After deployment completes, you'll see the URLs for:
- **Frontend**: Your main Kusor application
- **Backend**: API endpoints
- **Azure Portal**: For monitoring and management

## 📁 File Structure

```
azure-deployment/
├── deploy.sh                 # Main deployment script
├── setup-env.sh             # Environment variable setup
├── azure-resources.bicep    # Infrastructure as Code (Bicep)
├── parameters.json          # Bicep template parameters
├── .env                     # Environment variables (created by setup-env.sh)
└── README.md               # This file
```

## 🔧 Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SUPABASE_URL` | Your Supabase project URL | `https://abc123.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | `eyJ0eXAiOiJKV1Q...` |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | `eyJ0eXAiOiJKV1Q...` |

### Optional Environment Variables

| Variable | Description | Purpose |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | Image generation, GPT models |
| `ANTHROPIC_API_KEY` | Anthropic API key | Claude models |
| `GOOGLE_API_KEY` | Google API key | Additional services |

## 🏗️ Infrastructure Details

### Azure Resources Created

1. **Resource Group**: `kusor-rg`
2. **Container Registry**: `kusorregistry`
3. **Redis Cache**: `kusor-redis` (Basic tier)
4. **Container App Environment**: `kusor-env`
5. **Log Analytics Workspace**: `kusor-logs`

### Container Apps

1. **Frontend** (`kusor-frontend`)
   - Next.js application
   - External ingress on port 3000
   - 1-3 replicas (auto-scaling)
   - 0.5 CPU, 1GB RAM per replica

2. **Backend** (`kusor-backend`)
   - FastAPI application
   - External ingress on port 8000
   - 1-5 replicas (auto-scaling)
   - 1 CPU, 2GB RAM per replica

3. **Worker** (`kusor-worker`)
   - Background task processor
   - No external ingress
   - 1-3 replicas (auto-scaling)
   - 1 CPU, 2GB RAM per replica

## 🔍 Monitoring & Logging

- **Azure Monitor**: Built-in monitoring for all resources
- **Log Analytics**: Centralized logging for troubleshooting
- **Container Insights**: Detailed container metrics
- **Health Checks**: Automatic health monitoring

## 🛠️ Management Commands

### View deployment status
```bash
az containerapp list --resource-group kusor-rg --output table
```

### View application logs
```bash
# Frontend logs
az containerapp logs show --name kusor-frontend --resource-group kusor-rg

# Backend logs
az containerapp logs show --name kusor-backend --resource-group kusor-rg

# Worker logs
az containerapp logs show --name kusor-worker --resource-group kusor-rg
```

### Scale applications
```bash
# Scale backend
az containerapp update --name kusor-backend --resource-group kusor-rg --min-replicas 2 --max-replicas 10

# Scale worker
az containerapp update --name kusor-worker --resource-group kusor-rg --min-replicas 2 --max-replicas 5
```

### Update application
```bash
# Rebuild and push new images
docker build -t kusorregistry.azurecr.io/kusor-backend:latest ./backend
docker push kusorregistry.azurecr.io/kusor-backend:latest

# Update container app with new image
az containerapp update --name kusor-backend --resource-group kusor-rg --image kusorregistry.azurecr.io/kusor-backend:latest
```

## 💰 Cost Optimization

### Estimated Monthly Costs (USD)

- **Container Apps**: ~$50-200 (depending on usage)
- **Container Registry**: ~$5
- **Redis Cache**: ~$15 (Basic tier)
- **Log Analytics**: ~$10-30 (depending on logs)

**Total**: ~$80-250/month

### Cost Saving Tips

1. **Scale down during low usage**: Set minimum replicas to 0 for non-critical times
2. **Use smaller Redis tier**: Basic C0 is sufficient for development
3. **Optimize log retention**: Reduce Log Analytics retention period
4. **Monitor usage**: Use Azure Cost Management to track spending

## 🔒 Security

### Built-in Security Features

- **HTTPS only**: All ingress is HTTPS by default
- **Managed identities**: No stored credentials in containers
- **Network isolation**: Container apps are isolated by default
- **Secret management**: Sensitive values stored as secrets
- **Redis SSL**: All Redis connections use SSL/TLS

### Security Best Practices

1. **Rotate keys regularly**: Update API keys and secrets periodically
2. **Monitor access**: Review Azure Activity Logs regularly
3. **Use least privilege**: Assign minimal required permissions
4. **Enable diagnostic logs**: Monitor for security events

## 🚨 Troubleshooting

### Common Issues

1. **Deployment fails**: Check Azure CLI authentication and permissions
2. **Images not found**: Ensure Docker images are built and pushed to ACR
3. **App not starting**: Check environment variables and secrets
4. **High latency**: Consider scaling up or moving to a closer Azure region

### Debug Commands

```bash
# Check container app status
az containerapp show --name kusor-backend --resource-group kusor-rg

# View recent logs
az containerapp logs show --name kusor-backend --resource-group kusor-rg --tail 100

# Check resource group resources
az resource list --resource-group kusor-rg --output table
```

## 🆘 Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review Azure Container Apps documentation
3. Check the application logs for error messages
4. Verify all environment variables are set correctly

## 🔄 Updates & Maintenance

### Regular Maintenance Tasks

1. **Update dependencies**: Keep Docker base images updated
2. **Monitor costs**: Review Azure billing monthly
3. **Check logs**: Review application logs for errors
4. **Scale optimization**: Adjust scaling rules based on usage patterns

### Update Process

1. Update your code locally
2. Build new Docker images
3. Push to Azure Container Registry
4. Update Container Apps with new images
5. Verify deployment health

---

**🎉 Congratulations!** You now have Kusor running on Azure with enterprise-grade infrastructure!

For more information, visit the [Azure Container Apps documentation](https://docs.microsoft.com/en-us/azure/container-apps/).
