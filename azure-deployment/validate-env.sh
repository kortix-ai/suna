#!/bin/bash
# Environment validation script for Kusor Azure deployment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

echo "🔍 Validating environment variables for Kusor deployment..."
echo "========================================================"

# Check if .env file exists
if [ ! -f ".env" ]; then
    print_error ".env file not found. Please run ./setup-env.sh first."
    exit 1
fi

# Load environment variables
source .env

VALIDATION_FAILED=false

# Function to validate required environment variable
validate_env_var() {
    local var_name=$1
    local description=$2
    local value=${!var_name}
    
    if [ -z "$value" ]; then
        print_error "$var_name is not set - $description"
        VALIDATION_FAILED=true
    elif [ "$value" = "" ]; then
        print_error "$var_name is empty - $description"
        VALIDATION_FAILED=true
    else
        print_success "$var_name is set"
    fi
}

# Validate required Supabase variables
echo ""
echo "📋 Validating Supabase configuration..."
validate_env_var "SUPABASE_URL" "Supabase project URL"
validate_env_var "SUPABASE_ANON_KEY" "Supabase anonymous key"
validate_env_var "SUPABASE_SERVICE_KEY" "Supabase service role key"

# Validate Supabase URL format
if [ -n "$SUPABASE_URL" ]; then
    if [[ $SUPABASE_URL =~ ^https://.*\.supabase\.co$ ]]; then
        print_success "SUPABASE_URL format is valid"
    else
        print_warning "SUPABASE_URL format may be incorrect. Expected: https://your-project.supabase.co"
    fi
fi

# Validate Supabase keys format (basic JWT check)
if [ -n "$SUPABASE_ANON_KEY" ]; then
    if [[ $SUPABASE_ANON_KEY =~ ^eyJ ]]; then
        print_success "SUPABASE_ANON_KEY format appears valid (JWT)"
    else
        print_warning "SUPABASE_ANON_KEY format may be incorrect. Expected JWT token starting with 'eyJ'"
    fi
fi

if [ -n "$SUPABASE_SERVICE_KEY" ]; then
    if [[ $SUPABASE_SERVICE_KEY =~ ^eyJ ]]; then
        print_success "SUPABASE_SERVICE_KEY format appears valid (JWT)"
    else
        print_warning "SUPABASE_SERVICE_KEY format may be incorrect. Expected JWT token starting with 'eyJ'"
    fi
fi

# Check optional API keys
echo ""
echo "🔑 Checking optional API keys..."
if [ -n "$OPENAI_API_KEY" ]; then
    print_success "OPENAI_API_KEY is set"
else
    print_warning "OPENAI_API_KEY not set - image generation may not work"
fi

if [ -n "$ANTHROPIC_API_KEY" ]; then
    print_success "ANTHROPIC_API_KEY is set"
else
    print_warning "ANTHROPIC_API_KEY not set - Claude models may not work"
fi

if [ -n "$GOOGLE_API_KEY" ]; then
    print_success "GOOGLE_API_KEY is set"
else
    print_warning "GOOGLE_API_KEY not set - Google services may not work"
fi

# Check Azure CLI
echo ""
echo "☁️  Checking Azure CLI..."
if command -v az &> /dev/null; then
    print_success "Azure CLI is installed"
    
    # Check if logged in
    if az account show &> /dev/null; then
        ACCOUNT=$(az account show --query "user.name" --output tsv)
        print_success "Azure CLI is logged in as: $ACCOUNT"
    else
        print_error "Azure CLI is not logged in. Run 'az login' first."
        VALIDATION_FAILED=true
    fi
else
    print_error "Azure CLI is not installed. Please install it first."
    VALIDATION_FAILED=true
fi

# Check Docker
echo ""
echo "🐳 Checking Docker..."
if command -v docker &> /dev/null; then
    print_success "Docker is installed"
    
    # Check if Docker daemon is running
    if docker info &> /dev/null; then
        print_success "Docker daemon is running"
    else
        print_error "Docker daemon is not running. Please start Docker."
        VALIDATION_FAILED=true
    fi
else
    print_error "Docker is not installed. Please install it first."
    VALIDATION_FAILED=true
fi

# Summary
echo ""
echo "📊 Validation Summary"
echo "===================="

if [ "$VALIDATION_FAILED" = true ]; then
    print_error "❌ Validation failed! Please fix the issues above before deploying."
    echo ""
    echo "💡 Next steps:"
    echo "   1. Fix the validation errors above"
    echo "   2. Run this script again: ./validate-env.sh"
    echo "   3. Once validation passes, run: ./deploy.sh"
    exit 1
else
    print_success "✅ All validations passed! You're ready to deploy."
    echo ""
    echo "🚀 Ready to deploy! Run: ./deploy.sh"
fi
