# Railway-optimized Worker Dockerfile
# Dramatiq background worker for async task processing

FROM ghcr.io/astral-sh/uv:python3.11-alpine

ENV ENV_MODE=production
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    curl \
    git \
    freetype-dev \
    gcc \
    musl-dev \
    python3-dev \
    bash

# Install Python dependencies with caching
COPY backend/pyproject.toml backend/uv.lock ./
ENV UV_LINK_MODE=copy
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --quiet

# Copy application code
COPY backend/ .

# Dynamic worker configuration for Railway
# Adjust based on available resources
ENV MIN_PROCESSES=2
ENV MAX_PROCESSES=4
ENV THREADS_PER_PROCESS=4

ENV PYTHONPATH=/app

# Health check - check if dramatiq process is running
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD pgrep -f dramatiq || exit 1

# Start dramatiq with dynamic process calculation
CMD sh -c '\
    CPU_COUNT=$(nproc); \
    CALCULATED_PROCESSES=$(( CPU_COUNT > 1 ? CPU_COUNT : 2 )); \
    if [ $CALCULATED_PROCESSES -lt $MIN_PROCESSES ]; then \
        PROCESSES=$MIN_PROCESSES; \
    elif [ $CALCULATED_PROCESSES -gt $MAX_PROCESSES ]; then \
        PROCESSES=$MAX_PROCESSES; \
    else \
        PROCESSES=$CALCULATED_PROCESSES; \
    fi; \
    echo "Starting Dramatiq worker with $PROCESSES processes and $THREADS_PER_PROCESS threads each for $CPU_COUNT CPUs"; \
    uv run dramatiq \
        --skip-logging \
        --processes $PROCESSES \
        --threads $THREADS_PER_PROCESS \
        run_agent_background'
