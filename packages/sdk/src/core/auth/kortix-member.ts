/**
 * The signed-in Kortix member, on any runtime.
 *
 * Kortix vouches for a person in three places, and each one hands the same
 * facts over in its own shape:
 *
 *   - An App's browser asks its gate: `GET /_kortix/viewer` (see
 *     `fetchKortixAppViewer`).
 *   - An App's server reads the gate's signed header (`createKortixAppGuard`
 *     in `@kortix/sdk/server`).
 *   - A backend, or any server holding a Kortix key set, receives a short-lived
 *     ES256 token that Kortix signed for that one audience.
 *
 * `readKortixMember` turns any of those shapes into one `KortixMember`, and
 * `requireKortixMember` enforces who may proceed. Group-based access uses the
 * same Kortix groups that decide who may open the App, so a person added to a
 * group in Kortix gains the matching rights in every App and backend, with no
 * user table of the App's own.
 *
 * Where the claims come from is the caller's choice:
 *
 * ```ts
 * // A runtime that verified the token already (a database's server
 * // functions, JWT middleware): pass what it verified.
 * const me = requireKortixMember(await ctx.auth.getUserIdentity(), { groups: ['Finance'] });
 *
 * // A plain server: verify the bearer here. With no options, the key set,
 * // issuer and audience come from KORTIX_AUTH_JWKS / _ISSUER / _AUDIENCE,
 * // which Kortix sets on every backend.
 * const me = await verifyKortixMemberToken(bearer);
 * ```
 *
 * No dependency and no framework: WebCrypto only, so it runs in a browser,
 * Node 18+, Bun, Deno and a Worker alike.
 */

import { safeEnv } from '../http/env';

/** The person Kortix vouched for. Every field is present; unknown ones are null or empty. */
export interface KortixMember {
  /** The Kortix user id. Stable for life; key your rows on it. */
  userId: string;
  email: string | null;
  /** Display name from the member's profile. */
  name: string | null;
  /** Profile picture URL. */
  picture: string | null;
  /** Names of the member's Kortix groups in this account. Unique within the account. */
  groups: string[];
  /** Ids of the same groups. Stable across a rename. */
  groupIds: string[];
  /** The member's account role: `owner`, `admin` or `member`. */
  role: string | null;
  accountId: string | null;
  projectId: string | null;
}

/** Who may proceed. Each list means "any one of these"; both lists must hold. */
export interface KortixMemberRequirement {
  /** Group names or group ids. */
  groups?: string[];
  /** Account roles, e.g. `['owner', 'admin']`. */
  roles?: string[];
}

/**
 * Why a member was refused. `unauthenticated`: nobody, or a token that failed a
 * check. `forbidden`: a real member outside the required groups or roles.
 * Map it to HTTP 401 and 403.
 */
export class KortixMemberError extends Error {
  readonly code: 'unauthenticated' | 'forbidden';
  constructor(code: 'unauthenticated' | 'forbidden', message: string) {
    super(message);
    this.name = 'KortixMemberError';
    this.code = code;
  }
}

type Claims = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** A list claim. Some runtimes hand custom claims over as JSON text. */
function list(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * The member these claims name, or `null` for nobody. Accepts raw token claims
 * (`sub`, `picture`), an identity a runtime already verified (`subject`,
 * `pictureUrl`), the App gate's answer (`user_id`), and a server-side viewer
 * from `readAppViewer` or `createKortixAppGuard` (`userId`). Never verifies a
 * signature: pass only claims something already verified, or use
 * `verifyKortixMemberToken`.
 */
export function readKortixMember(claims: unknown): KortixMember | null {
  if (!claims || typeof claims !== 'object') return null;
  const c = claims as Claims;
  const userId = text(c.sub) ?? text(c.subject) ?? text(c.user_id) ?? text(c.userId);
  if (!userId) return null;
  return {
    userId,
    email: text(c.email),
    name: text(c.name),
    picture: text(c.picture) ?? text(c.pictureUrl),
    groups: list(c.groups),
    groupIds: list(c.group_ids ?? c.groupIds),
    role: text(c.role),
    accountId: text(c.account_id) ?? text(c.accountId),
    projectId: text(c.project_id) ?? text(c.projectId),
  };
}

/**
 * The member, or a `KortixMemberError`. An empty requirement list refuses: a
 * rule that names no group admits nobody, rather than everybody.
 */
export function requireKortixMember(claims: unknown, requirement: KortixMemberRequirement = {}): KortixMember {
  const member = readKortixMember(claims);
  if (!member) throw new KortixMemberError('unauthenticated', 'Sign in with Kortix to continue.');
  const { groups, roles } = requirement;
  if (groups && !groups.some((group) => member.groups.includes(group) || member.groupIds.includes(group))) {
    throw new KortixMemberError('forbidden', `Only members of ${groups.join(' or ') || 'no group'} may do this.`);
  }
  if (roles && !roles.some((role) => member.role === role)) {
    throw new KortixMemberError('forbidden', `Only ${roles.join(' or ') || 'no role'} members may do this.`);
  }
  return member;
}

// ── Token verification ───────────────────────────────────────────────────────

/** A JSON Web Key Set, as an object, JSON text, a `data:` URI or an https URL. */
export type KortixMemberKeySet = { keys: JsonWebKey[] } | string;

export interface VerifyKortixMemberTokenOptions {
  /** Default: `KORTIX_AUTH_JWKS`. */
  jwks?: KortixMemberKeySet;
  /** Default: `KORTIX_AUTH_ISSUER`. */
  issuer?: string;
  /** Default: `KORTIX_AUTH_AUDIENCE`. */
  audience?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const CLOCK_SKEW_SECONDS = 60;
const remoteKeySets = new Map<string, Promise<{ keys: JsonWebKey[] }>>();

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlJson(value: string): Claims {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as Claims;
}

async function loadKeySet(
  source: KortixMemberKeySet,
  fetchImpl: NonNullable<VerifyKortixMemberTokenOptions['fetch']>,
): Promise<{ keys: JsonWebKey[] }> {
  if (typeof source !== 'string') return source;
  if (source.startsWith('data:')) {
    const comma = source.indexOf(',');
    const meta = source.slice(5, comma);
    const payload = source.slice(comma + 1);
    const body = meta.endsWith(';base64')
      ? new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)))
      : decodeURIComponent(payload);
    return JSON.parse(body) as { keys: JsonWebKey[] };
  }
  if (/^https?:\/\//.test(source)) {
    let cached = remoteKeySets.get(source);
    if (!cached) {
      cached = fetchImpl(source, { headers: { accept: 'application/json' } }).then(async (res) => {
        if (!res.ok) throw new Error(`key set ${res.status}`);
        return (await res.json()) as { keys: JsonWebKey[] };
      });
      // A failed fetch is not cached: the next request tries again.
      cached.catch(() => remoteKeySets.delete(source));
      remoteKeySets.set(source, cached);
    }
    return cached;
  }
  return JSON.parse(source) as { keys: JsonWebKey[] };
}

/**
 * Verifies a Kortix-signed member token (ES256) and returns the member. Checks
 * the signature, `exp` (60 s skew), the issuer and the audience. Every failure,
 * including a missing key set, is a `KortixMemberError` with code
 * `unauthenticated`: nothing is ever accepted unchecked.
 */
export async function verifyKortixMemberToken(
  token: string,
  options: VerifyKortixMemberTokenOptions = {},
): Promise<KortixMember> {
  const refuse = (why: string): never => {
    throw new KortixMemberError('unauthenticated', `Kortix sign-in token refused: ${why}.`);
  };
  const jwks = options.jwks ?? safeEnv('KORTIX_AUTH_JWKS');
  const issuer = options.issuer ?? safeEnv('KORTIX_AUTH_ISSUER');
  const audience = options.audience ?? safeEnv('KORTIX_AUTH_AUDIENCE');
  if (!jwks) return refuse('no key set configured (KORTIX_AUTH_JWKS)');

  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return refuse('malformed');
  const [head, body, signature] = parts as [string, string, string];
  let header: Claims;
  let claims: Claims;
  try {
    header = base64UrlJson(head);
    claims = base64UrlJson(body);
  } catch {
    return refuse('malformed');
  }
  if (header.alg !== 'ES256') return refuse('unsupported algorithm');

  let keySet: { keys: JsonWebKey[] };
  try {
    keySet = await loadKeySet(jwks, options.fetch ?? ((input, init) => fetch(input, init)));
  } catch {
    return refuse('key set unavailable');
  }
  const candidates = (keySet.keys ?? []).filter(
    (key) => key.kty === 'EC' && (header.kid === undefined || (key as { kid?: string }).kid === header.kid),
  );
  if (candidates.length === 0) return refuse('unknown key');

  const signed = new TextEncoder().encode(`${head}.${body}`);
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64UrlBytes(signature);
  } catch {
    return refuse('malformed');
  }
  let valid = false;
  for (const jwk of candidates) {
    try {
      const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...material } = jwk as JsonWebKey & { kid?: string };
      const key = await crypto.subtle.importKey('jwk', material, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'verify',
      ]);
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, signed)) {
        valid = true;
        break;
      }
    } catch {
      // A key this runtime cannot import is not the one that signed.
    }
  }
  if (!valid) return refuse('bad signature');

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) return refuse('expired');
  if (issuer && claims.iss !== issuer) return refuse('wrong issuer');
  if (audience) {
    const aud = claims.aud;
    if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return refuse('wrong audience');
  }
  const member = readKortixMember(claims);
  if (!member) return refuse('no subject');
  return member;
}
