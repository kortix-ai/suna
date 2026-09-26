/**
 * The CLI's one-shot callback server must be local: `kortix login` listens on
 * `http://<name>.localhost:<port>/callback`. Anything else — other protocols,
 * other hosts — is refused before the page offers to mint a token.
 *
 * A SUBDOMAIN of `.localhost` is accepted, not just the bare name, and that is
 * load-bearing rather than cosmetic. The Cloudflare WAF in front of every
 * non-prod origin 403s any query string carrying a bare `127.0.0.1` or
 * `localhost` host, so both values this validator used to accept were rejected
 * at the edge before this page ever rendered — `kortix login` could not
 * complete against dev or staging by any client-side means. Measured
 * 2026-09-01 against dev.kortix.com: `127.0.0.1` -> 403, `localhost` -> 403,
 * `cli.localhost` -> 401 (past the WAF, at the ordinary non-prod auth gate).
 *
 * It is no weaker. RFC 6761 §6.3 reserves `.localhost` and requires resolvers
 * to map it to loopback; verified on macOS, where `cli.localhost` resolves to
 * 127.0.0.1. An attacker who could point `evil.localhost` somewhere else
 * already controls the victim's resolver, and would equally control bare
 * `localhost`.
 */

export interface CallbackValidation {
  ok: boolean;
  reason: string;
  display: string;
}

export function validateCallback(raw: string | null): CallbackValidation {
  if (!raw) return { ok: false, reason: 'No callback URL provided.', display: '' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Callback is not a valid URL.', display: '' };
  }
  if (url.protocol !== 'http:') {
    return {
      ok: false,
      reason: 'Callback must use http:// — refusing other protocols.',
      display: url.origin,
    };
  }
  if (!isLoopbackHostname(url.hostname)) {
    return {
      ok: false,
      reason: 'Callback must be a localhost address.',
      display: url.origin,
    };
  }
  return { ok: true, reason: '', display: `${url.hostname}:${url.port}` };
}

/**
 * `127.0.0.1`, `localhost`, or any `*.localhost` subdomain — every name RFC
 * 6761 guarantees resolves to loopback. Anything else is refused.
 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
  return host.endsWith('.localhost') && host.length > '.localhost'.length;
}
