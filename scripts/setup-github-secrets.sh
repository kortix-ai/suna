#!/bin/bash
# GitHub Secrets Setup Helper
# This script helps you set up required GitHub secrets for CI/CD

set -e

REPO="kortix-ai/suna"

echo "=========================================="
echo "GitHub Secrets Setup for CI/CD"
echo "=========================================="
echo ""

# Check if gh CLI is available
if ! command -v gh &> /dev/null; then
    echo "❌ Error: GitHub CLI (gh) is not installed"
    echo "Install it from: https://cli.github.com/"
    exit 1
fi

# Check authentication
echo "Checking GitHub authentication..."
if ! gh auth status &> /dev/null; then
    echo "❌ Error: Not authenticated with GitHub CLI"
    echo "Run: gh auth login"
    exit 1
fi
echo "✅ Authenticated"
echo ""

# List current secrets
echo "Current secrets in repository:"
gh secret list -R $REPO
echo ""

# Required secrets
declare -a REQUIRED_SECRETS=(
    "AWS_DEV_HOST"
    "AWS_DEV_USERNAME"
    "AWS_DEV_KEY"
    "DEV_KORTIX_ADMIN_API_KEY"
    "AWS_STAGING_HOST"
    "AWS_STAGING_USERNAME"
    "AWS_STAGING_KEY"
    "STAGING_KORTIX_ADMIN_API_KEY"
)

echo "=========================================="
echo "Checking required secrets..."
echo "=========================================="
echo ""

EXISTING_SECRETS=$(gh secret list -R $REPO --json name -q '.[].name')

for secret in "${REQUIRED_SECRETS[@]}"; do
    if echo "$EXISTING_SECRETS" | grep -q "^${secret}$"; then
        echo "✅ $secret - Already exists"
    else
        echo "❌ $secret - MISSING"
        echo ""
        read -p "   Do you want to set $secret now? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "   Enter value for $secret (input will be hidden):"
            gh secret set $secret -R $REPO
            echo "   ✅ $secret set successfully"
        fi
        echo ""
    fi
done

echo "=========================================="
echo "Setup complete!"
echo "=========================================="
echo ""
echo "Run 'gh secret list -R $REPO' to verify all secrets are set."
