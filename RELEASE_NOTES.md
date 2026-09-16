Reliable terminal connections after sandbox resume

- Fix terminal connections that fail after a sandbox resumes because its provider credentials have changed.
- Refresh rejected provider credentials once for reads and discard stale credentials after a failed WebSocket handshake.
- Preserve application redirects and sandbox authentication errors. Do not replay writes when provider authentication fails.
