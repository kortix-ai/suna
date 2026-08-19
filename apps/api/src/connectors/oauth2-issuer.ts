/**
 * Issuer binding for the authorization-code flow (MCP 2026-07-28).
 *
 * RFC 9207 exists because an authorization response carries no proof of WHO
 * issued the code. A client that talks to several authorization servers can be
 * fed a code minted by a hostile one and redeem it against an honest one —
 * authorization-code injection. The defence is to record the issuer when the
 * flow starts and compare it to the `iss` the callback presents.
 *
 * The spec validates a PRESENT `iss`. An absent one is not an error: most
 * deployed servers still omit it, and failing closed on absence would break
 * every provider that has not adopted RFC 9207 yet.
 */
export type AuthorizationIssuerVerdict =
  | { ok: true }
  | { ok: false; errorCode: 'issuer_mismatch' };

/** Issuers compare by origin + path, ignoring one trailing slash (RFC 8414 §2). */
function canonicalIssuer(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function validateAuthorizationIssuer(input: {
  received: string | null | undefined;
  recorded: string | null | undefined;
}): AuthorizationIssuerVerdict {
  if (!input.received) return { ok: true };
  // Nothing recorded: applications saved before the issuer was persisted have
  // no baseline to compare against. Re-authorizing records one.
  if (!input.recorded) return { ok: true };
  const received = canonicalIssuer(input.received);
  const recorded = canonicalIssuer(input.recorded);
  if (!received || !recorded || received !== recorded) {
    return { ok: false, errorCode: 'issuer_mismatch' };
  }
  return { ok: true };
}

/**
 * SEP-837. OpenID Connect defines `application_type` `web` (https redirect,
 * no localhost) and `native` (loopback allowed). A self-hosted Kortix on a
 * loopback origin registered as `web` is rejected by any OIDC-based server.
 */
export function oauth2ApplicationTypeFor(redirectUri: string): 'web' | 'native' {
  try {
    const url = new URL(redirectUri);
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]';
    return loopback ? 'native' : 'web';
  } catch {
    return 'web';
  }
}
