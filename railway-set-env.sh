#!/bin/bash
# Script to set Railway environment variables from .env.railway.test
# This sets variables for all three services: backend-api, worker, and frontend

set -e

RAILWAY="npx @railway/cli"
ENV_FILE=".env.railway.test"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found!"
    exit 1
fi

echo "=========================================="
echo "Setting Railway Environment Variables"
echo "=========================================="
echo ""

# Parse .env file and filter out comments, empty lines, and Railway template vars
parse_env() {
    grep -v '^#' "$ENV_FILE" | grep -v '^$' | grep -v '\${{' | while IFS='=' read -r key value; do
        # Trim whitespace
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs)

        if [ -n "$key" ] && [ -n "$value" ]; then
            echo "$key=$value"
        fi
    done
}

# Backend API Service
echo "Setting environment variables for backend-api service..."
$RAILWAY service backend-api

# Backend-specific variables
parse_env | while IFS='=' read -r key value; do
    case "$key" in
        SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|\
        OPENAI_API_KEY|GROQ_API_KEY|ANTHROPIC_API_KEY|\
        TAVILY_API_KEY|RAPID_API_KEY|FIRECRAWL_API_KEY|\
        ENV_MODE|MIN_WORKERS|MAX_WORKERS|THREADS|WORKER_CONNECTIONS|\
        REDIS_SSL|E2B_API_KEY|DAYTONA_API_KEY|DAYTONA_SERVER_URL|\
        GEMINI_API_KEY|COMPOSIO_API_KEY|COMPOSIO_WEBHOOK_SECRET|COMPOSIO_API_BASE|\
        EXA_API_KEY|MORPH_API_KEY)
            echo "  Setting $key"
            $RAILWAY variables --set "$key=$value" 2>/dev/null || true
            ;;
    esac
done

# Set Redis variables for backend-api
echo "  Setting Redis variables for backend-api..."
$RAILWAY variables --set "REDIS_HOST=\${{Redis.REDIS_PRIVATE_URL}}" 2>/dev/null || true
$RAILWAY variables --set "REDIS_PORT=6379" 2>/dev/null || true
$RAILWAY variables --set "REDIS_PASSWORD=\${{Redis.REDIS_PASSWORD}}" 2>/dev/null || true
$RAILWAY variables --set "REDIS_SSL=true" 2>/dev/null || true

echo "✓ Backend API environment variables set"
echo ""

# Worker Service
echo "Setting environment variables for worker service..."
$RAILWAY service worker

# Worker-specific variables
parse_env | while IFS='=' read -r key value; do
    case "$key" in
        SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|\
        OPENAI_API_KEY|GROQ_API_KEY|ANTHROPIC_API_KEY|\
        TAVILY_API_KEY|RAPID_API_KEY|FIRECRAWL_API_KEY|\
        ENV_MODE|MIN_PROCESSES|MAX_PROCESSES|THREADS_PER_PROCESS|\
        REDIS_SSL|E2B_API_KEY|DAYTONA_API_KEY|DAYTONA_SERVER_URL|\
        GEMINI_API_KEY|COMPOSIO_API_KEY|COMPOSIO_WEBHOOK_SECRET|COMPOSIO_API_BASE|\
        EXA_API_KEY|MORPH_API_KEY)
            echo "  Setting $key"
            $RAILWAY variables --set "$key=$value" 2>/dev/null || true
            ;;
    esac
done

# Set Redis variables for worker
echo "  Setting Redis variables for worker..."
$RAILWAY variables --set "REDIS_HOST=\${{Redis.REDIS_PRIVATE_URL}}" 2>/dev/null || true
$RAILWAY variables --set "REDIS_PORT=6379" 2>/dev/null || true
$RAILWAY variables --set "REDIS_PASSWORD=\${{Redis.REDIS_PASSWORD}}" 2>/dev/null || true
$RAILWAY variables --set "REDIS_SSL=true" 2>/dev/null || true

echo "✓ Worker environment variables set"
echo ""

# Frontend Service
echo "Setting environment variables for frontend service..."
$RAILWAY service frontend

# Frontend-specific variables
parse_env | while IFS='=' read -r key value; do
    case "$key" in
        KORTIX_ADMIN_API_KEY|NODE_ENV)
            echo "  Setting $key"
            $RAILWAY variables --set "$key=$value" 2>/dev/null || true
            ;;
        SUPABASE_URL)
            echo "  Setting NEXT_PUBLIC_SUPABASE_URL"
            $RAILWAY variables --set "NEXT_PUBLIC_SUPABASE_URL=$value" 2>/dev/null || true
            ;;
        SUPABASE_ANON_KEY)
            echo "  Setting NEXT_PUBLIC_SUPABASE_ANON_KEY"
            $RAILWAY variables --set "NEXT_PUBLIC_SUPABASE_ANON_KEY=$value" 2>/dev/null || true
            ;;
    esac
done

# Set frontend-specific env vars
echo "  Setting NEXT_PUBLIC_ENV_MODE"
$RAILWAY variables --set "NEXT_PUBLIC_ENV_MODE=production" 2>/dev/null || true

echo "  Setting NEXT_PUBLIC_BACKEND_URL (using Railway service reference)"
$RAILWAY variables --set "NEXT_PUBLIC_BACKEND_URL=https://\${{backend-api.RAILWAY_PUBLIC_DOMAIN}}/api" 2>/dev/null || true

echo "  Setting NEXT_PUBLIC_URL (using Railway service reference)"
$RAILWAY variables --set "NEXT_PUBLIC_URL=https://\${{frontend.RAILWAY_PUBLIC_DOMAIN}}" 2>/dev/null || true

echo "  Setting PORT and NODE_ENV"
$RAILWAY variables --set "PORT=3000" 2>/dev/null || true
$RAILWAY variables --set "NODE_ENV=production" 2>/dev/null || true

echo "✓ Frontend environment variables set"
echo ""

echo "=========================================="
echo "Environment setup complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Ensure Redis is added to your Railway project"
echo "2. Run: ./railway-deploy.sh to deploy"
