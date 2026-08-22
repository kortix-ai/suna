# slack-cli

In-sandbox command-line tools the OpenCode runtime invokes from inside a
session. They ship as PATH shims baked into the Daytona sandbox image, auth via
env vars injected at sandbox spawn, and emit **JSON only** so the agent can parse
results.

> **Scope today: just `slack`.** The Connector — once the `connector` /
> `connector-mcp` shims here — has been absorbed into the one `kortix` CLI as
> `kortix connectors` (the agent-facing CLI) plus the optional
> `kortix connectors mcp` compatibility server. Both use `@kortix/sdk` through
> the compiled `kortix` binary. The old
> `kchannel` (channel discovery) and `secrets` (link minting) shims were removed:
> channel state is in the sandbox env already, and secrets are `kortix secrets …`.
> Slack stays here as a standalone vendor adapter.

Not the same thing as the user-facing `kortix` CLI in [`apps/cli`](../../cli),
which is a compiled binary for people's laptops (and is *also* baked into the
sandbox image — that's what `kortix connectors` runs from).

## Layout

```
apps/sandbox/slack-cli/
├── lib/                 ← shared kernel imported by every CLI here
│   ├── cli.ts           ←   parseArgs, out, CliError, handleError, validators
│   ├── env.ts           ←   getEnv, requireEnv, kortixProjectId, kortixSessionId
│   ├── api.ts           ←   kortixGet, kortixPost — apps/api client
│   └── index.ts         ←   barrel
│
├── channels/
│   └── slack.ts         ← the Slack Web API adapter (`slack send`, `slack step`, …)
├── install-shims.sh     ← generates /usr/local/bin/<name> shims at image build
└── README.md
```

The shim generator walks for `.ts` files (skipping `lib/`) and installs each as
`/usr/local/bin/<basename>`. It **fails the image build** on basename
collisions — pick a unique name.

## The contract — every CLI here looks like this

```typescript
#!/usr/bin/env bun
import { parseArgs, out, handleError, validateRequired, kortixConnectorCall } from "../lib"

async function send(opts: { channel: string; text: string }) {
  // Vendor calls go through the Kortix Connector — the credential is resolved
  // SERVER-SIDE, so there is NO vendor token (no SLACK_BOT_TOKEN etc.) in the
  // sandbox. Authenticate to the gateway with the session token instead.
  const res = await kortixConnectorCall("slack.send_message", {
    channel: opts.channel,
    text: opts.text,
  })
  return res.data
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

- **JSON-only stdout**, exit 0 on success and 1 on failure. The agent parses
  results — never write progress to stdout.
- **No vendor tokens in the sandbox.** Vendor calls (e.g. Slack) run through the
  Kortix Connector, which resolves the credential server-side; the CLI auths to
  apps/api with the per-session `KORTIX_TOKEN` (+ `KORTIX_API_URL`). Binary /
  multipart vendor ops the JSON gateway can't carry (Slack file download/upload)
  go through dedicated apps/api proxy routes — still token-free in the box.
- **Every CLI exposes a `help` subcommand** printing its full surface so the
  agent can self-discover.

## When to add here vs. into the `kortix` CLI

- **Vendor/channel adapter** the agent calls per turn (like Slack) → add a `.ts`
  here following the contract above; rebuild the image, `install-shims.sh` picks
  it up.
- **Kortix-platform capability** (anything that talks to apps/api as the user —
  connectors, secrets, sessions, change requests, the Connector) → add it as a
  subcommand of the one `kortix` CLI in [`apps/cli`](../../cli) instead, so there
  is a single surface.

## Talking to apps/api

For state that lives cloud-side, use the api module:

```typescript
import { kortixGet, kortixPost } from "../lib"
```

`kortixGet` / `kortixPost` use `KORTIX_API_URL` + `KORTIX_TOKEN` from env,
both minted per session by apps/api at sandbox spawn.
