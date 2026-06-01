<div align="center">

<img src="apps/web/public/Logomark.svg" alt="Kortix" width="96" />

# Kortix

**The AI command center for your company**

[![License: Elastic-2.0](https://img.shields.io/badge/License-Elastic--2.0-005571?style=for-the-badge&logo=elastic&logoColor=white)](LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-8.11-222?style=for-the-badge&logo=pnpm&logoColor=f69220)](package.json)
[![Next.js](https://img.shields.io/badge/Next.js-15-000?style=for-the-badge&logo=next.js&logoColor=white)](apps/web)
[![Bun](https://img.shields.io/badge/API-Bun-fbf0df?style=for-the-badge&logo=bun&logoColor=000)](apps/api)
[![OpenCode](https://img.shields.io/badge/Runtime-OpenCode-6366f1?style=for-the-badge)](.kortix/opencode)

One place where your context, agents, triggers, integrations, and memory live —  
and a workforce of AI agents does real work across your tools, around the clock.

[Website](https://kortix.com) · [Documentation](https://kortix.com/docs) · [Cloud](https://kortix.com) · [Pricing](https://kortix.com/pricing)


</div>

---

## Table of contents

- [What is Kortix?](#what-is-kortix)
- [What's in the command center](#whats-in-the-command-center)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Monorepo layout](#monorepo-layout)
- [Apps](#apps)
- [Packages](#packages)
- [Infrastructure & data](#infrastructure--data)
- [Develop locally](#develop-locally)
- [Test & verify](#test--verify)
- [Self-host](#self-host)
- [Enterprise & security](#enterprise--security)
- [License](#license)

---

## What is Kortix?

Most AI tools give you a chat box. Kortix gives you a **command center**: one place where your agents, skills, integrations, automations, and memory all live — and a workforce of AI agents that produces real output (decks, reports, code, replies, deployed work), not just chat.

It is **not** a chatbot, a copilot, or a single "AI employee." It's the operating layer for an AI-native company — accessible to anyone, owned by you.

## What's in the command center

| | |
| --- | --- |
| **Agents** | Your AI coworkers — one per role or task. |
| **Skills & workflows** | Reusable know-how that does a job your way. |
| **Integrations** | 3,000+ tools, connected once and shared across the org. |
| **Chat & sessions** | Where you and your team work with agents, live. |
| **Automations** | Triggers on a schedule, a webhook, or a chat message. |
| **Memory** | A living company brain that compounds over time. |

Work runs three ways: **on-demand** (ask in chat, get it now), **human-assisted** (the agent works and checks in for the calls that matter), and **automated** (runs on a schedule or trigger, end to end).

## How it works

A **Kortix project is one git repository** with a `kortix.toml` manifest at its root — the single source of truth for the whole company.

```
project  (git repo + kortix.toml)
   └─ session ──> isolated cloud sandbox on a branch named after the session
                     └─ agent (OpenCode) works, commits, pushes
                           └─ change request ──> you review & merge ──> main
```

| Concept | What it means |
| --- | --- |
| **Session** | One conversation = one disposable Linux sandbox on its own git branch. The VM dies when the session ends; the branch persists. |
| **Change request (CR)** | The only path from session work to `main`. Agents commit on the branch; you review and merge. |
| **Triggers** | Cron schedules and signed webhooks that spawn sessions automatically. |
| **Channels** | Slack (and more) connected to a project — the bot listens where you invite it. |
| **Connectors** | Server-brokered tool access (Pipedream, MCP, OpenAPI, GraphQL, HTTP) with per-user credentials. |
| **OpenCode runtime** | Engine- and provider-agnostic coding agent inside every sandbox. Config lives in `.kortix/opencode/`. |

Two configuration surfaces, strict ownership:

| Surface | Owner | Location |
| --- | --- | --- |
| Kortix config | Platform | `kortix.toml` + `.kortix/` |
| OpenCode config | Runtime | `.kortix/opencode/` (`opencode.jsonc`, agents, skills, commands, tools) |

Learn the model: **[Concepts](https://kortix.com/docs/concepts)** · **[Reference](https://kortix.com/docs/reference)** · **[Quickstart](https://kortix.com/docs/quickstart)**

## Quickstart

### Kortix Cloud — managed

Sign up at **[kortix.com](https://kortix.com)**, create a project, and start a session. Nothing to install.

### From the terminal — for builders

```bash
curl -fsSL https://kortix.com/install | bash   # install the kortix CLI
kortix login                                   # authorize in your browser

kortix init                                    # scaffold a project (kortix.toml + agent config)
kortix ship                                    # create the cloud project and push your repo
kortix sessions new --prompt "Summarize this week's commits and open a change request"
kortix cr ls                                   # review what the agent proposes — then merge to keep it
```

Full command surface: **[CLI reference](https://kortix.com/docs/reference/cli)**.

---

## Monorepo layout

This repository (`suna/`) is the **Kortix platform monorepo** — the web dashboard, API, CLI, sandbox runtime, shared libraries, and infrastructure. It is also a dogfood Kortix project (see root `kortix.toml`).

Managed with **pnpm 8** workspaces. Docker and cloud credentials are required for full sandbox flows.

```
suna/
├── apps/
│   ├── web/                        # Next.js dashboard + marketing + docs
│   ├── api/                        # Bun/Hono unified API monolith
│   ├── cli/                        # kortix CLI (init, ship, sessions, cr, self-host)
│   ├── sandbox/                    # Base Docker image for session sandboxes
│   ├── kortix-sandbox-agent-server/# kortix-agent daemon (OpenCode supervisor + proxy)
│   ├── mobile/                     # React Native / Expo mobile app
│   └── desktop/                    # Tauri 2 shell wrapping the web app
├── packages/
│   ├── db/                         # Drizzle ORM schemas + Postgres client
│   ├── shared/                     # Cross-app utilities, LLM catalog, tool icons
│   ├── starter/                    # Project scaffold templates (base, knowledge-worker)
│   ├── manifest-schema/            # kortix.toml validator
│   ├── executor-sdk/               # Connector executor client SDK
│   └── agent-tunnel/               # Cloud ↔ local machine tunnel relay
├── supabase/                       # Local Supabase config + SQL migrations
├── infra/terraform/                # AWS Lightsail API hosting (dev/prod)
├── tests/                          # E2E, Playwright, shell, security suites
├── scripts/                        # dev-local.sh, setup-env.sh, nuke-local.sh
├── .kortix/opencode/               # This repo's OpenCode agents, skills, commands
└── kortix.toml                     # Platform dogfood manifest (triggers, sandbox, connectors)
```

---

## Apps

### [`apps/web/`](apps/web/) — Dashboard & marketing

The primary user-facing surface. **Next.js 15** (Turbopack) on port **3000**.

| Area | Path / notes |
| --- | --- |
| Marketing & landing | `src/app/(home)/` — home, pricing, about |
| Authenticated app | `src/app/dashboard/`, `src/app/projects/`, `src/app/accounts/` |
| Session UI | Real-time chat, tool views, file browser, terminal, previews |
| Docs (MDX) | `content/docs/` — rendered at `/docs` |
| Design system | `src/components/ui/` + live `/design-system` page |
| i18n | `next-intl` — locale files under `src/i18n/` |

```bash
pnpm dev:web          # http://localhost:3000
pnpm --filter Kortix-Computer-Frontend build
pnpm --filter Kortix-Computer-Frontend test:e2e
```

Env: `apps/web/.env` — Supabase anon key, `NEXT_PUBLIC_BACKEND_URL=http://localhost:8008/v1`.

---

### [`apps/api/`](apps/api/) — Unified API

**Bun + Hono** monolith on port **8008**. One process handles routing, billing, projects, sandboxes, triggers, and more.

| Module | Route prefix | Responsibility |
| --- | --- | --- |
| Projects | `/v1/projects` | Git-backed projects, sessions, CRs, provisioning |
| Router / LLM | `/v1/router` | Chat completions, models, web search, provider routing |
| Sandbox proxy | `/v1/p/:ext/...` | Reverse-proxy into Daytona sandboxes (OpenCode SSE at `…/8000/event`) |
| Billing | `/v1/billing` | Stripe, credits, account state |
| Executor | `/v1/executor` | Connector calls (GitHub, Pipedream, MCP, OpenAPI) |
| Webhooks | `/v1/webhooks` | Project triggers, Slack, Telegram |
| Tunnel | `/v1/tunnel` | Agent tunnel relay (local machine access) |
| Accounts / IAM | `/v1/accounts`, `/v1/access` | Orgs, invites, RBAC, SCIM |
| Platform | `/v1/platform` | Health, sandbox version, ops |

```bash
pnpm dev:api          # hot reload via bun --hot
pnpm --filter kortix-api test
curl -s localhost:8008/v1/health
```

Env: `apps/api/.env` — Supabase service role, `DAYTONA_API_KEY`, Stripe, provider keys.

Background workers started at boot: trigger scheduler, snapshot builder, legacy migration, queue drainer, tunnel service, access-control cache.

---

### [`apps/cli/`](apps/cli/) — `kortix` CLI

The developer-facing control plane. Scaffold projects, manage secrets, spawn sessions, open change requests, and run self-hosted stacks.

```bash
kortix init                    # new project from template
kortix ship                    # push repo → cloud project
kortix sessions new --prompt "…"
kortix secrets set KEY=val
kortix cr open --title "…"
kortix self-host start         # Docker-based local cloud
kortix hosts use local|cloud
```

Build: `pnpm cli:bundle` · Docs: [`apps/cli/README.md`](apps/cli/README.md)

---

### [`apps/sandbox/`](apps/sandbox/) + [`apps/kortix-sandbox-agent-server/`](apps/kortix-sandbox-agent-server/)

The **session runtime stack**.

| Piece | Role |
| --- | --- |
| `apps/sandbox/Dockerfile` | Reference image: git, OpenCode CLI, `kortix-agent` binary |
| `kortix-sandbox-agent-server` | Daemon: supervises `opencode serve`, reverse-proxies `:8000`, serves static previews on `:3211` |
| Snapshot builder (`apps/api/src/snapshots/`) | Layers each project's `.kortix/Dockerfile` onto the Kortix runtime → per-project Daytona snapshot |

```bash
pnpm dev:sandbox    # docker build -f apps/sandbox/Dockerfile -t kortix/kortix-sandbox:dev .
```

Each session: `session_id == sandbox_id`. OpenCode is reached via API proxy at `http://localhost:8008/v1/p/<external_id>/8000/…`.

---

### [`apps/mobile/`](apps/mobile/) — Mobile app

**React Native / Expo** companion for chat, sessions, triggers, billing, and settings on iOS and Android.

```bash
pnpm dev:mobile
```

---

### [`apps/desktop/`](apps/desktop/) — Desktop shell

**Tauri 2** WebView wrapper around the web app. Detects `KortixDesktop/` user-agent and renders a native titlebar. No separate frontend bundle.

```bash
pnpm dev:web          # terminal 1
pnpm dev:desktop      # terminal 2 — loads http://localhost:3000
```

See [`apps/desktop/README.md`](apps/desktop/README.md) for signing, icons, and release builds.

---

## Packages

| Package | Name | Purpose |
| --- | --- | --- |
| [`packages/db/`](packages/db/) | `@kortix/db` | Drizzle schemas, Postgres client, migration helpers |
| [`packages/shared/`](packages/shared/) | `@kortix/shared` | Shared utils, LLM model catalog, tool icon keys |
| [`packages/starter/`](packages/starter/) | `@kortix/starter` | Project templates (`base`, `general-knowledge-worker`) for `kortix init` |
| [`packages/manifest-schema/`](packages/manifest-schema/) | `@kortix/manifest-schema` | Canonical `kortix.toml` parser + validator |
| [`packages/executor-sdk/`](packages/executor-sdk/) | `@kortix/executor-sdk` | Client SDK for connector executor calls |
| [`packages/agent-tunnel/`](packages/agent-tunnel/) | `@kortix/agent-tunnel` | WebSocket tunnel relay (cloud agents ↔ local machines) |

---

## Infrastructure & data

| Layer | Location | Notes |
| --- | --- | --- |
| **Database** | `supabase/` + `@kortix/db` | Local Supabase on `http://127.0.0.1:54321` (Docker). Migrations in `supabase/migrations/`. |
| **Sandboxes** | Daytona (cloud) | Real VMs per session. Requires `DAYTONA_API_KEY` in `apps/api/.env`. |
| **Dev tunnel** | `scripts/dev-local.sh` | Auto-starts cloudflared so sandboxes can call back to local API (`KORTIX_URL`). |
| **Terraform** | `infra/terraform/` | AWS Lightsail API boxes (dev/prod). Frontend on Vercel. See [`infra/terraform/README.md`](infra/terraform/README.md). |
| **OpenCode config** | `.kortix/opencode/` | Agents (`pr-bot`, `kortix`), skills, commands, MCP servers for this repo |

---

## Develop locally

### Prerequisites

- **Node.js 20+** and **pnpm 8**
- **Bun** (API runtime)
- **Docker** (local Supabase + optional sandbox builds)
- **cloudflared** (auto-installed by dev script for Daytona callback tunnel)
- **`DAYTONA_API_KEY`** in `apps/api/.env` for real cloud sandboxes

### One command

```bash
pnpm install
pnpm dev            # web :3000 + API :8008 + Supabase + cloudflared tunnel
```

`scripts/dev-local.sh` loads `apps/api/.env` + `apps/web/.env`, starts Supabase, the API, the web app, and a public tunnel so cloud sandboxes can reach your local API.

### Individual services

```bash
pnpm dev:web        # Next.js only
pnpm dev:api        # Bun API only
pnpm dev:sandbox    # build sandbox Docker image
pnpm dev:mobile     # Expo dev server
pnpm dev:desktop    # Tauri shell (needs dev:web running)
pnpm build          # build all workspace packages
pnpm nuke           # tear down local Docker / Supabase
pnpm nuke:start     # nuke then restart fresh
```

### Environment setup

```bash
./scripts/setup-env.sh    # generates per-app .env from root .env template
```

Key URLs when running locally:

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:8008/v1 |
| API health | http://localhost:8008/v1/health |
| Supabase | http://127.0.0.1:54321 |
| Sandbox proxy | http://localhost:8008/v1/p/<external_id>/8000/… |

### API auth (scripts & tests)

Mint a JWT against local Supabase, then call the API with `Authorization: Bearer <token>`. See `tests/e2e/helpers/auth.ts` and [`AGENTS.md`](AGENTS.md) for the exact flow.

---

## Test & verify

| Harness | Command | What it covers |
| --- | --- | --- |
| Session smoke | `bun tests/e2e/scripts/session-smoke.ts` | Full provision → sandbox → prompt → assistant reply |
| Multi-session | `bun tests/e2e/scripts/multi-session-stream-smoke.ts` | Two concurrent SSE streams |
| Playwright UI | `tests/e2e/specs/*.spec.ts` | Browser E2E (see `tests/e2e/end-to-end.md`) |
| API unit tests | `pnpm --filter kortix-api test` | Billing, projects, access control |
| Self-hosted E2E | `bash tests/e2e/self-hosted-e2e.sh` | Full install → browser golden paths |

Provisioning is slow (snapshot build up to ~9 min, sandbox up to ~5 min) — run long checks in the background.

See [`tests/README.md`](tests/README.md) for the full test matrix.

---

## Self-host

Kortix is source-available and runs on your own infrastructure — laptop, VPS, your VPC, or air-gapped.

```bash
kortix self-host start
kortix hosts ls
kortix hosts use local
kortix hosts use cloud
```

The first interactive setup asks only for integration credentials (Freestyle, GitHub, Pipedream). Ports, local URLs, Supabase keys, and Docker Compose defaults are generated for you.

Managed hosting: **[Kortix Cloud](https://kortix.com)** · **[Pricing](https://kortix.com/pricing)**

## Enterprise & security

Members, groups & roles that match your org · per-resource permissions for people **and** agents · encrypted secrets manager (injected at runtime, never exposed) · full audit trail · human approval gates on sensitive actions · on-prem, VPC, or air-gapped deployment.

## Why Kortix

- **Open & yours.** Source-available and self-hostable — your data, your models, your infrastructure. No lock-in, fully auditable.
- **A workforce, not one assistant.** Org-scale specialist agents that run in parallel and compound a shared memory.
- **Real work, not chat.** Agents run on real computers and return finished deliverables — and take real actions in your tools.
- **Everything is code.** Versioned, reviewable, portable, governable — never a black box.

---

## License

[Elastic License 2.0](LICENSE) — source-available. You can use, modify, and self-host; production use as a managed service for third parties requires a commercial license from Kortix.
