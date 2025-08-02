# ============================================
# Stage 1: Build Dependencies (includes build tools)
# ============================================
FROM ghcr.io/astral-sh/uv:python3.11-alpine AS builder

WORKDIR /app

# Install build dependencies (only in builder stage)
RUN apk add --no-cache \
    curl \
    git \
    rust \
    cargo \
    build-base \
    libffi-dev

# Copy dependency files
COPY pyproject.toml uv.lock ./

# Install dependencies (this creates a virtual environment)
ENV UV_LINK_MODE=copy
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --quiet

# ============================================
# Stage 2: Production Runtime (minimal)
# ============================================
FROM ghcr.io/astral-sh/uv:python3.11-alpine AS production

ENV ENV_MODE=production
WORKDIR /app

# Install only runtime dependencies (no build tools!)
RUN apk add --no-cache curl git

# Copy the built virtual environment from builder stage
COPY --from=builder /app/.venv /app/.venv

# Copy application code
COPY . .

# Calculate optimal worker count based on 16 vCPUs
# Using (2*CPU)+1 formula for CPU-bound applications
ENV WORKERS=7
ENV THREADS=2
ENV WORKER_CONNECTIONS=2000

ENV PYTHONPATH=/app
EXPOSE 8000

# Dynamic worker configuration
CMD ["sh", "-c", "\
  CPUS=$(nproc) && \
  CALCULATED_WORKERS=$((2 * CPUS + 1)) && \
  WORKERS=${WORKERS:-$CALCULATED_WORKERS} && \
  if [ $WORKERS -gt 33 ]; then WORKERS=33; fi && \
  echo \"Starting with $WORKERS workers on $CPUS CPUs\" && \
  python -m gunicorn api:app \
    --workers $WORKERS \
    --worker-class uvicorn.workers.UvicornWorker \
    --bind 0.0.0.0:8000 \
    --timeout 1800 \
    --graceful-timeout 600 \
    --keep-alive 1800 \
    --max-requests 0 \
    --max-requests-jitter 0 \
    --forwarded-allow-ips '*' \
    --worker-connections ${WORKER_CONNECTIONS:-2000} \
    --worker-tmp-dir /dev/shm \
    --preload \
    --log-level info \
    --access-logfile - \
    --error-logfile - \
    --capture-output \
    --enable-stdio-inheritance \
    --threads ${THREADS:-2} \
"]