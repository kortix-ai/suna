/**
 * Composio toolkits that run on the customer's OWN app, starting with Shopify.
 *
 * Composio holds no Shopify app of its own. The operator's Shopify auth config
 * asked for an admin-created custom app token (`shpat_…`), and Shopify stopped
 * issuing those on 2026-01-01. A Shopify app is now made in the Shopify Dev
 * Dashboard, in the organization that owns the store, and reaches the store
 * through the client-credentials grant (a 24 h token, no refresh token).
 * Composio runs that grant as its `S2S_OAUTH2` scheme, but the client id and
 * secret belong to the AUTH CONFIG, so its hosted connect page never asks for
 * them. Each connection therefore gets its own auth config, named after the
 * connection (`connectionAuthConfigName`), and connect opens Kortix's own form
 * (`/connect/app/<token>` on the web app), which collects the credentials and
 * the store. The form posts to `app-form.ts`.
 *
 * The link token is stateless, like a setup link (`setup-links/token.ts`): an
 * AEAD envelope under the project's key, so it cannot be forged or moved to
 * another project. It names one connection and the nonce its Connect wrote to
 * `auth_request_id`, so a newer Connect makes an older link stale.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/surface';
import { allowedReturnUri } from './return-uri';

export interface OwnApp {
  /** Display name for the form. */
  name: string;
}

const OWN_APPS: Readonly<Record<string, OwnApp>> = {
  shopify: { name: 'Shopify' },
};

/** The toolkit's own-app entry, or `null` for a toolkit Composio connects itself. */
export function ownApp(toolkit: string): OwnApp | null {
  return OWN_APPS[toolkit.trim().toLowerCase()] ?? null;
}

/** The store's permanent myshopify.com name (`acme` in `acme.myshopify.com`). */
export { shopifyStoreName as normalizeShopifyStore } from './shopify';

const TOKEN_PREFIX = 'kaf_';
/** Long enough to make a Shopify app in the Dev Dashboard while the form waits. */
const TOKEN_TTL_MS = 60 * 60_000;

export interface AppFormPayload {
  kind: 'app_form';
  pid: string;
  /** The connection the form connects. */
  cid: string;
  app: string;
  /** The nonce the Connect stored as `auth_request_id`. */
  n: string;
  exp: number;
  /** Where the form sends the browser after success (an allowed return page only). */
  ok?: string;
  /** The user who started Connect. A Shopify OAuth grant completes as them. */
  u?: string;
}

export function newAppFormNonce(): string {
  return randomBytes(12).toString('base64url');
}

export function mintAppFormToken(input: {
  projectId: string;
  connectionId: string;
  app: string;
  nonce: string;
  successRedirect?: string;
  userId?: string | null;
  now?: number;
}): string {
  const ok = allowedReturnUri(input.successRedirect);
  const payload: AppFormPayload = {
    kind: 'app_form',
    pid: input.projectId,
    cid: input.connectionId,
    app: input.app.toLowerCase(),
    n: input.nonce,
    exp: (input.now ?? Date.now()) + TOKEN_TTL_MS,
    ...(ok ? { ok } : {}),
    ...(input.userId ? { u: input.userId } : {}),
  };
  const envelope = encryptProjectSecret(input.projectId, JSON.stringify(payload));
  return TOKEN_PREFIX + Buffer.from(`${input.projectId}.${envelope}`, 'utf8').toString('base64url');
}

/** The web page that collects the app's credentials for one connection. */
export function appFormConnectUrl(input: Parameters<typeof mintAppFormToken>[0]): string {
  const base = config.FRONTEND_URL.replace(/\/+$/, '');
  return `${base}/connect/app/${mintAppFormToken(input)}`;
}

export type OpenedAppForm =
  | { ok: true; payload: AppFormPayload }
  | { ok: false; status: 404 | 410; error: string };

export function openAppFormToken(token: string | undefined | null, now = Date.now()): OpenedAppForm {
  const invalid = { ok: false, status: 404, error: 'This connect link is not valid.' } as const;
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 4096) return invalid;
  let payload: AppFormPayload;
  try {
    const decoded = Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8');
    const dot = decoded.indexOf('.');
    if (dot <= 0) return invalid;
    const projectId = decoded.slice(0, dot);
    payload = JSON.parse(decryptProjectSecret(projectId, decoded.slice(dot + 1))) as AppFormPayload;
    if (payload.kind !== 'app_form' || payload.pid !== projectId || !ownApp(payload.app)) return invalid;
  } catch {
    return invalid;
  }
  if (payload.exp <= now) {
    return { ok: false, status: 410, error: 'This connect link expired. Start Connect again in Kortix.' };
  }
  return { ok: true, payload };
}
