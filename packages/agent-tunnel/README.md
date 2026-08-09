# `@kortix/agent-tunnel`

`@kortix/agent-tunnel` connects a local computer to Kortix through an authenticated reverse tunnel.

## Connect once

Run the command shown in **Settings → Computers**, then approve the device code in your browser:

```bash
npx --yes @kortix/agent-tunnel@latest connect \
  --api-url https://api.kortix.com/v1/tunnel
```

The interactive flow asks whether the computer should remain online after the terminal closes.

## Keep the computer online

Install the operating-system background service during connection:

```bash
npx --yes @kortix/agent-tunnel@latest connect \
  --daemon \
  --api-url https://api.kortix.com/v1/tunnel
```

Add `--keep-awake` to also prevent the computer from sleeping while the service runs:

```bash
npx --yes @kortix/agent-tunnel@latest connect \
  --daemon \
  --keep-awake \
  --api-url https://api.kortix.com/v1/tunnel
```

The service uses LaunchAgent on macOS, a user systemd service on Linux, and Task Scheduler on Windows.

## Manage the background service

```bash
npx --yes @kortix/agent-tunnel@latest service-status
npx --yes @kortix/agent-tunnel@latest logs
npx --yes @kortix/agent-tunnel@latest restart
npx --yes @kortix/agent-tunnel@latest stop
npx --yes @kortix/agent-tunnel@latest uninstall-service
```

Credentials are stored in `~/.agent-tunnel/config.json` with user-only file permissions.
