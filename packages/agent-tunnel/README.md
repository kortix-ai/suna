# `@kortix/agent-tunnel`

`@kortix/agent-tunnel` connects a local computer to Kortix through an authenticated reverse tunnel.

Each connected computer is an account of a project's **computer** connector,
private to the person who connected it unless they share it with the project.
The Kortix desktop app bundles this agent and connects in one click. Without
the desktop app, use the command below.

## Connect once

Run the command shown under **Connect your computer** in a project. Then
approve the device code in your browser:

```bash
npx --yes @kortix/agent-tunnel@latest connect \
  --api-url https://api.kortix.com/v1/tunnel \
  --project-id <project-uuid>
```

`--project-id` preselects the project on the approval page. Without it, the
approval page asks for one.

After approval, the interactive flow asks whether it should install a persistent background service. The default answer is yes.

## Run in the background

Install the operating-system background service during connection:

```bash
npx --yes @kortix/agent-tunnel@latest connect \
  --daemon \
  --api-url https://api.kortix.com/v1/tunnel
```

The service uses LaunchAgent on macOS, a user systemd service on Linux, and Task Scheduler on Windows.
It starts at login and restarts after failures. It does not change the computer's sleep settings.

## Manage the background service

```bash
npx --yes @kortix/agent-tunnel@latest service-status
npx --yes @kortix/agent-tunnel@latest logs
npx --yes @kortix/agent-tunnel@latest restart
npx --yes @kortix/agent-tunnel@latest stop
npx --yes @kortix/agent-tunnel@latest uninstall-service
```

`service-status --json` prints the pairing, the service, and the live
connection state as JSON.

Credentials are stored in `~/.agent-tunnel/config.json`. Agent Tunnel requires
the file to be regular, owned by the current user, and mode `0600` on POSIX.
Protect the operating-system account because this setup token can authenticate
the machine until you rotate or delete the connection.

Remote API URLs must use HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1` development endpoints.

## Files and isolation

| Path (under the config directory) | Content |
| --- | --- |
| `config.json` | Credential and local limits, mode `0600`. |
| `state.json` | `{ tunnelId, apiUrl, status: online\|offline\|connecting, since, agentVersion, pid }`, rewritten atomically on every connection change. No credential. |
| `logs/` | Service output. |

`AGENT_TUNNEL_HOME` replaces the config directory (default `~/.agent-tunnel`).
A non-default directory also gets its own service,
`ai.kortix.agent-tunnel.<first 8 hex of sha256(directory)>`, so a second
identity never replaces the default `ai.kortix.agent-tunnel` service. The
service definition carries `AGENT_TUNNEL_HOME` into the service environment.

## Machine-readable connect

`connect --json` prints newline-delimited JSON events on stdout instead of the
terminal UI. It never prompts and never opens a browser; the caller shows the
approval URL.

```json
{"event":"challenge","deviceCode":"ABCD-1234","verificationUrl":"https://…","expiresAt":"…"}
{"event":"approved","tunnelId":"…","capabilities":["filesystem","shell"]}
{"event":"service","action":"install","ok":true,"active":true,"detail":"…"}
{"event":"error","message":"…"}
```

`approved` carries `"existing": true` when a saved pairing was still valid.
`service` follows only with `--daemon`.

Run under Electron (`ELECTRON_RUN_AS_NODE=1`), the installed service runs the
same Electron binary with `ELECTRON_RUN_AS_NODE=1` and the bundle in place.

## Permission boundaries

Kortix checks that the session may use the computer account (owner,
sharing, and connector policies such as `require_approval`) before relaying an
operation. The capabilities approved at pairing are fixed; pair again to change
them. The local agent then checks the operation again.

The local config is the maximum boundary. The server cannot widen configured
filesystem paths, blocked paths, shell commands, timeouts, file sizes, or desktop
features.

## Computer Use driver

Agent Tunnel never downloads or executes a desktop driver. Install `cua-driver`
locally before enabling Computer Use. The tunnel uses an existing binary from
`CUA_DRIVER_BIN`, `~/.local/bin`, `/usr/local/bin`, or `/opt/homebrew/bin`.
Treat that binary as trusted local code. Agent Tunnel does not verify or update
it.

### Transfer a binary file without copying base64

Run the client where the source file exists. Set `TUNNEL_API_URL`, `TUNNEL_TOKEN`,
and `TUNNEL_ID` for the target connection, then run:

```sh
agent-tunnel-cli fs_upload '{"source":"/tmp/report.xlsx","path":"/Users/me/Desktop/report.xlsx"}'
```

`fs_upload` reads bytes from `source`, computes SHA-256, and sends the bytes
programmatically over the authenticated tunnel. It requires filesystem write
permission. A pending approval returns `success: false` and exit code 1; retry
only after approval. The command accepts regular files up to 3 MiB, which leaves
room under the relay's 5 MiB message limit after base64 encoding.

The connected agent checks the supplied `sha256` before modifying the destination.
It reads the file after writing and returns its persisted `sha256` and `size`.
The CLI succeeds only when both match the source. An older agent without checksum
support causes verification to fail; the file may already exist. Update the agent
before retrying.

For raw `fs.write`, `sha256` is optional for compatibility. Supply it for binary
content. Never copy an opaque base64 payload from model context. Generate the file
on the destination when a programmatic transfer is unavailable. A matching hash
proves byte integrity, not format validity: validate XLSX/ZIP structure and workbook
contents at the source. File size and magic bytes are insufficient. Do not use
public file-host relays for this workflow.
