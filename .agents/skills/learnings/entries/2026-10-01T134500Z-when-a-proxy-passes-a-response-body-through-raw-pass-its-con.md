---
recorded: 2026-10-01T13:45:00Z
incident_date: 2026-10-01
---
# When a proxy passes a response body through raw, pass its Content-Encoding through too

**Rule:** The preview proxy fetches upstream with `decompress: false`, so
the body it forwards is the raw bytes the daemon sent. Forward the daemon's
`content-encoding` and `content-length` with it. Never delete them on the
assumption that `fetch` decoded the body. When you measure what `fetch` does
to a compressed response, measure it with the exact options the proxy passes.
A route is not verified for clients until a real client (curl with
`Accept-Encoding: gzip`, Bun `fetch`, a browser) has read it through the real
proxy.

**Trigger surface:** changing `apps/api/src/http/sandbox-proxy/preview.ts`
response headers; adding a path to `forwardsClientEncoding`; moving an SDK,
CLI or web read onto the daemon's `/kortix/runtime/*` namespace; any proxy
test that mocks `fetch` and hands back a decoded body.

**Incident:** 2026-10-01, found before merge, no user impact. The proxy
forwarded the client's `Accept-Encoding` on `/kortix/runtime/*`, received
gzip, and removed `content-encoding`, because its test had measured a default
`fetch` (which decodes) and not the proxy's own call (which does not). Every
client that sent `Accept-Encoding: gzip` got gzip bytes labelled as JSON. On
`main` no client read that namespace through the proxy. The W5 branch moved
the SDK's `session.messages()` and the CLI's reply read onto it: the verb
threw "Failed to parse JSON" under Bun, and `kortix sessions chat` could not
read a reply on a real stack. The branch's earlier real-sandbox runs did not
include a client read of that route. Found by a benchmark driver whose reads
of the route returned 6 KB of unparseable bytes.

**Enforcement:** `apps/api/src/services/sandbox-proxy/preview-encoding-passthrough.test.ts`
measures a real socket with the proxy's fetch options;
`apps/api/src/__tests__/e2e-preview-proxy.test.ts` asserts the proxy keeps
`content-encoding`; flow `RUN-2` (both harnesses, real sandboxes) reads
`/p/<sbx>/8000/kortix/runtime/messages/<root>` with `Accept-Encoding: gzip`
and fails when the body does not decode (verified against the old code).
