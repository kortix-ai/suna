# `@kortix/agent-tunnel`

`@kortix/agent-tunnel` connects a local computer to Kortix through an authenticated reverse tunnel.

## Connect once

Run the command shown in a **Computer Tunnel** connector profile. Then approve
the device code in your browser:

```bash
npx --yes @kortix/agent-tunnel@latest connect \
  --api-url https://api.kortix.com/v1/tunnel
```

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

Credentials are stored in `~/.agent-tunnel/config.json`. Agent Tunnel requires
the file to be regular, owned by the current user, and mode `0600` on POSIX.
Protect the operating-system account because this setup token can authenticate
the machine until you rotate or delete the connection.

Remote API URLs must use HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1` development endpoints.

## Permission boundaries

Kortix checks connector profile assignment, connector grants, connector tool
policy, and the machine permission before relaying an operation. The local agent
then checks the machine permission again.

The local config is the maximum boundary. A server grant cannot widen configured
filesystem paths, blocked paths, shell commands, timeouts, file sizes, or desktop
features. An empty permission scope is unrestricted inside those local ceilings.
Use scoped permissions and short expiries for sensitive machines.

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
