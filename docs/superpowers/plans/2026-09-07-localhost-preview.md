# Localhost preview transport

## Approved design

User approval: 2026-09-07, after the framework-independent localhost bridge proposal.

App previews retain their public URL and authorization checks. The API resolves
provider ingress for daemon port 8000. A signed target-port ticket selects the
app port inside the sandbox. The daemon proxies the original path to localhost.
HTTP and WebSocket requests use localhost Host, Origin, Referer and forwarded
host/protocol headers. The API retains redirect rewriting and host-only cookies.
No generated project config changes or framework host-check disablement.

Rollout review found that busy sessions can defer daemon swaps. Select the bridge
only after an explicit, bounded live capability probe. Retain legacy ingress for
old/unconfirmed daemons. Never replay an app request as a transport fallback.

## Global constraints

- Worktree: `suna-network-block-request`; branch: `network-block-request`.
- Preserve session-data authorization using the logical port, not transport port.
- Never pass provider or platform credentials to user app processes.
- Ticket: header `X-Kortix-Preview-Target`, value `port.exp.signature`.
- Signature: base64url HMAC-SHA256 over `localhost-preview:port.exp`, key is the sandbox service key.
- Expiry is Unix seconds, 60-second TTL. Strict decimal port, range 1–65535.
- Block daemon, both configured OpenCode ports, and credential-bearing egress ports.
- Invalid tickets fail closed before any control or app route runs.
- Public share authorization remains read-only; its ticket is not a user context.
- Existing control routes and PTY behavior remain unchanged.
- Keep actual app paths, query strings, streaming bytes and WebSocket protocols.
- Do not merge to main without explicit merge approval.

## Tasks

### Task 1: Sandbox bridge

- [x] Add failing real-HTTP daemon tests for signed-ticket dispatch, localhost headers,
  payload/path/query preservation, stripped credentials, blocked ports and forged tickets.
- [x] Implement pure ticket verification and loopback HTTP forwarding in
  `apps/kortix-sandbox-agent-server/src/preview-bridge.ts`.
- [x] Dispatch before control routes in `buildOpencodeApp`.
- [x] Add real WebSocket coverage and bridge dispatch in `startProxy`.
  Preserve negotiated subprotocol, binary/text messages, early messages, disconnects.
- [x] Run daemon tests and typecheck.

### Task 2: API transport

- [x] Add failing tests for app ports resolving through daemon ingress, signed tickets,
  protected-port behavior, and incoming internal-header removal.
- [x] Add ticket signing in `apps/api/src/sandbox-proxy/preview-bridge.ts`.
- [x] Change only app preview ingress in HTTP and WebSocket resolvers.
  Keep logical upstream port for existing authorization and lifecycle guards.
- [x] Forward app WebSocket Origin, cookies and subprotocol offers through both hops.
- [x] Retain redirect and response-cookie behavior. Never retry ambiguous app mutations.
- [x] Run API regression tests and typecheck.
- [x] Add live capability selection and old-daemon compatibility tests.

### Task 3: Verification and delivery

- [x] Exercise real Vite, Next.js Server Actions, and plain HTTP through the bridge locally.
- [x] Verify HMR, redirects, cookies and negative authorization paths locally.
- [ ] Run repository tests, review changes, document evidence and incident learning.
- [ ] Commit, create draft PR with preview label, verify exact preview SHA.
- [ ] Report remaining deployment gap. Wait for explicit main merge approval.
