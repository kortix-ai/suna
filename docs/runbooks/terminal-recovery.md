# Terminal connection recovery

For a failed terminal, record the session, sandbox, PTY path, timestamp, and HTTP
status. Do not record bearer tokens, preview credentials, or WebSocket query strings.

The visible terminal wakes a stopped sandbox before creating its first PTY.
Readiness polling has a three-minute deadline. Other connection failures use
bounded retries and then show Retry. Hidden panels do not wake sandboxes.

## Identify the rejecting layer

- API authentication: correlate `[preview-ws] REFUSED` with the request time.
  Check the JWT verifier result. Browser close `1006` does not identify the cause.
- Daytona ingress authentication: JSON `401` with `code: UNAUTHORIZED` and
  `message: unauthorized: authentication failed:…`, or a redirect to
  `https://api.auth.daytona.io/user_management/authorize`. Refresh the cached
  preview credentials. This is not a sandbox signed-context rejection.
- Sandbox authentication: the daemon returns an authentication error such as
  `{"error":"unauthorized","reason":"malformed"}`. Preserve this refusal.
  Provider credential recovery must not remove service-key or user-context checks.
- Provider connectivity: compare public ingress with a loopback request from
  the same sandbox. A healthy daemon does not prove the provider ingress works.

The proxy refreshes rejected Daytona credentials once per read request. It
invalidates the cache but does not replay writes. A repeated provider rejection
returns `503 sandbox_provider_auth_unavailable`. A failed WebSocket handshake
discards its cached ingress so the next bounded connection attempt resolves it again.

## Verification

Use an isolated project. Open a session without opening Terminal, stop that
session, then click Terminal. Assert a readiness `503`, successful PTY creation,
and actual shell output from `printf`. Repeat after a stop/resume. Clean up the
test sessions and project.

Regression coverage: `e2e-preview-proxy.test.ts`, `provider-auth.test.ts`,
`ws-proxy-ingress-recovery.test.ts`, and the cold-terminal journey in
`tests/e2e/specs/13-sdk-only-session.spec.ts`.
