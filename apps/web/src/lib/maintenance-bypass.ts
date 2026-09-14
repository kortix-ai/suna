/**
 * Admin maintenance bypass — signed cookie shared by the middleware (verify) and
 * the `/api/maintenance/bypass` route (mint).
 *
 * When maintenance is at the `blocking` (Full Lockdown) level, middleware
 * redirects everyone to `/maintenance`. A platform admin can mint a short-lived
 * bypass token from that page; middleware honors it so admins keep access even
 * during a full lockdown. The token is an HMAC-signed `${exp}.${userId}.${sig}`
 * string set as an httpOnly cookie, so it can't be forged client-side or read by
 * scripts.
 *
 * BOUND TO THE MINTING ADMIN. The token used to be `${exp}.${sig}` — a bare
 * capability with no identity in it at all: any valid, unexpired copy worked
 * for anyone who held it, for the full 8h TTL, with no way to tell whose
 * lockdown-era access it represented. `userId` is now part of the SIGNED
 * payload, so tampering with it (swapping in a different admin's id without
 * the server secret) invalidates the signature — this is real cryptographic
 * binding, not an unchecked label. `middleware.ts`'s verify call stays a
 * single unauthenticated boolean check (no live cross-reference against the
 * CURRENT request's signed-in user): the maintenance gate runs before this
 * middleware resolves `user` at all, and reordering that resolution to enable
 * a live comparison is exactly the "restructure the security-critical
 * middleware" this task was told not to do. What the binding buys instead:
 * the cookie's own contents now say who it was minted for (useful for
 * clearing on THAT user's sign-out and for future per-admin revocation), and
 * a stolen/replayed token can no longer be silently relabeled.
 *
 * The lockdown is a traffic-shedding / UX gate, not a security boundary — the
 * backend still enforces real auth on every request — but signing the cookie
 * keeps casual bypass out and only lets through tokens minted after a
 * server-side admin-role check.
 *
 * Uses Web Crypto (`crypto.subtle`) so the exact same code runs in both the Edge
 * middleware runtime and the Node route handler.
 */

export const MAINTENANCE_BYPASS_COOKIE = 'kortix-maint-bypass';

/** How long a minted bypass lasts, in seconds (8h — long enough for a rollout). */
export const MAINTENANCE_BYPASS_TTL_SECONDS = 8 * 60 * 60;

/**
 * Server-only signing secret. Must resolve to the SAME value in the middleware
 * and the route handler. Prefer an explicit secret; fall back to the Supabase
 * service-role key (server-only, present in every deploy). We deliberately do
 * NOT fall back to the public anon key — that would make the token forgeable.
 */
function bypassSecret(): string {
  return (
    process.env.MAINTENANCE_BYPASS_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    // Last-resort dev fallback so local (no service key) still functions; not a
    // real secret, but the lockdown is not a security boundary.
    'kortix-maintenance-bypass-dev-secret'
  );
}

const encoder = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(bypassSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(sig);
}

/** Constant-time-ish string compare (both inputs are fixed-length hex here). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Mint a bypass token valid until `nowSeconds + ttlSeconds`, bound to
 * `userId` — the admin who requested it (`POST /api/maintenance/bypass`
 * already resolves this via `supabase.auth.getUser()` before calling in).
 */
export async function createBypassToken(
  userId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = MAINTENANCE_BYPASS_TTL_SECONDS,
): Promise<string> {
  const exp = nowSeconds + ttlSeconds;
  const payload = `${exp}.${userId}`;
  const sig = await sign(payload);
  return `${payload}.${sig}`;
}

/**
 * Verify a bypass token: valid signature AND not expired.
 *
 * The signature covers `${exp}.${userId}` together, so an attacker who edits
 * EITHER field — extends the expiry, or relabels the token as a different
 * admin's — invalidates it without the server secret. A pre-binding token
 * (the old two-part `${exp}.${sig}` shape) has no second `.` and is rejected
 * by the same `lastDot <= firstDot` check that rejects every other malformed
 * shape — a lockdown-era cookie minted by the previous version simply stops
 * verifying after this deploys, which is the correct fail-closed behavior for
 * a format change on a privileged token.
 */
export async function verifyBypassToken(
  token: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!token) return false;
  const firstDot = token.indexOf('.');
  const lastDot = token.lastIndexOf('.');
  if (firstDot <= 0 || lastDot <= firstDot) return false;
  const expPart = token.slice(0, firstDot);
  const userIdPart = token.slice(firstDot + 1, lastDot);
  const sigPart = token.slice(lastDot + 1);
  if (!userIdPart || !sigPart) return false;
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp <= nowSeconds) return false;
  const expected = await sign(`${expPart}.${userIdPart}`);
  return safeEqual(sigPart, expected);
}
