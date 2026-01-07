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

# Production: Gunicorn with async workers
# WORKERS=16 for 32 vCPU server (2 workers per core, capped at 16)
# Each worker = separate process = separate HTTP/2 connection = 100 more concurrent streams
ENV WORKERS=16
ENV TIMEOUT=300

CMD ["sh", "-c", "uv run gunicorn api:app -w ${WORKERS} -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000 --timeout ${TIMEOUT} --graceful-timeout 30 --keep-alive 65"]
