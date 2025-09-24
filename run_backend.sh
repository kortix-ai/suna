#!/bin/bash
# Script to run the backend with uv
export PATH="$HOME/.local/bin:$PATH"

# Check if uv is available
if ! command -v uv &> /dev/null; then
    echo "❌ uv is not installed or not in PATH"
    echo "Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

echo "🚀 Starting Kusor backend with uv..."
cd backend
uv run api.py
