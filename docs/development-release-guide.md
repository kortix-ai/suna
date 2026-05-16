# Development & Release Guide

> How Suna is developed, built, and released.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Local Development](#local-development)
3. [Sandbox Dev Details](#sandbox-dev-details)
4. [CI/CD: Dev Line](#cicd-dev-line)
5. [CI/CD: Prod Line (Release)](#cicd-prod-line-release)
6. [Docker Hub Tags](#docker-hub-tags)
7. [Version Sources](#version-sources)
8. [Sandbox Images](#sandbox-images)
9. [Ports Reference](#ports-reference)
10. [Quick Reference](#quick-reference)

---

## Architecture Overview

### Three components

| Component | Image | Source | What it does |
|---|---|---|---|
| **API** | `kortix/kortix-api` | `apps/api/` | Backend API (Bun + Hono) |
| **Frontend** | `kortix/kortix-frontend` | `apps/web/` | Next.js web app |
| **Sandbox** | `kortix/sandbox` | `apps/sandbox/` | Project-session sandbox image |

### Two environments

| Environment | URL | API | Frontend | Sandbox provider |
|---|---|---|---|---|
| **Dev** | `dev.kortix.com` | `dev-api.kortix.com` (VPS) | Vercel (main branch) | `local_docker` for self-host/dev, Daytona for cloud rehearsal |
| **Prod** | `kortix.com` | `new-api.kortix.com` (VPS) | Vercel (production branch) | Daytona |

### Single registry

All Docker images live on **Docker Hub** in the `kortix/` namespace.

---

## Local Development

```bash
# 1. Start Supabase
supabase start
supabase status -o env  # copy values into apps/api/.env and apps/web/.env.local

# 2. Start dev servers (frontend + API)
pnpm dev

# 3. Build the sandbox image (optional — only when testing local_docker sessions)
pnpm dev:sandbox
```

### Individual services

```bash
pnpm dev:frontend   # Next.js on http://localhost:3000
pnpm dev:api        # kortix-api on http://localhost:8008
pnpm dev            # Both at once
pnpm dev:sandbox    # Build kortix/sandbox:dev for local_docker sessions
```

---

## Sandbox Dev Details

### Local image model

There is no long-running `core/docker` sandbox stack anymore. `apps/sandbox`
builds a provider-neutral image that contains the compiled sandbox daemon,
OpenCode, git, curl, and CA certificates. The API's `local_docker` provider
starts one container per project session from that image.

### When to rebuild

You **do not** need to rebuild for:
- Project repo content changes. New sessions clone the Git branch at runtime.
- Editing agents, skills, tools, or prompts in the project repo.

You **do** need `pnpm dev:sandbox` when:
- `apps/sandbox/Dockerfile` changes.
- `apps/sandbox/entrypoint.sh` changes.
- `apps/kortix-sandbox-agent-server/**` changes.
- The sandbox daemon lockfile changes.

### Restarting services inside the container

```bash
docker exec kortix-sandbox s6-svc -r /run/service/svc-kortix-master
docker exec -it kortix-sandbox bash
```

### Health check

```bash
curl http://127.0.0.1:14000/kortix/health
```

---

## CI/CD: Dev Line

**Workflow:** `.github/workflows/deploy-dev.yml`

### Triggers

- **Push to `main`** — gated by the repo variable `AUTO_DEPLOY_DEV`
  - Set to `true` to auto-deploy on every push
  - Set to `false` (default) to skip push-triggered deploys
- **Manual dispatch** — always runs, builds all 3 components regardless of `AUTO_DEPLOY_DEV`

### How it works

```
push to main (if AUTO_DEPLOY_DEV=true) OR manual dispatch
  │
  ├─► detect-changes (path filter)
  │     API:      apps/api/**, packages/**, pnpm-lock.yaml
  │     Frontend: apps/web/**, packages/shared/**
  │     Computer: core/**
  │
  ├─► build-api-amd64   (ubuntu-latest)      │
  ├─► build-api-arm64   (ubuntu-24.04-arm)   │  parallel native builds
  ├─► build-frontend-amd64                   │  (NO QEMU)
  ├─► build-frontend-arm64                   │
  ├─► build-sandbox-amd64                    │
  └─► build-sandbox-arm64                    ┘
        │
        ├─► merge-api       → kortix/kortix-api:dev-{sha8} + :dev-latest (multi-arch)
        ├─► merge-frontend  → kortix/kortix-frontend:dev-{sha8} + :dev-latest
        └─► merge-sandbox   → kortix/sandbox:dev-{sha8} + :dev-latest
              │
              └─► deploy-api → SSH to dev VPS → blue/green deploy
```

### Managing the auto-deploy gate

```bash
# Enable auto-deploy on push to main
gh variable set AUTO_DEPLOY_DEV --repo kortix-ai/suna --body true

# Disable
gh variable set AUTO_DEPLOY_DEV --repo kortix-ai/suna --body false

# Check current value
gh variable list --repo kortix-ai/suna
```

### Trigger a dev deploy manually

```bash
gh workflow run deploy-dev.yml --repo kortix-ai/suna
```

### Sandbox image

Dev sandbox images are built by `deploy-dev.yml` from `apps/sandbox/Dockerfile`
whenever `apps/sandbox/**`, `apps/kortix-sandbox-agent-server/**`, or shared
workspace dependencies change. The legacy snapshot workflow is intentionally
disabled for repo-first v1.

---

## CI/CD: Prod Line (Release)

**Workflow:** `.github/workflows/release.yml`

### Trigger

Manual only. Go to GitHub Actions → "Release Version" → Run workflow.

**Inputs:**
- `version` — e.g. `0.8.30`
- `title` — release title, e.g. `"Streaming fixes, new onboarding"`
- `description` — optional multi-line description

### How it works

```
Run workflow (version=0.8.30)
  │
  ├─► retag-images (30 sec — NO REBUILD)
  │     docker buildx imagetools create \
  │       kortix/kortix-api:0.8.30 ← kortix/kortix-api:dev-latest
  │     (same for frontend + sandbox)
  │     Also tags as :latest
  │
  ├─► deploy-prod → SSH to prod VPS → blue/green deploy
  ├─► update-production-branch → fast-forward production branch → Vercel deploys kortix.com
  └─► create-release → git tag + GitHub Release with auto-changelog
```

### Key insight: no rebuild

Prod promotion re-tags the multi-arch manifests that were already built on the dev line. **No code is rebuilt.** The exact bytes that were tested on dev go to prod.

### Required secrets

- `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` — Docker Hub push
- `PROD_HOST`, `PROD_USERNAME`, `PROD_KEY` — SSH to prod VPS
- `GH_RELEASE_PAT` — PAT with `workflow` scope (needed to push workflow files to the `production` branch; `GITHUB_TOKEN` alone cannot)

---

## Docker Hub Tags

All images live in the `kortix/` Docker Hub namespace.

### Tag convention

| Tag | Meaning |
|---|---|
| `dev-{sha8}` | Specific dev build from commit `{sha8}` (multi-arch) |
| `dev-latest` | Points to the current dev line state |
| `0.8.30` | A released version (multi-arch) |
| `latest` | Latest released version |

### Images

| Image | Component |
|---|---|
| `kortix/kortix-api` | Backend API |
| `kortix/kortix-frontend` | Next.js frontend |
| `kortix/sandbox` | Project-session sandbox image |

All images are **multi-arch (amd64 + arm64)**. Works on x86 servers and Apple Silicon / ARM machines.

---

## Version Sources

Single source of truth per component:

| Component | How version is set | Where it's read |
|---|---|---|
| **API** (`kortix-api`) | `SANDBOX_VERSION` env var injected by `deploy-zero-downtime.sh` from image tag | `config.SANDBOX_VERSION`, `/health` endpoint, `/v1/platform/sandbox/version` |
| **Sandbox** (`kortix/sandbox`) | Image tag selected by Daytona snapshot or `KORTIX_LOCAL_DOCKER_IMAGE` | Sandbox daemon `/health` endpoint |
| **Frontend** | Not tracked (Vercel deployment hashes) | — |

### Version endpoints

```bash
# Current running API version
GET /v1/platform/sandbox/version

# Latest available version (channel: stable|dev)
GET /v1/platform/sandbox/version/latest?channel=stable
GET /v1/platform/sandbox/version/latest?channel=dev

# All installable versions (both channels)
GET /v1/platform/sandbox/version/all

# Unified changelog
GET /v1/platform/sandbox/version/changelog
```

**Stable versions** come from the GitHub Releases API.
**Dev versions** come from the Docker Hub Tags API (only shows tags that actually exist as images).

No JSON files, no manual changelog entries.

### Changelog page

`/changelog` in the web app shows all versions. Users can click "Install" on any version to update their sandbox. Dev builds are hidden behind a subtle toggle by default.

---

## Sandbox Images

`kortix/sandbox` is the provider-neutral runtime image. It contains the sandbox
daemon, OpenCode, git, curl, and CA certificates. Cloud runs it through the
configured Daytona image path; self-host/dev uses the same image through the
`local_docker` provider.

The legacy snapshot workflow remains in the repository only as a fail-closed
guard. Do not use it for v1 releases.

---

## Ports Reference

All ports are on `127.0.0.1` in dev (no public exposure).

| Host port | Container port | Service |
|---|---|---|
| `14000` | `8000` | Kortix Master (proxy entry point) |
| `14001` | `3111` | OpenCode Web UI |
| `14002` | `6080` | Desktop (noVNC HTTP) |
| `14003` | `6081` | Desktop (noVNC HTTPS) |
| `14004` | `3210` | Presentation Viewer |
| `14005` | `9223` | Agent Browser Stream (WebSocket) |
| `14006` | `9224` | Agent Browser Viewer |
| `14007` | `22` | SSH |
| `14008` | `3211` | Static Web Server |

---

## Quick Reference

### Local dev

```bash
supabase start
pnpm dev                  # frontend + API
pnpm dev:sandbox          # build sandbox image for local_docker sessions
```

### Health checks

```bash
curl http://127.0.0.1:14000/kortix/health         # local sandbox
curl https://dev-api.kortix.com/v1/platform/sandbox/version   # dev API
curl https://new-api.kortix.com/v1/platform/sandbox/version   # prod API
```

### CI/CD operations

```bash
# Trigger a dev deploy manually (builds all 3 components)
gh workflow run deploy-dev.yml --repo kortix-ai/suna

# Enable/disable auto-deploy on push to main
gh variable set AUTO_DEPLOY_DEV --repo kortix-ai/suna --body true
gh variable set AUTO_DEPLOY_DEV --repo kortix-ai/suna --body false

# Promote to production
gh workflow run release.yml --repo kortix-ai/suna \
  -f version="0.8.30" \
  -f title="Your release title" \
  -f description="Optional longer description"
```

### Sandbox container operations

```bash
docker exec kortix-sandbox s6-svc -r /run/service/svc-kortix-master
docker exec -it kortix-sandbox bash
docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .
```
