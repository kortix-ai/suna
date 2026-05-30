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
ENV PATH=/usr/local/bin:/opt/supabase:/root/.bun/bin:$PATH

# ── Base toolchain ────────────────────────────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg unzip xz-utils \
        build-essential python3 pkg-config \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# ── Node 22 + pnpm (standalone tarball, NOT apt) ───────────────────────────
# Node 22 matches CI (.github node-version: 22). Install the official tarball
# into /usr/local — NOT via apt/NodeSource — because the Kortix runtime layer
# is appended on top and runs `apt-get install nodejs npm`; a NodeSource
# `nodejs` (which bundles npm) Conflicts with the distro `npm` package → "held
# broken packages" and the snapshot build fails. The tarball leaves apt's
# nodejs/npm untouched (layer installs the distro ones into /usr/bin) while our
# /usr/local/bin/node (22) wins on PATH. pnpm is pinned to the repo's
# packageManager (pnpm@8.11.0); pnpm@latest needs Node ≥22.13 and would break.
RUN NODE_TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ \
        | grep -oE 'node-v22[0-9.]*-linux-x64\.tar\.xz' | head -1)" \
    && curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODE_TARBALL}" \
        | tar -xJ -C /usr/local --strip-components=1 \
    && corepack enable \
    && corepack prepare pnpm@8.11.0 --activate \
    && node -v && pnpm -v

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
# Extract the WHOLE release tarball into /opt/supabase and put it on PATH.
# The tarball's `supabase` is a shim that forwards to a sibling `supabase-go`
# binary, so you must keep them together — extracting only `supabase` (or
# moving it alone) breaks `supabase start` with "supabase-go not found".
RUN ARCH="$(dpkg --print-architecture)" \
    && mkdir -p /opt/supabase \
    && curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${ARCH}.tar.gz" \
        | tar -xz -C /opt/supabase \
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
