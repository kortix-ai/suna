/**
 * Wrapper-mode session tokens — Lumen's OWN auth, entirely separate from the
 * Kortix API key. HMAC-signed, `node:crypto` only (no JWT dependency):
 *
 *   token := base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))
 *
 * `POST /api/auth/login` mints one and returns it in the JSON body (the
 * client stores it and sends it as `Authorization: Bearer <token>` — the
 * SDK's REST calls don't carry cookies) AND sets it as an HttpOnly cookie
 * (the preview iframe's same-origin requests can't attach headers, but they
 * DO carry cookies automatically). `getRequestSession` checks both places.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'lumen_session';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  /** The demo "user id" — just the email they logged in with. */
  userId: string;
  iat: number;
  exp: number;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. Wrapper mode requires SESSION_SECRET to sign session tokens (see .env.example).',
    );
  }
  return secret;
}

function sign(body: string): string {
  return createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
}

/** Mint a signed session token for `userId`. */
export function signSession(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { userId, iat: now, exp: now + SESSION_TTL_SECONDS };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/** Verify a signed session token. Returns `null` on any invalid/expired/missing input. */
export function verifySession(token: string | null | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null; // SESSION_SECRET not configured — fail closed, not open.
  }

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.userId !== 'string' || !payload.userId) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Pull the bearer token out of an `Authorization: Bearer …` header, if present. */
function bearerFromHeader(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/** Pull the session cookie value out of the request's `Cookie` header, if present. */
function cookieFromHeader(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

/**
 * Resolve + verify the caller's app session: `Authorization: Bearer …` first
 * (the REST/SSE path), falling back to the `lumen_session` cookie (the
 * preview-iframe path, which can't set headers). Returns `null` if neither is
 * present or valid — the caller should respond 401.
 */
export function getRequestSession(req: Request): SessionPayload | null {
  return verifySession(bearerFromHeader(req)) ?? verifySession(cookieFromHeader(req));
}

/**
 * Minimal, credible demo login: any email-shaped string + (any non-empty
 * password, or an exact match against `DEMO_PASSWORD` if that env var is
 * set). There is no user directory — `userId` IS the email.
 */
export function checkDemoCredentials(email: string, password: string): boolean {
  // Length cap + non-overlapping character classes ([^\s@] can never match the
  // literal @ or . delimiters) keep this linear — the naive \S+@\S+\.\S+ form
  // backtracks polynomially on adversarial input (CodeQL js/polynomial-redos).
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(email)) return false;
  if (!password) return false;
  const expected = process.env.DEMO_PASSWORD;
  if (!expected) return true;

  // Constant-time compare (mirrors sign()/verifySession() above) — `===` on
  // strings short-circuits on the first mismatched byte, leaking the correct
  // password's length/prefix through response-timing.
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
