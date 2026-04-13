# Kortix

**The Open-Source Operating System for Running Autonomous Companies**

The best results come from maximum entropy and openness. Give a language model full context — every file, every secret, every integration, every piece of institutional knowledge — and let it run free. For that to work, it needs a proper machine: a real computer running 24/7 where all the context is stored, all the secrets live, all the work accumulates, and all the other agents operate alongside it.

A Kortix *is* a company. One shared machine where every agent sees the same filesystem, the same databases, the same credentials, the same history. Context isn't siloed per tool or per session — it's shared across the entire system, compounding over time. When your support agent resolves a ticket, your product agent already knows. When your finance agent reconciles an invoice, the context is there for everyone.

The reason this works is that coding agents — agents that operate inside a real computer with bash, a filesystem, and the full power of a Linux machine — are the optimal harness for all knowledge work, not just software engineering. They can write scripts, call APIs, manipulate files, browse the web, run databases, parse documents, generate reports, manage infrastructure — anything a human can do at a terminal. Pair that with agent skills, persistent memory, triggers, and orchestration, and you can build complete agents for sales, finance, operations, legal, recruiting, customer support, and every other function a company needs.

We are building Kortix as our own internal operating system at [Kortix](https://kortix.com) to run our own companies and products. Every agent, skill, and workflow we ship is something we use ourselves — battle-tested against real workloads, not demos. 

**What you get:** A cloud computer where AI agents do the actual work of running a company. Full Linux Ubuntu sandbox, persistent memory, 60+ skills, 3,000+ integrations, cron/webhook triggers, multi-channel access. Agents work 24/7 — code, APIs, documents, spreadsheets, infrastructure — whether you're there or not. Everything is Linux, bash, files. The agent runtime is [OpenCode](https://github.com/anomalyco/opencode).

## Quick Start

Run locally on your laptop or on a VPS/server — the installer handles both.

```bash
curl -fsSL https://kortix.com/install | bash
```

The installer will ask where you're running:

1. **Local machine** (laptop/desktop) — binds to `localhost`
2. **VPS / Server** — binds to `0.0.0.0`, accessible over the network

Kortix works best when it can run 24/7 — even when your laptop is closed. We recommend a server or VPS: [Kortix Cloud](https://kortix.com/) (managed), your own server, or a VPS from [Hetzner](https://hetzner.com/) or [JustAVPS](https://justavps.com/).

On any server, just SSH in and run the same install command:

```bash
# SSH into your server, then run the same install:
curl -fsSL https://kortix.com/install | bash
```

After install, manage everything with the `kortix` CLI:

```
kortix start       Start all services
kortix stop        Stop all services
kortix restart     Restart all services
kortix logs        Tail logs
kortix status      Show service status
kortix update      Pull latest images and restart
kortix reset       Wipe local data and start fresh
kortix uninstall   Remove Kortix completely
```

## DEV Commands

- `curl -fsSL http://localhost:3000/install | bash`
- `pnpm dev` — start frontend + API in dev mode
- `pnpm dev:web` — start web app only
- `pnpm dev:frontend` — alias for `pnpm dev:web`
- `pnpm dev:api` — start API only
- `pnpm dev:mobile` — start mobile app (Expo dev server)
- `pnpm dev:core` — start core runtime with dev bind mounts (hot reload, from `core/`)
- `pnpm dev:core:build` — rebuild and start the core runtime
- `pnpm dev:sandbox` — alias for `pnpm dev:core`
- `pnpm dev:sandbox:build` — alias for `pnpm dev:core:build`
- `pnpm build` — build all packages (`pnpm -r run build`)
- `pnpm ship <version>` — bump versions, build + push Docker images, seed the JustAVPS image, create GitHub release
- `pnpm ship --dry-run <version>` — validate without making changes
- `pnpm ship --check` — show current release state
- `pnpm image [version]` — build the JustAVPS image from a temporary JustAVPS machine
- `pnpm nuke` — tear down local Docker environment
- `pnpm nuke:start` — nuke + restart fresh


## License

See [LICENSE](LICENSE) for details.
