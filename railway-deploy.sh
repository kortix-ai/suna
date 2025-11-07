#!/bin/bash
# Simple Railway Deployment Script
# Uses npx to run Railway CLI

set -e

RAILWAY="npx @railway/cli"

echo "=========================================="
echo "Railway Deployment"
echo "=========================================="
echo ""

# Check if logged in
echo "Checking Railway authentication..."
if ! $RAILWAY whoami 2>/dev/null; then
    echo "Not logged in. Running login..."
    $RAILWAY login
fi

echo "✓ Authenticated"
echo ""

# Check if project is linked
echo "Checking project link..."
if ! $RAILWAY status 2>/dev/null; then
    echo "Project not linked. Please link or create a project:"
    echo "  railway link    - Link to existing project"
    echo "  railway init    - Create new project"
    exit 1
fi

echo "✓ Project linked"
echo ""

# Display current project info
echo "Current project:"
$RAILWAY status
echo ""

# Deploy
echo "Deploying all services to Railway..."
echo "This will deploy:"
echo "  - backend-api"
echo "  - worker"
echo "  - frontend"
echo ""

read -p "Continue with deployment? (y/n): " confirm

if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Deployment cancelled."
    exit 0
fi

echo ""
echo "Starting deployment..."
$RAILWAY up

echo ""
echo "=========================================="
echo "Deployment Complete!"
echo "=========================================="
echo ""
echo "View your deployment:"
echo "  railway open"
echo ""
echo "Check logs:"
echo "  railway logs --service backend-api"
echo "  railway logs --service worker"
echo "  railway logs --service frontend"
