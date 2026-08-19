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
