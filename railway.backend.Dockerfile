# Railway-optimized Backend API Dockerfile
# Optimized for lower-spec cloud instances with dynamic worker scaling

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
RUN --mount=type=cache,id=uv-backend,target=/root/.cache/uv \
    uv sync --locked --quiet

# Copy application code
COPY backend/ .

# Dynamic worker configuration for Railway
# Railway provides CPU count via nproc, we'll calculate at runtime
# Default to conservative settings for smaller instances
ENV MIN_WORKERS=2
ENV MAX_WORKERS=4
ENV THREADS=2
ENV WORKER_CONNECTIONS=1000

ENV PYTHONPATH=/app
EXPOSE 8000

# Health check for Railway
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

# Start script with dynamic worker calculation
# Formula: min(MAX_WORKERS, max(MIN_WORKERS, (CPU_COUNT * 2) + 1))
CMD sh -c '\
    CPU_COUNT=$(nproc); \
    CALCULATED_WORKERS=$(( (CPU_COUNT * 2) + 1 )); \
    if [ $CALCULATED_WORKERS -lt $MIN_WORKERS ]; then \
        WORKERS=$MIN_WORKERS; \
    elif [ $CALCULATED_WORKERS -gt $MAX_WORKERS ]; then \
        WORKERS=$MAX_WORKERS; \
    else \
        WORKERS=$CALCULATED_WORKERS; \
    fi; \
    echo "Starting with $WORKERS workers for $CPU_COUNT CPUs"; \
    uv run gunicorn api:app \
        --workers $WORKERS \
        --worker-class uvicorn.workers.UvicornWorker \
        --bind 0.0.0.0:8000 \
        --timeout 1800 \
        --graceful-timeout 300 \
        --keep-alive 600 \
        --max-requests 1000 \
        --max-requests-jitter 50 \
        --forwarded-allow-ips "*" \
        --worker-connections $WORKER_CONNECTIONS \
        --worker-tmp-dir /dev/shm \
        --preload \
        --log-level info \
        --access-logfile - \
        --error-logfile - \
        --capture-output \
        --enable-stdio-inheritance \
        --threads $THREADS'
