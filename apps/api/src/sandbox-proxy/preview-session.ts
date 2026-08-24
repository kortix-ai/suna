/**
 * The credential a preview ORIGIN carries after its first authenticated request.
 *
 * A preview host (`dev-p8081-<label>.p.kortix.com`) is not the API host, so none
 * of the API's own credentials reach it: no Authorization header (the browser is
 * navigating, not calling), and not the host-only `__preview_session` cookie
 * scoped to `Path=/v1/p/`. The first request therefore carries a one-shot
 * `?token=`, and everything after it rides a cookie minted here.
 *
 * ## Why signed rather than remembered
 *
 * The previous subdomain path kept authenticated hosts in a per-process `Map`
 * keyed by IP + User-Agent. That is correct for exactly one server process. The
 * API runs several ECS tasks behind one load balancer, so the second request of
 * a preview lands on a task that never saw the handshake and 401s — and keying
 * on IP + UA also means anyone behind the same NAT and browser build inherits
 * the grant. A signed, self-describing cookie removes both properties: any task
 * can verify it, and it names exactly one preview.
 *
 * ## Why two cookies
 *
 * A preview is normally an iframe inside the Kortix web app, which makes it a
 * THIRD-PARTY context. Chrome's third-party cookie restrictions and Safari's
 * partitioning mean an ordinary cookie may never come back. `Partitioned`
 * (CHIPS) is the supported form there, but a partitioned cookie set inside that
 * iframe is not visible when the same URL is later opened in its own tab. So we
 * set both: the partitioned copy serves the embed, the unpartitioned copy serves
 * the top-level tab. Verification accepts either.
 *
 * Payload is bound to (sandbox label, port): a cookie minted for one preview is
 * rejected on another even if a browser were to send it there.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

export const PREVIEW_COOKIE = '__kortix_preview';
export const PREVIEW_COOKIE_PARTITIONED = '__kortix_preview_chips';

/** Matches the previous in-memory grant window. */
export const PREVIEW_SESSION_TTL_SECONDS = 4 * 60 * 60;
/** Public shares are short-lived by design; keep the cookie no longer. */
export const PREVIEW_SHARE_TTL_SECONDS = 15 * 60;

interface PreviewSessionBase {
  /** DNS label the cookie is bound to — must match the host being served. */
  sandboxLabel: string;
  /**
   * Canonical external id. Carried so a cookie hit needs no lookup at all: the
   * label→id resolution is the one query on this path that cannot use an index.
   */
  sandboxId: string;
  port: number;
  exp: number;
}

export type PreviewSession =
  | (PreviewSessionBase & {
      kind: 'principal';
      userId: string;
      callerSessionId: string | null;
      sandboxAuthored: boolean;
    })
  | (PreviewSessionBase & {
      kind: 'public_share';
      shareId: string;
      mode: string;
      /**
       * Set for a FILE share: the one file this link grants, on the static-web
       * port. Carried on the session so the constraint survives the cookie —
       * without it, the second request could ask that port for anything.
       */
      filePath?: string | null;
    });

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
  const pad = 4 - (s.length % 4);
  const padded = pad < 4 ? s + '='.repeat(pad) : s;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Domain-separated from every other use of API_KEY_SECRET, so a preview cookie
 * can never be replayed as an API key hash or an actor context and vice versa.
 */
function signingKey(): Buffer {
  return createHmac('sha256', config.API_KEY_SECRET).update('preview-session:v1').digest();
}

/**
 * `Omit` over a union collapses to the shared keys, which would silently drop
 * `userId` / `shareId` from the mint payload. Distribute it instead.
 */
type Unexpired<T> = T extends unknown ? Omit<T, 'exp'> : never;

export function mintPreviewSession(session: Unexpired<PreviewSession>, ttlSeconds: number): string {
  const payload = { ...session, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = base64urlEncode(createHmac('sha256', signingKey()).update(payloadB64).digest());
  return `${payloadB64}.${mac}`;
}

/**
 * Verify a cookie value and confirm it names the preview being served. Returns
 * null for anything not currently valid — callers fall back to `?token=`.
 */
export function verifyPreviewSession(
  value: string | null | undefined,
  target: { sandboxLabel: string; port: number },
): PreviewSession | null {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, mac] = parts as [string, string];
  if (!payloadB64 || !mac) return null;

  const expected = base64urlEncode(createHmac('sha256', signingKey()).update(payloadB64).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: PreviewSession;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as PreviewSession;
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (payload.sandboxLabel !== target.sandboxLabel || payload.port !== target.port) return null;
  if (payload.kind !== 'principal' && payload.kind !== 'public_share') return null;
  return payload;
}

/** Read both cookie names out of a Cookie header, partitioned copy first. */
export function readPreviewCookies(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const values: string[] = [];
  for (const name of [PREVIEW_COOKIE_PARTITIONED, PREVIEW_COOKIE]) {
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}

/**
 * The pair of Set-Cookie headers that make a preview work both embedded and in
 * its own tab. `Secure` is dropped only for plain-http local development, where
 * `SameSite=None` without it would be rejected outright.
 */
export function previewSessionCookies(
  value: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string[] {
  const base = `Path=/; HttpOnly; Max-Age=${opts.maxAgeSeconds}`;
  if (!opts.secure) {
    // http://localhost only: SameSite=None requires Secure, so an embedded
    // preview over plain http falls back to Lax rather than being dropped.
    return [`${PREVIEW_COOKIE}=${value}; ${base}; SameSite=Lax`];
  }
  return [
    `${PREVIEW_COOKIE}=${value}; ${base}; Secure; SameSite=None`,
    `${PREVIEW_COOKIE_PARTITIONED}=${value}; ${base}; Secure; SameSite=None; Partitioned`,
  ];
}

/**
 * The Cookie header as the APP should see it: everything the browser sent,
 * minus the cookies that belong to Kortix.
 *
 * On the path proxy every cookie is stripped, because the preview shares an
 * origin with the API and the jar therefore contains the caller's own API
 * credential — handing that to arbitrary sandbox code would be a credential
 * leak. A preview ORIGIN has no such problem: it is a different host, so the
 * API's cookies are never sent here at all, and the only Kortix cookies in the
 * jar are the two this module sets. Removing exactly those and forwarding the
 * rest is what makes a cookie-session app (Django, Rails, next-auth, PHP) work
 * through the proxy the same way it works when reached directly.
 */
export function appCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      const name = pair.split('=', 1)[0]?.trim();
      return (
        name
        && name !== PREVIEW_COOKIE
        && name !== PREVIEW_COOKIE_PARTITIONED
        // Never forwarded even though it cannot reach a preview origin: a
        // self-host that puts previews on the API host must not leak it either.
        && name !== '__preview_session'
      );
    });
  return kept.length ? kept.join('; ') : null;
}
