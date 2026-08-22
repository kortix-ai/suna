/**
 * FRAMING / hop-by-hop headers Kortix REJECTS with a 400
 * (apps/api/src/secrets/http-broker.ts BLOCKED_REQUEST_HEADERS). The shim drops
 * them before relaying so an ordinary request does not turn into
 * `400 request header is managed by Kortix: <name>`.
 *
 * `authorization` and `cookie` are DELIBERATELY NOT dropped. They are the
 * credential-carrying headers, and the whole point of this mode is that the
 * agent puts a HANDLE where it would put the real credential — `curl -H
 * 'Authorization: Bearer <handle>'`. Dropping them here stripped the handle
 * before Kortix could substitute it, so a Bearer/token/cookie request left
 * carrying nothing and the upstream answered 401. They are forwarded; Kortix
 * swaps the handle for the real value server-side.
 *
 * Kept as a literal copy rather than an import: this binary must not drag
 * apps/api's http-broker (and its DB and config dependencies) into the sandbox.
 * `blocked-headers.test.ts` reads the broker's real list off disk and asserts
 * the two still agree — that tripwire exists because this copy already drifted
 * once and broke every deployed daemon (the accept-encoding incident).
 *
 * It lives in its OWN module so both `shim.ts` and `relay-client.ts` can read it
 * without importing each other.
 */
export const BLOCKED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
