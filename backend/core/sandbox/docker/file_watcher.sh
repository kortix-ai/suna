#!/bin/bash
# File watcher script that indexes files using kb-fusion when they change

# Set up environment - use kb's default location
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"

# Ensure workspace exists
mkdir -p /workspace

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting kb file watcher on /workspace"

# Excluded directories pattern
EXCLUDE_PATTERN='(\.git|\.svn|\.hg|node_modules|vendor|bower_components|__pycache__|\.venv|venv|\.env|\.tox|\.pytest_cache|\.mypy_cache|dist|build|target|out|\.next|\.nuxt|\.output|\.idea|\.vscode|\.vs|\.eclipse|\.settings|\.DS_Store|Thumbs\.db|\.cache|\.tmp|tmp|temp|\.temp|coverage|\.nyc_output|\.turbo)'

# Watch for file changes and index them
inotifywait -m -r /workspace \
    -e close_write,move \
    --format '%w%f' \
    --exclude "$EXCLUDE_PATTERN" |
while read -r file_path; do
    # Index the file directly
    kb index "$file_path" 2>&1 | grep -v "^$" || true
done
