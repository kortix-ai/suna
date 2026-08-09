# `@kortix/agent-tunnel`

`@kortix/agent-tunnel` connects a local computer to Kortix through an authenticated reverse tunnel.

## Connect once

Run the command shown in **Settings → Computers**, then approve the device code in your browser:

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

Credentials are stored in `~/.agent-tunnel/config.json` with user-only file permissions.
