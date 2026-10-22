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

Connecting the same computer again reuses its entry. The agent sends a SHA-256
hash of the hardware ID (IOPlatformUUID, `/etc/machine-id`, or `MachineGuid`);
the raw ID never leaves the computer.

After approval, `connect` in a terminal installs the background service, the
same way the desktop app does, and prints the commands that pause, resume,
and remove it. It asks no question. `--foreground` keeps the connection in the
terminal instead. A script without a TTY, or `--json`, stays in the foreground
unless it passes `--daemon`.

## One runtime with the desktop app (macOS)

When the Kortix desktop app is installed (`/Applications/Kortix.app` or
`~/Applications/Kortix.app`), the service a CLI install writes runs on the
app's own agent and driver: `Kortix.app/Contents/MacOS/Kortix` with
`ELECTRON_RUN_AS_NODE=1` and `Contents/Resources/agent-tunnel/agent-cli.js`.
A CLI install and an app install are then the same connection. macOS grants
Accessibility and Screen Recording to Kortix once, never to `node` or a
terminal, and **Your computer** in the app controls it.

This CLI is the one control surface of the computer. The desktop app runs
these same commands (`status --json`, `access`, `keep-awake`, `stop`,
`start`, `logout`) and never edits the agent's files itself. A change made
in the app, in the terminal, or through Kortix is the same change. Without the app,
the service runs on `node`, and Computer Use needs a separately installed
`cua-driver`.

The service restarts itself when its code changes on disk (an app update or
a new vendored bundle). macOS refuses every permission to a process whose
binary was replaced under it, so a stale process would lose Computer Use.

## Run in the background

The service is the default for a person at a terminal. A script installs it with `--daemon`:

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
prints a warning. The Windows task runs PowerShell under `conhost --headless`
(no console window, also where Windows Terminal is the default terminal), on
battery, with no time limit. Every process the agent starts on Windows sets
`windowsHide`, so no console window opens.
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

It changes the computer's sleep settings only while `keep-awake` is on (see
"Access control").

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

`status --json` (and its alias `service-status --json`) prints the pairing,
the approved `capabilities`, the service (`installed`, `active`, `enabled` =
not paused, `upToDate` = the unit matches what `install-service` writes now),
the live connection `state` (a process that died without saying so reads as
`offline`), and `access` (the same object `access --json` prints).

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
| `access-request.json` | `{ id, requestedAt, capability, method, change? }`: the call, or the wider access asked for through Kortix (`change`), waiting for the owner. |
| `desktop-app.json` | Written by the Kortix desktop app: how to start it to show an access prompt. |
| `logs/` | Service output. |

`AGENT_TUNNEL_HOME` replaces the config directory (default `~/.agent-tunnel`).
A non-default directory also gets its own service,
`ai.kortix.agent-tunnel.<first 8 hex of sha256(directory)>`, so a second
identity never replaces the default `ai.kortix.agent-tunnel` service. The
service definition carries `AGENT_TUNNEL_HOME` into the service environment.

## Access control

The machine decides, before every call, whether an agent may use it. Change
it with the CLI:

```bash
npx --yes @kortix/agent-tunnel@latest access                  # show it
npx --yes @kortix/agent-tunnel@latest access ask              # or always, off
npx --yes @kortix/agent-tunnel@latest access --allow-for 60   # in ask: allow for 60 minutes (max 1440)
npx --yes @kortix/agent-tunnel@latest access --revoke         # end the current allowance
npx --yes @kortix/agent-tunnel@latest access --deny           # answer the waiting request with No
npx --yes @kortix/agent-tunnel@latest keep-awake on           # or off (macOS and Linux)
```

Every command takes `--json` and prints `{ mode, grantedUntil, deniedUntil,
keepAwake, keepAwakeSupported, pendingRequest }`. A wrong mode or duration
exits `1` and changes nothing. The person at the terminal is the computer's
owner, so these commands also widen access.

| `mode` | Effect |
| --- | --- |
| `always` | Every call runs. A machine without `access.json` behaves like this. |
| `ask` | A call runs while `grantedUntil` is in the future (at most 24 h ahead). Otherwise the agent writes `access-request.json`, starts the desktop app if it is not running, and holds the call for 20 s. A grant runs it. No answer returns `-32010 computer_access_pending`. A denial sets `deniedUntil` 10 minutes ahead and returns `-32011 computer_access_denied`; calls fail at once until then. |
| `off` | Every call returns `-32012 computer_access_off`. |

**Through Kortix.** The owner can also change access from the Kortix web app
or the desktop app's window (`POST /v1/tunnel/connections/:id/access`, user
credentials only; no agent or session token reaches it). Kortix relays the
change to the agent as `tunnel.access.set`:

- A narrowing (`ask`, `off`, `--revoke`, `--deny`, keep awake) applies at once,
  even while access is `off`.
- A widening (`always`, or a longer allowance) needs the owner on the computer.
  The agent writes it to `access-request.json` with `change`, and the desktop
  app shows a native **Allow** / **Cancel** dialog. **Allow** runs the matching
  `access` command; **Cancel** runs `access --deny`, which declines the change
  without refusing calls. The relayed call waits up to 20 s and otherwise fails
  with `-32014 computer_access_unconfirmed`. A computer without the desktop
  app fails at once, naming the command to run on it.

A pairing made from the Kortix desktop app starts in `ask`: the app shows the
prompt. A pairing made with this CLI alone starts in `always`, because nothing
on the machine could answer a prompt. This is a deliberate deviation from
"new pairings default to ask". The mode and keep awake are the owner's
machine settings: pairing again (`--reauth`, a rejected or stale credential)
keeps them, and only a grant or a denial from the earlier pairing is dropped.
`logout` deletes `access.json`, so the next pairing starts from the default. The agent home (`config.json`, `access.json`, `desktop-app.json`)
is always a blocked path: no file or shell call can change these files.

The agent reports its state to Kortix as the signed notification
`tunnel.access.state` on connect and on every change: the access fields, the
waiting request, and `desktopPermissions` (`{ accessibility, screenRecording }`
as macOS answers for the agent process itself, checked every 60 s). Kortix
shows exactly this.

`keep-awake on` keeps the computer from sleeping while the agent runs:
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

A `shell` grant is local code execution. The allow list matches the executable
name exactly and the block list also matches every path ending in that name
(`/bin/rm` is `rm`). Arguments are not restricted: an allowed `git`, `find`, or
`python` can run any code through its own flags. Grant `shell` only to a session
you trust with this computer.

## Computer Use driver

Agent Tunnel never downloads or executes a desktop driver. The Kortix desktop
app bundles `cua-driver` on macOS and Windows (x64), and the agent it runs uses
that copy. A CLI install uses an existing binary from `CUA_DRIVER_BIN`,
`~/.local/bin`, `/usr/local/bin`, or `/opt/homebrew/bin`.

An approved `desktop` registers whenever the driver is present. Missing macOS
grants do not unregister it: the agent reports `desktopPermissions` and the
setup asks for them. When the driver is missing or rejected (wrong owner,
group-writable), `desktop` does not register and the reason is reported as
`unavailableCapabilities.desktop` in `status --json` and in `machineInfo`.
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
