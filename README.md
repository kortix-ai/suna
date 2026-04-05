# Kortix

**The Autonomous Company Operating System**

A cloud computer where AI agents run your company. Full Linux sandbox, persistent memory, skills, integrations, cron/webhook triggers, multi-channel access. Agents work 24/7 — code, APIs, documents, infrastructure — whether you're there or not. Everything is linux, bash, files. The agent runtime is [OpenCode](https://github.com/anomalyco/opencode).

## Quick Start

Run locally on your laptop or on a VPS/server — the installer handles both.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/get-kortix.sh)
```

The installer will ask where you're running:

1. **Local machine** (laptop/desktop) — binds to `localhost`
2. **VPS / Server** — binds to `0.0.0.0`, accessible over the network

Kortix works best when it can run 24/7 — even when your laptop is closed. We recommend a server or VPS: [Kortix Cloud](https://kortix.com/) (managed), your own server, or a VPS from [Hetzner](https://hetzner.com/) or [JustAVPS](https://justavps.com/).

On any server, just SSH in and run the same install command:

```bash
# SSH into your server, then run the same install:
bash <(curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/get-kortix.sh)
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
