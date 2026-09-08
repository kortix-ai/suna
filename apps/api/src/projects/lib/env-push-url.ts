/**
 * WHERE A SESSION'S ENV IS PUSHED — which, on a cell, is not the same place for
 * every session.
 *
 * `POST <preview>/kortix/env` carries the session's configuration: its Kortix
 * token, the gateway URL, the model. A microVM has one daemon, so the URL alone
 * addresses it. A CELL SANDBOX HOLDS MANY ISOLATES, one per session, and the
 * worker picks one from `?c=`, or from the path, or — failing both — from the
 * node's `KORTIX_SESSION_ID`, or `"default"`.
 *
 * With no session anywhere in the request, every session's env landed in ONE
 * isolate. Measured on dev 2026-09-09, two sessions on
 * sbx_01M21M9535JC73X3XRH6N28D0V after `[env-sync] push=sent` for both:
 *
 *   GET /kortix/env?c=53da130d…  ->  {"keys":[]}
 *   GET /kortix/env?c=31ec57c4…  ->  {"keys":[]}
 *
 * Their model and gateway were present (from the node's env) but
 * `credential.length` was 0 — no `KORTIX_TOKEN` — so every model call went out
 * unauthenticated and the turn hung. What a user sees is a session that spins
 * and then answers with the scripted fixture, because a cell with no model
 * config falls back to `SCRIPT`:
 *
 *   user:      hello
 *   assistant: I ran the command and wrote proof.txt
 *
 * The query is safe for every runtime: a daemon ignores a parameter it does not
 * read, and this is a direct call to the sandbox's own origin, not through the
 * proxy that drops query strings.
 */

/** The env-push URL for this session. `?c=` is what a cell reads first. */
export function envPushUrl(previewUrl: string, sessionId: string | null | undefined): string {
  const base = `${String(previewUrl ?? '').replace(/\/+$/, '')}/kortix/env`;
  const id = sessionId?.trim();
  return id ? `${base}?c=${encodeURIComponent(id)}` : base;
}
