---
recorded: 2026-09-24T10:04:16Z
incident_date: 2026-09-24
commit: eeca7c9d97
---
# A server that answers before the request body ends desyncs every keep-alive client

**Near-miss.** The core lane failed about one run in five on `main` and on
PRs: 5 of 23 runs on 2026-09-23/24. A flow pushed through the Git proxy. The
next `git ls-remote` or `git pull` got a bare `400`. GH-17 also failed as
"expected a Git ref-policy rejection", which is the same fault on a push that
was meant to be rejected. The local-git fixture answered when `git
receive-pack` exited. At that time the chunked push body had not ended. Bun's
`fetch` put the socket back in its pool and wrote the next request onto it.
The fixture was still parsing the old body. It refused the new request at
parse level (`HPE_INTERNAL`) and answered `400` before its handler ran, so
its own error logging never fired. PR #7577.

**Rule.** An HTTP handler answers only after the request body has ended, or
it closes the connection. A handler that must answer early reads and discards
the rest of the body. A client that forwards a body the upstream may refuse
early does not reuse that connection.

**Enforcement.** `tests/unit/local-git-fixture.test.ts` holds back a push
body's terminator on a raw socket. It asserts that no answer arrives first,
then sends a second request on the same socket. The receive-pack upstream
`fetch` in `apps/api/src/git-proxy/index.ts` sets `keepalive: false`.
`receive-pack-gate.test.ts` asserts that no later upstream request reuses the
push's connection.
