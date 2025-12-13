#!/bin/bash
# Wrapper script to set library paths for WeasyPrint on macOS

# Set library path for Homebrew libraries on macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
    BREW_PREFIX=$(brew --prefix 2>/dev/null)
    if [ -n "$BREW_PREFIX" ]; then
        export DYLD_FALLBACK_LIBRARY_PATH="${BREW_PREFIX}/lib:${DYLD_FALLBACK_LIBRARY_PATH:-}"
        echo "[INFO] Set DYLD_FALLBACK_LIBRARY_PATH to: ${DYLD_FALLBACK_LIBRARY_PATH}"
    else
        echo "[WARNING] Homebrew not found. WeasyPrint may not work."
    fi
fi

# Run the API with uv
exec uv run api.py "$@"
