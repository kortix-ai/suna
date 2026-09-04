/**
 * Kortix Apps — the viewer, on the App's server.
 *
 * The Apps gate signs an identity into every proxied request
 * (`x-kortix-app-viewer`) and, for an API-scoped App, the viewer's token
 * alongside it (`x-kortix-app-viewer-token`). An App verifies the first with
 * the per-App secret Kortix injects at deploy (`KORTIX_APP_VIEWER_SECRET`) and
 * knows exactly who is looking — with no login of its own and no round trip:
 *
 * ```ts
 * const viewer = await readAppViewer(request);
 * if (!viewer) return new Response('Not found', { status: 404 });
 * const dashboards = await listFor(viewer.userId, viewer.groupIds);
 * ```
 *
 * and, when the App may act as them on the Kortix API:
 *
 * ```ts
 * const kortix = await createAppViewerKortix(request, { backendUrl });
 * await kortix.projects.list();   // as the viewer, with the viewer's role
 * ```
 *
 * A forged header cannot survive: the gate deletes any client-supplied copy
 * before forwarding, and this function refuses anything the App's own secret
 * does not sign. With no secret configured it returns `null` — an App never
 * trusts an unverified identity.
 */
import { createScopedKortix } from './server';
import type { Kortix } from '../core/client/kortix';

export const APP_VIEWER_HEADER = 'x-kortix-app-viewer';
export const APP_VIEWER_TOKEN_HEADER = 'x-kortix-app-viewer-token';
export const APP_VIEWER_SECRET_ENV = 'KORTIX_APP_VIEWER_SECRET';

export interface KortixAppViewer {
  userId: string;
  email: string | null;
  groupIds: string[];
  accountId: string;
  appId: string;
  /** The App's access mode when the gate authorized this request. */
  accessMode: string;
  /** The viewer's App-scoped Kortix bearer, or null for an identity-only App. */
  token: string | null;
  /** When the signed identity expires (the gate re-signs on every request). */
  expiresAt: Date;
}

export interface ReadAppViewerOptions {
  /** Defaults to `process.env.KORTIX_APP_VIEWER_SECRET`. */
  secret?: string;
}

function envSecret(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[APP_VIEWER_SECRET_ENV];
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Length-independent compare — never returns early on the first differing byte. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface SignedPayload {
  v: number;
  appId: string;
  userId: string;
  email: string | null;
  groupIds: string[];
  accountId: string;
  accessMode: string;
  iat: number;
  exp: number;
}

/**
 * The verified Kortix viewer behind this request, or `null` when there is none
 * (a public App, a signed-out visitor, or no secret configured).
 */
export async function readAppViewer(
  request: Request,
  options: ReadAppViewerOptions = {},
): Promise<KortixAppViewer | null> {
  const secret = options.secret ?? envSecret();
  if (!secret) return null;
  const raw = request.headers.get(APP_VIEWER_HEADER);
  if (!raw) return null;
  const [payloadB64, sig, extra] = raw.split('.');
  if (!payloadB64 || !sig || extra) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = new TextEncoder().encode(`kortix-app-viewer:v1\0${payloadB64}`);
  const expected = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
  if (!equal(sig, expected)) return null;

  let payload: SignedPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(payloadB64))) as SignedPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || typeof payload.userId !== 'string' || !payload.userId) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  /*
   * A malformed field is refused, never coerced.
   *
   * Reading a non-array `groupIds` as `[]` would hand the App a viewer with
   * their group memberships silently missing — which reads to the App as "this
   * person is in no groups" and quietly removes whatever group grants gave
   * them. No viewer at all is the honest answer, and the one an App is already
   * written to handle. (Found from the consumer side: essentia-dashboards
   * asserts that a signed payload which is not a statement about a person is
   * refused.)
   */
  if (payload.groupIds !== undefined) {
    if (!Array.isArray(payload.groupIds)) return null;
    if (payload.groupIds.some((id) => typeof id !== 'string')) return null;
  }
  if (payload.email !== undefined && payload.email !== null && typeof payload.email !== 'string') {
    return null;
  }

  return {
    userId: payload.userId,
    email: payload.email ?? null,
    groupIds: payload.groupIds ?? [],
    accountId: payload.accountId,
    appId: payload.appId,
    accessMode: payload.accessMode,
    token: request.headers.get(APP_VIEWER_TOKEN_HEADER),
    expiresAt: new Date(payload.exp * 1000),
  };
}

export class AppViewerUnavailableError extends Error {
  constructor(
    public readonly code: 'no_viewer' | 'identity_only',
    message: string,
  ) {
    super(message);
    this.name = 'AppViewerUnavailableError';
  }
}

/**
 * A request-scoped Kortix client acting AS this App's viewer.
 *
 * Needs the App to be API-scoped (`viewer_token_scope: 'api'` — Kortix web:
 * the App's Access panel). Throws `AppViewerUnavailableError` otherwise, so a
 * misconfigured App fails loudly instead of quietly acting as nobody.
 */
export async function createAppViewerKortix(
  request: Request,
  options: { backendUrl: string } & ReadAppViewerOptions,
): Promise<Kortix> {
  const viewer = await readAppViewer(request, options);
  if (!viewer) {
    throw new AppViewerUnavailableError('no_viewer', 'No verified Kortix viewer on this request');
  }
  if (!viewer.token) {
    throw new AppViewerUnavailableError(
      'identity_only',
      "This App carries viewer identity but no API token — set its access policy to viewer_token_scope: 'api' to act as the viewer.",
    );
  }
  const token = viewer.token;
  return createScopedKortix({
    backendUrl: options.backendUrl,
    getToken: async () => token,
    clientSource: 'web',
  });
}
