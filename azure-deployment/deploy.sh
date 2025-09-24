#!/bin/bash
set -e

# Kusor Azure Deployment Script
# This script deploys Kusor to Azure Container Apps

echo "🚀 Starting Kusor deployment to Azure..."

# Configuration
RESOURCE_GROUP="kusor-rg"
LOCATION="eastus"
CONTAINER_APP_ENV="kusor-env"
REGISTRY_NAME="kusorregistry"
REDIS_NAME="kusor-redis"
SUPABASE_URL=${SUPABASE_URL:-""}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY:-""}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY:-""}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if required environment variables are set
check_env_vars() {
    if [ -z "$SUPABASE_URL" ]; then
        print_error "SUPABASE_URL environment variable is required"
        exit 1
    fi
    
    if [ -z "$SUPABASE_ANON_KEY" ]; then
        print_error "SUPABASE_ANON_KEY environment variable is required"
        exit 1
    fi
    
    if [ -z "$SUPABASE_SERVICE_KEY" ]; then
        print_error "SUPABASE_SERVICE_KEY environment variable is required"
        exit 1
    fi
}

# Install required Azure CLI extensions
install_extensions() {
    echo "📦 Installing Azure CLI extensions..."
    az extension add --name containerapp --upgrade --yes
    # Redis extension not needed for Azure Cache for Redis
    print_status "Extensions installed"
}

# Create resource group
create_resource_group() {
    echo "🏗️  Creating resource group..."
    az group create \
        --name $RESOURCE_GROUP \
        --location $LOCATION \
        --output table
    print_status "Resource group '$RESOURCE_GROUP' created"
}

# Create Azure Container Registry
create_registry() {
    echo "📦 Creating Azure Container Registry..."
    az acr create \
        --resource-group $RESOURCE_GROUP \
        --name $REGISTRY_NAME \
        --sku Basic \
        --admin-enabled true \
        --output table
    print_status "Container Registry '$REGISTRY_NAME' created"
}

# Create Redis Cache
create_redis() {
    echo "🔴 Creating Redis Cache..."
    az redis create \
        --resource-group $RESOURCE_GROUP \
        --name $REDIS_NAME \
        --location $LOCATION \
        --sku Basic \
        --vm-size c0 \
        --output table
    print_status "Redis Cache '$REDIS_NAME' created"
}

# Create Container App Environment
create_container_env() {
    echo "🌐 Creating Container App Environment..."
    az containerapp env create \
        --name $CONTAINER_APP_ENV \
        --resource-group $RESOURCE_GROUP \
        --location $LOCATION \
        --output table
    print_status "Container App Environment '$CONTAINER_APP_ENV' created"
}

# Build and push images
build_and_push_images() {
    echo "🔨 Building and pushing Docker images..."
    
    # Get ACR login server
    ACR_LOGIN_SERVER=$(az acr show --name $REGISTRY_NAME --query loginServer --output tsv)
    
    # Login to ACR
    az acr login --name $REGISTRY_NAME
    
    # Build and push backend image
    echo "Building backend image..."
    docker build -t $ACR_LOGIN_SERVER/kusor-backend:latest ../backend
    docker push $ACR_LOGIN_SERVER/kusor-backend:latest
    
    # Build and push frontend image
    echo "Building frontend image..."
    docker build -t $ACR_LOGIN_SERVER/kusor-frontend:latest ../frontend
    docker push $ACR_LOGIN_SERVER/kusor-frontend:latest
    
    print_status "Images built and pushed to ACR"
}

# Get Redis connection string
get_redis_connection() {
    echo "🔗 Getting Redis connection string..."
    REDIS_KEY=$(az redis list-keys --resource-group $RESOURCE_GROUP --name $REDIS_NAME --query primaryKey --output tsv)
    REDIS_HOST=$(az redis show --resource-group $RESOURCE_GROUP --name $REDIS_NAME --query hostName --output tsv)
    REDIS_CONNECTION_STRING="redis://:$REDIS_KEY@$REDIS_HOST:6380"
    print_status "Redis connection string obtained"
}

# Deploy backend container app
deploy_backend() {
    echo "🚀 Deploying backend container app..."
    
    ACR_LOGIN_SERVER=$(az acr show --name $REGISTRY_NAME --query loginServer --output tsv)
    ACR_USERNAME=$(az acr credential show --name $REGISTRY_NAME --query username --output tsv)
    ACR_PASSWORD=$(az acr credential show --name $REGISTRY_NAME --query passwords[0].value --output tsv)
    
    az containerapp create \
        --name kusor-backend \
        --resource-group $RESOURCE_GROUP \
        --environment $CONTAINER_APP_ENV \
        --image $ACR_LOGIN_SERVER/kusor-backend:latest \
        --registry-server $ACR_LOGIN_SERVER \
        --registry-username $ACR_USERNAME \
        --registry-password $ACR_PASSWORD \
        --target-port 8000 \
        --ingress external \
        --min-replicas 1 \
        --max-replicas 5 \
        --cpu 2.0 \
        --memory 4.0Gi \
        --env-vars \
            REDIS_URL="$REDIS_CONNECTION_STRING" \
            SUPABASE_URL="$SUPABASE_URL" \
            SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
            ENV_MODE="production" \
        --output table
    
    print_status "Backend deployed"
}

# Deploy frontend container app
deploy_frontend() {
    echo "🎨 Deploying frontend container app..."
    
    ACR_LOGIN_SERVER=$(az acr show --name $REGISTRY_NAME --query loginServer --output tsv)
    ACR_USERNAME=$(az acr credential show --name $REGISTRY_NAME --query username --output tsv)
    ACR_PASSWORD=$(az acr credential show --name $REGISTRY_NAME --query passwords[0].value --output tsv)
    
    # Get backend URL
    BACKEND_URL=$(az containerapp show --name kusor-backend --resource-group $RESOURCE_GROUP --query properties.configuration.ingress.fqdn --output tsv)
    
    az containerapp create \
        --name kusor-frontend \
        --resource-group $RESOURCE_GROUP \
        --environment $CONTAINER_APP_ENV \
        --image $ACR_LOGIN_SERVER/kusor-frontend:latest \
        --registry-server $ACR_LOGIN_SERVER \
        --registry-username $ACR_USERNAME \
        --registry-password $ACR_PASSWORD \
        --target-port 3000 \
        --ingress external \
        --min-replicas 1 \
        --max-replicas 3 \
        --cpu 0.5 \
        --memory 1.0Gi \
        --env-vars \
            NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" \
            NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
            NEXT_PUBLIC_API_URL="https://$BACKEND_URL" \
            NODE_ENV="production" \
        --output table
    
    print_status "Frontend deployed"
}

# Deploy worker container app
deploy_worker() {
    echo "👷 Deploying worker container app..."
    
    ACR_LOGIN_SERVER=$(az acr show --name $REGISTRY_NAME --query loginServer --output tsv)
    ACR_USERNAME=$(az acr credential show --name $REGISTRY_NAME --query username --output tsv)
    ACR_PASSWORD=$(az acr credential show --name $REGISTRY_NAME --query passwords[0].value --output tsv)
    
    az containerapp create \
        --name kusor-worker \
        --resource-group $RESOURCE_GROUP \
        --environment $CONTAINER_APP_ENV \
        --image $ACR_LOGIN_SERVER/kusor-backend:latest \
        --registry-server $ACR_LOGIN_SERVER \
        --registry-username $ACR_USERNAME \
        --registry-password $ACR_PASSWORD \
        --min-replicas 1 \
        --max-replicas 3 \
        --cpu 1.5 \
        --memory 3.0Gi \
        --env-vars \
            REDIS_URL="$REDIS_CONNECTION_STRING" \
            SUPABASE_URL="$SUPABASE_URL" \
            SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
            ENV_MODE="production" \
        --command "uv" "run" "dramatiq" "--skip-logging" "--processes" "1" "--threads" "2" "run_agent_background" \
        --output table
    
    print_status "Worker deployed"
}

# Show deployment URLs
show_urls() {
    echo ""
    echo "🎉 Deployment completed successfully!"
    echo ""
    echo "📋 Deployment Summary:"
    echo "====================="
    
    FRONTEND_URL=$(az containerapp show --name kusor-frontend --resource-group $RESOURCE_GROUP --query properties.configuration.ingress.fqdn --output tsv)
    BACKEND_URL=$(az containerapp show --name kusor-backend --resource-group $RESOURCE_GROUP --query properties.configuration.ingress.fqdn --output tsv)
    
    echo "🌐 Frontend URL: https://$FRONTEND_URL"
    echo "🔧 Backend API: https://$BACKEND_URL"
    echo "📦 Container Registry: $REGISTRY_NAME.azurecr.io"
    echo "🔴 Redis Cache: $REDIS_NAME.redis.cache.windows.net"
    echo ""
    echo "🔐 Access your application at: https://$FRONTEND_URL"
}

# Main deployment flow
main() {
    echo "🚀 Kusor Azure Deployment"
    echo "========================="
    echo ""
    
    check_env_vars
    install_extensions
    create_resource_group
    create_registry
    create_redis
    create_container_env
    build_and_push_images
    get_redis_connection
    deploy_backend
    deploy_frontend
    deploy_worker
    show_urls
    
    echo ""
    print_status "Kusor has been successfully deployed to Azure! 🎉"
}

# Run main function
main "$@"
