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

The computer belongs to you in every project and workspace you are a member
of, in your private sessions. `--project-id` only offers "Also share with
<project>" on the approval page; without it the computer is still yours
everywhere.

After approval, the interactive flow asks whether it should install a persistent background service. The default answer is yes.

## Run in the background

Install the operating-system background service during connection:

```bash
npx --yes @kortix/agent-tunnel@latest connect \
  --daemon \
  --api-url https://api.kortix.com/v1/tunnel
```

The service uses LaunchAgent on macOS, a user systemd service on Linux, and Task Scheduler on Windows.
It starts at login, and the supervisor restarts it after every exit (launchd
`KeepAlive` with a 10 s throttle, systemd `Restart=always`, a 5 s Windows loop).
On Linux, install enables `loginctl enable-linger` so the user service keeps
running after logout and starts at boot; when that is not allowed, install
prints a warning. The Windows task runs hidden, on battery, with no time limit.
The agent itself never stops on its own:

- It reconnects with exponential backoff from 1 s to 30 s, ±20 % jitter, forever.
- It drops a socket that received no relay ping for 75 s, and it reconnects at
  once after the machine wakes from sleep (a 5 s timer that sees a jump of more
  than 30 s). A wake resets the backoff.
- A refused credential puts it in state `rejected`. It checks `config.json`
  every 5 s and connects as soon as a new pairing writes another credential;
  it also retries the old one every 5 minutes.
- The relay accepts 5 connections per machine per minute. A process that
  restarts faster than that waits up to 12 s for the next slot.
- A second process with the same credential puts it in state `standby`. It
  tries again after 1 minute, doubling each time up to 30 minutes, so two
  holders of one credential do not trade the connection back and forth.
- A handshake that does not reach `auth_ok` within 20 s is dropped and retried.
- No saved credential: it waits and checks `config.json` every 60 s.

It changes the computer's sleep settings only when `access.json` sets
`keepAwake` (see below).

## Manage the background service

```bash
npx --yes @kortix/agent-tunnel@latest service-status
npx --yes @kortix/agent-tunnel@latest logs
npx --yes @kortix/agent-tunnel@latest restart
npx --yes @kortix/agent-tunnel@latest stop     # pause: stays stopped after login and reboot
npx --yes @kortix/agent-tunnel@latest start    # resume
npx --yes @kortix/agent-tunnel@latest uninstall-service
npx --yes @kortix/agent-tunnel@latest logout   # remove this computer from Kortix, then sign out
```

`stop` disables the job (`launchctl disable`, `systemctl --user disable --now`,
`schtasks /Change /DISABLE`), so it stays stopped until `start`.

`logout` first calls `DELETE /v1/tunnel/self` with the machine's own credential,
which removes the machine and its accounts in Kortix. It then clears the local
credential and removes the service. If Kortix cannot be reached, the local
sign-out still completes; `logout --json` then reports `"serverUnpaired": false`.

`service-status --json` prints the pairing, the service (`installed`, `active`,
`enabled` = not paused, `upToDate` = the unit matches what `install-service`
writes now), the live connection state, and `access`.

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
| `state.json` | `{ tunnelId, apiUrl, status: online\|offline\|connecting\|rejected\|standby, since, agentVersion, pid }`, rewritten atomically on every connection change. No credential. |
| `access.json` | `{ mode: ask\|always\|off, grantedUntil, deniedUntil, keepAwake }`, mode `0600`. See "Access control". |
| `access-request.json` | `{ id, requestedAt, capability, method }`: the call waiting for the owner. |
| `desktop-app.json` | Written by the Kortix desktop app: how to start it to show an access prompt. |
| `logs/` | Service output. |

`AGENT_TUNNEL_HOME` replaces the config directory (default `~/.agent-tunnel`).
A non-default directory also gets its own service,
`ai.kortix.agent-tunnel.<first 8 hex of sha256(directory)>`, so a second
identity never replaces the default `ai.kortix.agent-tunnel` service. The
service definition carries `AGENT_TUNNEL_HOME` into the service environment.

## Access control

The machine decides, before every call, whether an agent may use it.
`access.json` holds the owner's answer:

| `mode` | Effect |
| --- | --- |
| `always` | Every call runs. A machine without `access.json` behaves like this. |
| `ask` | A call runs while `grantedUntil` is in the future (at most 24 h ahead). Otherwise the agent writes `access-request.json`, starts the desktop app if it is not running, and holds the call for 20 s. A grant runs it. No answer returns `-32010 computer_access_pending`. A denial sets `deniedUntil` 10 minutes ahead and returns `-32011 computer_access_denied`; calls fail at once until then. |
| `off` | Every call returns `-32012 computer_access_off`. |

A pairing made from the Kortix desktop app starts in `ask`: the app shows the
prompt. A pairing made with this CLI alone starts in `always`, because nothing
on the machine could answer a prompt. This is a deliberate deviation from
"new pairings default to ask". Every new pairing resets `access.json`, so a
grant or `always` from an earlier pairing never carries over, and `logout`
deletes it. The agent home (`config.json`, `access.json`, `desktop-app.json`)
is always a blocked path: no file or shell call can change these files. The agent reports `{ mode, grantedUntil }`
to Kortix as the signed notification `tunnel.access.state` on connect and on
every change.

`keepAwake: true` keeps the computer from sleeping while the agent runs:
`caffeinate -s` on macOS (on AC power only), `systemd-inhibit --what=sleep` on
Linux. Windows is not supported.

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
