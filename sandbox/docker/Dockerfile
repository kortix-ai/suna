FROM node:20-slim

RUN apt-get update && apt-get install -y git supervisor curl unzip && rm -rf /var/lib/apt/lists/*

# Install Bun (required for OpenCode plugins and Kortix Master)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash

# --- Kortix Master (single source of truth) ---
WORKDIR /app

# Install deps first (layer caching)
COPY kortix-master/package.json /app/kortix-master/package.json
RUN cd /app/kortix-master && bun install

# Copy everything from kortix-master (includes agents/, plugin/, src/)
COPY kortix-master/ /app/kortix-master/

# Install agents into OpenCode config
RUN mkdir -p /root/.config/opencode/agents && \
    cp -r /app/kortix-master/agents/* /root/.config/opencode/agents/

# Install plugin into OpenCode config
RUN mkdir -p /root/.config/opencode/plugin && \
    cp /app/kortix-master/plugin/kortix.ts /root/.config/opencode/plugin/kortix.ts

# Plugin needs deps in opencode config dir
RUN cp /app/kortix-master/package.json /root/.config/opencode/package.json && \
    cd /root/.config/opencode && bun install

# Create secrets directory with proper permissions
RUN mkdir -p /app/secrets && chmod 700 /app/secrets

# Supervisor and workspace setup
RUN mkdir -p /workspace /var/log/supervisor /var/run
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Initialize /workspace as git repo so OpenCode uses it as project directory
WORKDIR /workspace
RUN git config --global user.email "opencode@kortix.ai" && \
    git config --global user.name "OpenCode" && \
    git init && \
    git commit --allow-empty -m "Initial commit"

# Only expose Kortix Master - it proxies to OpenCode internally
EXPOSE 8000

# Start supervisord
CMD ["sh", "-c", "cd / && /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf"]
