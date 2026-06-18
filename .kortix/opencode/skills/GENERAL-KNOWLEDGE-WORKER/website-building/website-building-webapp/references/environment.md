# Environment

## Dev Server

Start the dev server with `pty_spawn` so the process stays alive while you iterate. Typical commands:

```bash
npm install
npm run dev
```

Use `pty_read` to inspect logs and `pty_kill` to stop the process when you are done.

## Local Preview Rules

- Avoid relying on browser storage or APIs that may be blocked in restricted or embedded environments.
- Keep asset paths relative when possible.
- External links should use `target="_blank" rel="noopener noreferrer"`.
- For screenshots and interactive verification, use the `agent-browser` skill against the local dev URL.
