# agent-cli

The set of command-line tools the agent (opencode) invokes from inside the
sandbox. **Not** the same thing as the user-facing `kortix` CLI in
[`apps/cli`](../../cli) — those are two different products with two different
audiences:

| | User CLI (`apps/cli`) | Agent CLI (this) |
|---|---|---|
| Audience | Humans at their laptop using Kortix cloud | opencode inside a sandbox |
| Auth | Bearer token from `kortix login` | Env vars injected at sandbox spawn |
| Distributed as | Compiled binary (homebrew / npm) | Bun scripts + PATH shims inside the sandbox image |
| Surface | Account / project / secrets / sessions / channels management | Vendor adapters + introspection the agent calls per turn |

These do **not** share code or release cycles. The agent CLI ships baked into
the Daytona sandbox image; the user CLI ships to people's laptops.

## Layout

```
apps/sandbox/agent-cli/
├── lib/                 ← shared kernel, imported by every CLI
│   ├── cli.ts           ←   parseArgs, out, CliError, handleError, validators
│   ├── env.ts           ←   getEnv, requireEnv, kortixProjectId, kortixSessionId
│   ├── api.ts           ←   kortixGet, kortixPost — apps/api client (for CLIs that need cloud state)
│   ├── format.ts        ←   date helpers
│   └── index.ts         ←   barrel
│
├── channels/            ← communication adapters (Slack, Telegram, …)
├── install-shims.sh     ← generates /usr/local/bin/<name> shims at image build
└── README.md
```

When a new category of agent tools appears (browser, git, docs, …), add a
sibling subdir next to `channels/`. The shim generator picks up `.ts` files
recursively, so nothing else needs to change.

PATH layout in the running sandbox stays flat — `/usr/local/bin/slack`,
`/usr/local/bin/telegram`, `/usr/local/bin/kchannel`, etc. The subdirs are
purely organizational so the source tree stays navigable.

## Naming convention

- **Bare names** (`slack`, `telegram`, `discord`) — platform / vendor adapters.
- **`k`-prefix** (`kchannel`, `kconnectors`, `kpipedream`) — kortix-namespace
  meta tools that introspect or coordinate, not vendor wrappers.

The `install-shims.sh` build step **fails the image build** if two `.ts` files
would install under the same basename. Pick a unique name.

## The contract — every CLI looks like this

```typescript
#!/usr/bin/env bun
import { parseArgs, out, handleError, requireEnv, CliError, validateRequired } from "../lib"

async function send(opts: { channel: string; text: string }) {
  const token = requireEnv("SLACK_BOT_TOKEN")
  // …call vendor API…
  return { ok: true, ts: "1715000000.0001" }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv)
  switch (command) {
    case "send":
      validateRequired(flags, "channel", "text")
      out(await send({ channel: flags.channel!, text: flags.text! }))
      return
    case "help":
    default:
      console.log("…help text…")
      return
  }
}

if (import.meta.main) {
  main().catch(handleError)
}
```

Rules:

- **JSON-only stdout**, exit 0 on success and 1 on failure. The agent
  parses results — never write progress to stdout.
- **Auth via env.** Tokens (`SLACK_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, …) are
  injected at sandbox spawn from `project_secrets` (cloud postgres).
  No `--config-id`, no SQLite, no per-sandbox state. Sandboxes are
  per-session and destructive — anything you write to disk in the
  sandbox dies with it.
- **CLIs that need apps/api state** import `kortixGet` / `kortixPost`
  from `../lib`. Auth there uses the project-scoped CLI token
  (`KORTIX_CLI_TOKEN`) that's already in env.
- **Every CLI exposes a `help` subcommand** printing its full surface so
  the agent can self-discover.
- **No `--config-id`-style flags.** Per-project state lives in env;
  per-call state goes in flags.

## Adding a new CLI

1. Pick a category subdir (`channels/` exists today, or create a new one if
   no existing category fits — e.g. `browser/`, `git/`, `docs/`).
2. Drop a `.ts` file following the contract above.
3. Import shared utilities from `../lib`.
4. Rebuild the sandbox image — `install-shims.sh` picks it up. The agent
   has it at the next session boot.

No Dockerfile edit. No webhook prompt update (the prompts point the agent
at `/usr/local/bin/` for discovery + `<cli> help` for the surface).

## Talking to apps/api

For CLIs that need cloud-side state (connectors list, project settings,
audit events, …) use the api module:

```typescript
import { kortixGet, kortixPost } from "../lib"

async function listConnectors() {
  const { connectors } = await kortixGet<{ connectors: Connector[] }>("/connectors")
  return { ok: true, connectors }
}
```

`kortixGet` / `kortixPost` use `KORTIX_API_URL` + `KORTIX_CLI_TOKEN` from env.
Both are minted per session by apps/api at sandbox spawn — see
[`buildSessionSandboxEnvVars`](../../api/src/projects/index.ts) for the wiring.

## What lives where

| Concern | Location |
|---|---|
| Slack/Telegram adapter | `channels/slack.ts`, `channels/telegram.ts` |
| Channel discovery | `channels/kchannel.ts` (env-driven) |
| Webhook router that wakes the agent | `apps/api/src/channels/` (server-side, separate from this dir) |
| Durable channel state | `project_secrets` (postgres) + `chat_channel_bindings` for OAuth team_id lookup |
| Shared CLI utilities | `lib/` |
