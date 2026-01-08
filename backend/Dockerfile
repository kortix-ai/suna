FROM ghcr.io/astral-sh/uv:python3.11-alpine

ENV ENV_MODE production
WORKDIR /app

RUN apk add --no-cache curl git \
    # Dependencies for Python package compilation
    freetype-dev \
    gcc \
    linux-headers \
    musl-dev \
    python3-dev \
    # Dependencies for WeasyPrint (PDF generation)
    pango \
    cairo \
    gdk-pixbuf \
    libffi \
    fontconfig \
    ttf-dejavu \
    ttf-liberation

# Install Python dependencies
COPY pyproject.toml uv.lock ./
ENV UV_LINK_MODE=copy
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --quiet

# Copy application code
COPY . .

ENV PYTHONPATH=/app
EXPOSE 8000

# WORKERS and TIMEOUT are set via env variables at runtime (ECS task definition)
# Defaults: WORKERS=4 (2 per vCPU), TIMEOUT=75 (worker heartbeat - async workers stay alive during active streams)
CMD ["sh", "-c", "uv run gunicorn api:app -w ${WORKERS:-4} -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000 --timeout ${TIMEOUT:-75} --graceful-timeout 30 --keep-alive 65"]
