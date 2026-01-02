# Debian-based image for pre-built wheels (temporalio, psutil, etc.)
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    gcc \
    libc6-dev \
    libffi-dev \
    libfreetype6-dev \
    python3-dev \
    # WeasyPrint PDF generation
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libgdk-pixbuf2.0-0 \
    fontconfig \
    fonts-dejavu \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (before copying app code for better caching)
COPY pyproject.toml uv.lock ./
ENV UV_LINK_MODE=copy
RUN --mount=type=cache,id=uv-bookworm,target=/root/.cache/uv uv sync --locked --quiet

# Copy application code
COPY . .

# Runtime configuration
ENV ENV_MODE=production \
    PYTHONPATH=/app

EXPOSE 8000

# Gunicorn with Uvicorn workers
# WORKERS, THREADS, WORKER_CONNECTIONS set by runtime environment (ECS/docker-compose)
CMD ["sh", "-c", "uv run gunicorn api:app \
    --workers ${WORKERS:-4} \
    --threads ${THREADS:-2} \
    --worker-class uvicorn.workers.UvicornWorker \
    --worker-connections ${WORKER_CONNECTIONS:-1000} \
    --worker-tmp-dir /dev/shm \
    --bind 0.0.0.0:8000 \
    --timeout 1800 \
    --graceful-timeout 600 \
    --keep-alive 1800 \
    --forwarded-allow-ips '*' \
    --preload \
    --log-level info \
    --access-logfile - \
    --error-logfile -"]
