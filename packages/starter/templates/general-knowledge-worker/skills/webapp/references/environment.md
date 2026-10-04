# Environment

## Dev Server

Start the dev server with `pty_spawn` so the process stays alive while you iterate. Typical commands:

```bash
npm install
npm run dev
```

Use `pty_read` to inspect logs and `pty_kill` to stop the process when you are done.

## Local Preview Rules

- Sites may run inside sandboxed or embedded contexts, so avoid relying on `localStorage`, `sessionStorage`, cookies, or browser APIs that are blocked in restricted environments.
- Keep asset paths relative when possible.
- External links should use `target="_blank" rel="noopener noreferrer"`.
- For binary downloads, prefer JavaScript blob downloads instead of assuming direct file serving will work everywhere.
- For screenshots and interactive verification, use the `agent-browser` skill against the local dev URL instead of static snapshot tools.

## Packages

After copying the template, run `npm install` before starting the dev server. The existing package set is the baseline; add more packages only when the task clearly needs them.
