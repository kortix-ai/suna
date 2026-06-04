Project memory, runtime feature controls, and a typed API

## New
- **Project memory** — agents get a first-class `memory` tool to read and write a durable project brain in `.kortix/memory/`, replacing the old prompt-injection plugin. The memory-reflector keeps it curated on a schedule.
- **Runtime feature controls** — turn built-in capabilities (memory, web tools, terminal, the `show` tool, the executor) on or off per project in `kortix.toml` `[runtime]`, or enforce them per session. `disable_all` runs a session as plain OpenCode.
- **`kortix init` is now standalone** — like `create-next-app`, it scaffolds a new Kortix project in its own fresh directory.
- **Experimental feature flags** — a per-project system to gate work-in-progress features (Apps, Agent Tunnel).
- **Typed API + live docs** — the API is fully typed end to end, with interactive reference docs at `/v1/docs`.

## Improved
- Leaner project starter — the full agent runtime ships as editable source with a cleaner default layout (the Slack skill is now `kortix-slack`).
- `kortix ship` walks you through connecting any connector that still needs auth.
- Mobile-responsive marketing pages and a full-screen mobile nav; chat links and file paths open in the active session panel.
- Per-account project limits by plan.

## Fixed
- Subscriptions are scoped to the owning account.
- Several API request-validation and auth-ordering regressions.
- Code-scanning (CodeQL) findings.

_Internal: the API was decomposed so every file is under 1k lines, and CI now rebuilds only when the dependency closure changes._
