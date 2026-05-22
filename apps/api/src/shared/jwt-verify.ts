/**
 * Local JWT verification using Web Crypto API (no network roundtrip).
 *
 * Supabase JWTs are signed with ES256 (ECDSA P-256). We fetch the JWKS once
 * at startup and verify tokens locally — no call to /auth/v1/user per request.
 *
 * Why: supabase.auth.getUser() makes a live HTTP call every time. On local dev
 * any transient blip to 127.0.0.1:54321 → intermittent 401 on valid tokens.
 * Local verification is also ~10x faster.
 *
 * Fallback: if JWKS fetch fails (Supabase not up yet) or key is unknown, we
 * fall back to the network call so nothing breaks during cold starts.
 */

import { config } from '../config';

interface JwkKey {
  alg: string;
  crv?: string;
  kty: string;
  use?: string;
  kid: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

interface JwksResponse {
  keys: JwkKey[];
}

// ── JWKS cache ────────────────────────────────────────────────────────────────

/** kid → CryptoKey for fast lookup */
const keyCache = new Map<string, CryptoKey>();
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

async function loadJwks(): Promise<void> {
  const supabaseUrl = config.SUPABASE_URL;
  if (!supabaseUrl) return;

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return;

    const jwks: JwksResponse = await res.json();

    for (const jwk of jwks.keys) {
      try {
        let algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams;

        if (jwk.alg === 'ES256' || (jwk.kty === 'EC' && jwk.crv === 'P-256')) {
          algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as EcKeyImportParams;
        } else if (jwk.alg === 'RS256' || jwk.kty === 'RSA') {
          algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as RsaHashedImportParams;
        } else {
          continue; // Unknown algorithm — skip
        }

        const key = await crypto.subtle.importKey(
          'jwk',
          jwk as JsonWebKey,
          algorithm,
          false,
          ['verify'],
        );
        keyCache.set(jwk.kid, key);
      } catch {
        // Skip malformed keys
      }
    }

    jwksFetchedAt = Date.now();
  } catch {
    // Supabase not reachable yet — will retry on next auth check
  }
}

async function ensureKeys(): Promise<void> {
  if (keyCache.size > 0 && Date.now() - jwksFetchedAt < JWKS_TTL_MS) return;
  await loadJwks();
}

// ── JWT parsing ───────────────────────────────────────────────────────────────

function base64urlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padding));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  role?: string;
  aal?: string;
  session_id?: string;
  is_anonymous?: boolean;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface VerifyResult {
  ok: true;
  userId: string;
  email: string;
  payload: JwtPayload;
}

interface VerifyFailure {
  ok: false;
  reason: string;
}

/**
 * Verify a Supabase JWT locally using cached JWKS.
 *
 * Returns `{ ok: false, reason: 'no-keys' }` when JWKS is unavailable —
 * callers should fall back to the network getUser() call in that case.
 */
export async function verifySupabaseJwt(token: string): Promise<VerifyResult | VerifyFailure> {
  await ensureKeys();

  if (keyCache.size === 0) {
    return { ok: false, reason: 'no-keys' };
  }

  // Split the JWT
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  const [headerB64, payloadB64, sigB64] = parts;

  // Parse header to find the right key
  let header: JwtHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64)));
  } catch {
    return { ok: false, reason: 'bad-header' };
  }

  // Look up key — by kid if present, otherwise first key
  let key: CryptoKey | undefined;
  if (header.kid) {
    key = keyCache.get(header.kid);
    if (!key) {
      // Unknown kid — JWKS may have rotated, try refreshing once
      await loadJwks();
      key = keyCache.get(header.kid);
    }
  } else {
    key = keyCache.values().next().value;
  }

  if (!key) {
    return { ok: false, reason: 'no-key-for-kid' };
  }

  // Determine verify algorithm from header
  let algorithm: AlgorithmIdentifier | EcdsaParams | RsaPssParams;
  if (header.alg === 'ES256') {
    algorithm = { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams;
  } else if (header.alg === 'RS256') {
    algorithm = { name: 'RSASSA-PKCS1-v1_5' };
  } else {
    return { ok: false, reason: `unsupported-alg:${header.alg}` };
  }

  // Verify signature
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToBytes(sigB64) as unknown as BufferSource;

  try {
    const valid = await crypto.subtle.verify(algorithm, key, signature, signingInput);
    if (!valid) {
      return { ok: false, reason: 'bad-signature' };
    }
  } catch {
    return { ok: false, reason: 'verify-error' };
  }

  // Parse and validate payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    return { ok: false, reason: 'expired' };
  }

  // Require a subject (user id)
  if (!payload.sub) {
    return { ok: false, reason: 'no-sub' };
  }

  return {
    ok: true,
    userId: payload.sub,
    email: payload.email || payload.user_metadata?.email as string || '',
    payload,
  };
}

// ── Eager JWKS load on import ─────────────────────────────────────────────────
// Start fetching immediately so keys are ready before the first request.
loadJwks().catch(() => {});
