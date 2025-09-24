#!/bin/bash
# Environment setup script for Kusor Azure deployment

echo "🔧 Setting up environment variables for Kusor deployment"
echo "======================================================="

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "Creating .env file..."
    touch .env
fi

# Function to prompt for environment variable
prompt_env_var() {
    local var_name=$1
    local description=$2
    local current_value=${!var_name}
    
    if [ -n "$current_value" ]; then
        echo "✅ $var_name is already set"
        return
    fi
    
    echo ""
    echo "📝 $description"
    read -p "Enter $var_name: " value
    
    if [ -n "$value" ]; then
        export $var_name="$value"
        echo "export $var_name=\"$value\"" >> .env
        echo "✅ $var_name set successfully"
    else
        echo "⚠️  Warning: $var_name not set"
    fi
}

# Load existing environment variables
if [ -f ".env" ]; then
    echo "Loading existing environment variables..."
    source .env
fi

echo ""
echo "🔑 Please provide the following required environment variables:"
echo ""

# Supabase Configuration
prompt_env_var "SUPABASE_URL" "Your Supabase project URL (e.g., https://your-project.supabase.co)"
prompt_env_var "SUPABASE_ANON_KEY" "Your Supabase anonymous/public key"
prompt_env_var "SUPABASE_SERVICE_KEY" "Your Supabase service role key (keep this secret!)"

# Optional: OpenAI API Key for image generation
prompt_env_var "OPENAI_API_KEY" "OpenAI API Key for image generation (optional but recommended)"

# Optional: Other API keys
prompt_env_var "ANTHROPIC_API_KEY" "Anthropic API Key for Claude models (optional)"
prompt_env_var "GOOGLE_API_KEY" "Google API Key for additional services (optional)"

echo ""
echo "🎯 Environment setup completed!"
echo ""
echo "📋 Summary of configured variables:"
echo "=================================="

# Display configured variables (without showing sensitive values)
if [ -n "$SUPABASE_URL" ]; then
    echo "✅ SUPABASE_URL: ${SUPABASE_URL:0:30}..."
fi

if [ -n "$SUPABASE_ANON_KEY" ]; then
    echo "✅ SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY:0:20}..."
fi

if [ -n "$SUPABASE_SERVICE_KEY" ]; then
    echo "✅ SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY:0:20}..."
fi

if [ -n "$OPENAI_API_KEY" ]; then
    echo "✅ OPENAI_API_KEY: ${OPENAI_API_KEY:0:20}..."
fi

if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "✅ ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:20}..."
fi

if [ -n "$GOOGLE_API_KEY" ]; then
    echo "✅ GOOGLE_API_KEY: ${GOOGLE_API_KEY:0:20}..."
fi

echo ""
echo "🚀 You're now ready to deploy Kusor to Azure!"
echo "   Run: ./deploy.sh to start the deployment"
echo ""
echo "💡 Tip: Keep your .env file secure and never commit it to version control"
