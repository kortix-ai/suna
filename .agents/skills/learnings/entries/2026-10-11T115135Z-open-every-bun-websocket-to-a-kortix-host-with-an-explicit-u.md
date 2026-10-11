---
recorded: 2026-10-11T11:51:35Z
incident_date: 2026-10-11
---
# Open every Bun WebSocket to a Kortix host with an explicit User-Agent

**Rule:** In code that runs under Bun, open a WebSocket to a Kortix host only through the package's helper, which sets a `User-Agent` header: `openRelaySocket` in `packages/agent-tunnel/src/agent/agent.ts`, and `openKortixWebSocket` in `apps/cli/src/api/kortix-socket.ts`. Bun's `WebSocket` sends no `User-Agent`. Cloudflare in front of `api`, `staging-api` and `dev-api.kortix.com` answers a request without one with 403. The client reports only `Expected 101 status code`, and the close code is 1002. Bun's `fetch` does send a `User-Agent`, so HTTP calls hide the fault.

**Trigger surface:** Adding a WebSocket client to `@kortix/agent-tunnel`, the `kortix` CLI, or any other Bun process that reaches the Kortix API. Local tests pass because localhost has no Cloudflare in front of it.

**Incident:** 2026-10-11, found while verifying #9532.
- `bunx @kortix/agent-tunnel connect` failed with "Cannot reach the relay" against every hosted API.
- The `kortix` CLI's sandbox port proxy (`kortix sessions forward`, `opencode attach`) closed every WebSocket with 1011.
- Node, Electron and the desktop app were not affected: they send `User-Agent: node`.
- A second Bun-only fault hid behind the first. Bun fires `close` synchronously inside `socket.close()`, and the credential probe closed before it resolved, so it reported `unreachable` even on `auth_ok`.
- The PTY had already been fixed on its own (`pty-socket.ts`), and the fix was never applied to the other two clients.

**Enforcement:**
- `apps/cli/src/__tests__/kortix-socket.test.ts`, "every CLI WebSocket opens through openKortixWebSocket".
- `packages/agent-tunnel/src/agent/service-lifecycle.test.ts`, "every relay socket opens through openRelaySocket".
- Both tests fail on any `new WebSocket(` in non-test source. The upgrade tests in both files assert the header the server receives.
