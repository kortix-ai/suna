FROM python:3.11-slim-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    netcat-traditional \
    gnupg \
    curl \
    unzip \
    zip \
    xvfb \
    libgconf-2-4 \
    libxss1 \
    libnss3 \
    libnspr4 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    fonts-liberation \
    dbus \
    xauth \
    xvfb \
    x11vnc \
    tigervnc-tools \
    supervisor \
    net-tools \
    procps \
    git \
    python3-numpy \
    fontconfig \
    fonts-dejavu \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    tmux \
    # PDF Processing Tools
    poppler-utils \
    wkhtmltopdf \
    # Document Processing Tools
    antiword \
    unrtf \
    catdoc \
    # Text Processing Tools
    grep \
    gawk \
    sed \
    # Math/Calculator Tools
    bc \
    # File Analysis Tools
    file \
    # Data Processing Tools
    jq \
    csvkit \
    xmlstarlet \
    # Additional Utilities
    less \
    vim \
    tree \
    rsync \
    lsof \
    iputils-ping \
    dnsutils \
    sudo \
    # OCR Tools
    tesseract-ocr \
    tesseract-ocr-eng \
    # File system monitoring
    inotify-tools \
    # SSL/TLS support
    openssl \
    && rm -rf /var/lib/apt/lists/* \
    && update-ca-certificates \
    && mkdir -p /etc/ssl/certs \
    && ln -sf /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-bundle.crt \
    && echo "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt" >> /etc/environment \
    && echo "SSL_CERT_DIR=/etc/ssl/certs" >> /etc/environment \
    && echo "ca_directory=/etc/ssl/certs" > /etc/wgetrc \
    && echo "ca_certificate=/etc/ssl/certs/ca-certificates.crt" >> /etc/wgetrc \
    && chmod 644 /etc/wgetrc

# Install Node.js and npm (primary package manager)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest

# Also install pnpm as optional package manager
RUN corepack enable \
    && corepack prepare pnpm@9.1.0 --activate

# pnpm config and store dir for faster installs (if used)
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN pnpm config set store-dir /root/.pnpm-store

# Install noVNC
RUN git clone https://github.com/novnc/noVNC.git /opt/novnc \
    && git clone https://github.com/novnc/websockify /opt/novnc/utils/websockify \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html


# Clone Anthropics skills repository with sparse checkout
# This downloads only the slack-gif-creator, algorithmic-art, and webapp-testing skills to /skills
# Each skill is moved as a complete directory to maintain its structure (including SKILL.md)
RUN mkdir -p /tmp/skills-clone \
    && cd /tmp/skills-clone \
    && git clone --no-checkout --filter=blob:none --depth 1 https://github.com/anthropics/skills.git . \
    && git sparse-checkout init --cone \
    && git sparse-checkout set skills/algorithmic-art skills/webapp-testing skills/slack-gif-creator \
    && git checkout main \
    && echo "=== Checking sparse checkout structure ===" \
    && ls -la skills/ 2>/dev/null || echo "WARNING: skills/ directory not found" \
    && ls -la skills/algorithmic-art/ 2>/dev/null | head -5 || echo "WARNING: algorithmic-art not found" \
    && ls -la skills/webapp-testing/ 2>/dev/null | head -5 || echo "WARNING: webapp-testing not found" \
    && ls -la skills/slack-gif-creator/ 2>/dev/null | head -5 || echo "WARNING: slack-gif-creator not found" \
    && mkdir -p /skills \
    && test -d skills/algorithmic-art && mv skills/algorithmic-art /skills/ || (echo "ERROR: algorithmic-art directory missing" && exit 1) \
    && test -d skills/webapp-testing && mv skills/webapp-testing /skills/ || (echo "ERROR: webapp-testing directory missing" && exit 1) \
    && test -d skills/slack-gif-creator && mv skills/slack-gif-creator /skills/ || (echo "ERROR: slack-gif-creator directory missing" && exit 1) \
    && rm -rf /tmp/skills-clone \
    && echo "=== Skills installed in /skills ===" && ls -la /skills \
    && echo "=== Verifying skill directory structures ===" \
    && echo "algorithmic-art contents:" && find /skills/algorithmic-art -type f | head -10 \
    && echo "webapp-testing contents:" && find /skills/webapp-testing -type f | head -10 \
    && echo "slack-gif-creator contents:" && find /skills/slack-gif-creator -type f | head -10 \
    && echo "=== Verifying SKILL.md files ===" \
    && test -f /skills/algorithmic-art/SKILL.md && echo "  ✓ algorithmic-art/SKILL.md" || (echo "  ✗ algorithmic-art/SKILL.md missing" && exit 1) \
    && test -f /skills/webapp-testing/SKILL.md && echo "  ✓ webapp-testing/SKILL.md" || (echo "  ✗ webapp-testing/SKILL.md missing" && exit 1) \
    && test -f /skills/slack-gif-creator/SKILL.md && echo "  ✓ slack-gif-creator/SKILL.md" || (echo "  ✗ slack-gif-creator/SKILL.md missing" && exit 1) \
    && echo "=== Verifying file counts ===" \
    && echo "  algorithmic-art: $(find /skills/algorithmic-art -type f | wc -l) files" \
    && echo "  webapp-testing: $(find /skills/webapp-testing -type f | wc -l) files" \
    && echo "  slack-gif-creator: $(find /skills/slack-gif-creator -type f | wc -l) files" \
    && echo "=== Verifying directory structure ===" \
    && test -d /skills/algorithmic-art && echo "  ✓ algorithmic-art directory exists" || (echo "  ✗ algorithmic-art directory missing" && exit 1) \
    && test -d /skills/webapp-testing && echo "  ✓ webapp-testing directory exists" || (echo "  ✗ webapp-testing directory missing" && exit 1) \
    && test -d /skills/slack-gif-creator && echo "  ✓ slack-gif-creator directory exists" || (echo "  ✗ slack-gif-creator directory missing" && exit 1) \
    && echo "=== All skills verified successfully ==="

# Set platform for ARM64 compatibility
ARG TARGETPLATFORM=linux/amd64

# Set up working directory
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright and browsers with system dependencies
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Then install dependencies and browsers
RUN npx playwright install-deps
RUN npx playwright install chromium
# Verify installation
RUN node -e "import('playwright').then(() => console.log('Playwright installation verified')).catch(e => { console.error('Playwright verification failed:', e); process.exit(1); })"

# Copy server script and file watcher
COPY . /app
COPY server.py /app/server.py
RUN chmod +x /app/file_watcher.sh

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV CHROME_PATH=/ms-playwright/chromium-*/chrome-linux/chrome
ENV ANONYMIZED_TELEMETRY=false
ENV DISPLAY=:99
ENV RESOLUTION=1024x768x24
ENV VNC_PASSWORD=vncpassword
ENV CHROME_PERSISTENT_SESSION=true
ENV RESOLUTION_WIDTH=1024
ENV RESOLUTION_HEIGHT=768
ENV VITE_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=2048
# SSL/TLS certificate paths
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
# Add Chrome flags to prevent multiple tabs/windows
ENV CHROME_FLAGS="--single-process --no-first-run --no-default-browser-check --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-breakpad --disable-component-extensions-with-background-pages --disable-dev-shm-usage --disable-extensions --disable-features=TranslateUI --disable-ipc-flooding-protection --disable-renderer-backgrounding --enable-features=NetworkServiceInProcess2 --force-color-profile=srgb --metrics-recording-only --mute-audio --no-sandbox --disable-gpu"

# Set up supervisor configuration
RUN mkdir -p /var/log/supervisor
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 7788 6080 5901 8000 8004 8080 5173 4173

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]