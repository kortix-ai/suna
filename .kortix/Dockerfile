# syntax=docker/dockerfile:1.7
#
# Project sandbox base image — a FULL dev box for the suna monorepo.
#
# Daytona sandboxes are microVMs (real kernel + KVM), so Docker runs natively
# inside. That means a session can run the entire local stack exactly like a
# human does on their laptop:  dockerd → `supabase start` (Postgres + the
# Supabase services as containers) → API + web via `pnpm dev`. Everything is
# self-contained on localhost *inside* the sandbox — no hosted DB, no tunnels
# for the app itself.
#
# Kortix layers its agent daemon + opencode CLI + kortix CLI on top of this.
#
# Docs: https://docs.kortix.ai/projects/sandbox

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/usr/local/bin:/root/.bun/bin:$PATH

# ── Base toolchain ────────────────────────────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg unzip xz-utils \
        build-essential python3 pkg-config \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# ── Node 20 + pnpm (via corepack) ─────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && corepack prepare pnpm@latest --activate \
    && rm -rf /var/lib/apt/lists/*

# ── Bun (the API runs on Bun) ──────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# ── Docker engine — for `supabase start` (the stack is containers) ─────────
# Daytona's microVM has its own kernel, so the in-VM dockerd is a real Docker
# daemon (not dind). The `with-dockerd` helper (below) starts it on demand.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# ── Supabase CLI ───────────────────────────────────────────────────────────
RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${ARCH}.tar.gz" \
        -o /tmp/supabase.tar.gz \
    && tar -xzf /tmp/supabase.tar.gz -C /usr/local/bin supabase \
    && rm /tmp/supabase.tar.gz \
    && supabase --version

# ── dockerd bootstrap helper ───────────────────────────────────────────────
# Idempotently start the Docker daemon and wait for the socket, then exec the
# rest of the command. Use as:  with-dockerd supabase start
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -e' \
    'if ! docker info >/dev/null 2>&1; then' \
    '  (dockerd >/var/log/dockerd.log 2>&1 &)' \
    '  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done' \
    'fi' \
    'exec "$@"' \
    > /usr/local/bin/with-dockerd \
    && chmod +x /usr/local/bin/with-dockerd

WORKDIR /workspace
