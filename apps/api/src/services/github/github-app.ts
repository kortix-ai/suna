import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { resolveAppIdentity } from "../platform/services/github-app-identity";
import { ghFetch } from "./github-http";
// The App identity is resolved WHOLE from one source — env or the
// `github_app_identity` platform setting — by
// services/platform/services/github-app-identity.ts. These accessors never mix the two
// field by field: one stored row shadowing six env values is the 2026-09-16
// production incident.
export function githubAppId() {
  return resolveAppIdentity()?.appId ?? null;
}

function githubAppPrivateKey() {
  return resolveAppIdentity()?.privateKey ?? null;
}

export function isGithubAppConfigured() {
  return resolveAppIdentity() !== null;
}

// The App's own OAuth client (every GitHub App gets one for "user access
// token" / user-to-server flows) — used to prove a caller's GitHub identity
// and org role for account-linking (see http/platform/github-app.ts's
// oauth/authorize + oauth/callback).
export function githubAppClientId() {
  return resolveAppIdentity()?.clientId ?? null;
}

export function githubAppClientSecret() {
  return resolveAppIdentity()?.clientSecret ?? null;
}

/** Whether the App's own OAuth identity-proof flow (oauth/authorize +
 *  oauth/callback) can run. This is independent of `isGithubAppConfigured()`
 *  (App ID + private key, needed for JWT/installation calls) — a deployment
 *  can have one without the other, e.g. an App pasted via POST /app with no
 *  client credentials supplied. */
export function isGithubAppOAuthConfigured() {
  return Boolean(githubAppClientId() && githubAppClientSecret());
}

/**
 * The HMAC key behind the install-state token. The identity's own state
 * secret first; `SUPABASE_JWT_SECRET` and the private key are last-resort
 * signing keys for a deployment that never set one. They are signing keys,
 * not identity fields, so reading them here is not a mixed identity.
 */
export function githubAppStateSecret() {
  const identity = resolveAppIdentity();
  return (
    identity?.stateSecret ||
    process.env.KORTIX_GITHUB_APP_STATE_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    identity?.privateKey ||
    null
  );
}

// ─── Slug derivation ─────────────────────────────────────────────────────────
// The slug is a PROPERTY of the App, so it is read from the App: `GET /app`
// signed with the identity's own JWT. A configured slug is only consulted when
// that read fails, and a mismatch between the two is logged once.

const SLUG_TTL_MS = 60 * 60 * 1000;
const SLUG_FAILURE_TTL_MS = 60 * 1000;
const slugCache = new Map<
  string,
  { slug: string | null; permissions: Record<string, string> | null; at: number; ttl: number }
>();
const slugMismatchLogged = new Set<string>();
const permissionDriftLogged = new Set<string>();

/**
 * Every permission a Kortix flow reads or writes through the App. The
 * self-host manifest (http/platform/github-app.ts) requests exactly this
 * set, and `resolveGitHubAppPermissions()` compares a hand-made App against it.
 *
 * - `administration: write` — `createRepo` under a connected organization.
 * - `contents: write` — commits and pushes.
 *
 * `pull_requests` is NOT here: no API route calls a pulls endpoint and no GitHub
 * token reaches a sandbox (git goes through the Kortix git proxy). The manifest
 * still requests it (`GITHUB_APP_MANIFEST_PERMISSIONS`) so a future pulls flow
 * needs no re-consent, but its absence breaks nothing and must not alarm.
 * - `members: read` — the account-linking identity proof
 *   (`verifyGitHubInstallationAdmin`, `listLinkableGitHubAppInstallations`).
 *   GitHub answers 403 on both membership reads without it.
 */
export const REQUIRED_GITHUB_APP_PERMISSIONS = {
  administration: 'write',
  contents: 'write',
  metadata: 'read',
  members: 'read',
} as const satisfies Record<string, 'read' | 'write'>;

/** What the self-host manifest requests: the required set plus reserved extras. */
export const GITHUB_APP_MANIFEST_PERMISSIONS = {
  ...REQUIRED_GITHUB_APP_PERMISSIONS,
  pull_requests: 'write',
} as const satisfies Record<string, 'read' | 'write'>;

const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

function missingGitHubAppPermissions(granted: Record<string, unknown> | null | undefined): string[] {
  return Object.entries(REQUIRED_GITHUB_APP_PERMISSIONS)
    .filter(([name, level]) => {
      const have = PERMISSION_RANK[String(granted?.[name] ?? '')] ?? 0;
      return have < PERMISSION_RANK[level];
    })
    .map(([name]) => name)
    .sort();
}

export interface ResolvedGitHubAppSlug {
  slug: string | null;
  source: 'derived' | 'configured' | 'none';
}

/** Test-only: drop the per-appId slug cache. */
export function resetGitHubAppSlugCache(): void {
  slugCache.clear();
  slugMismatchLogged.clear();
  permissionDriftLogged.clear();
}

/** One cached `GET /app` per appId backs both the slug and the permissions. */
async function readGitHubApp(identity: { appId: string }) {
  const cached = slugCache.get(identity.appId);
  if (cached && Date.now() - cached.at < cached.ttl) return cached;

  try {
    const app = await ghFetch<{ slug?: string; permissions?: Record<string, string> }>(
      '/app',
      { method: 'GET' },
      { token: createGitHubAppJwt() },
    );
    const entry = {
      slug: typeof app.slug === 'string' && app.slug.trim() ? app.slug.trim() : null,
      permissions: app.permissions && typeof app.permissions === 'object' ? app.permissions : null,
      at: Date.now(),
      ttl: SLUG_TTL_MS,
    };
    slugCache.set(identity.appId, entry);

    const missing = entry.permissions ? missingGitHubAppPermissions(entry.permissions) : [];
    if (missing.length && !permissionDriftLogged.has(identity.appId)) {
      permissionDriftLogged.add(identity.appId);
      console.error(
        `[github-app] App "${entry.slug ?? identity.appId}" is missing required permissions: ` +
          `${missing.join(', ')}. Flows that depend on them fail for every user. ` +
          'Add them in the App settings (Permissions & events).',
      );
    }
    return entry;
  } catch (err) {
    const entry = { slug: null, permissions: null, at: Date.now(), ttl: SLUG_FAILURE_TTL_MS };
    slugCache.set(identity.appId, entry);
    console.warn(
      `[github-app] could not derive the App slug from GET /app for appId ${identity.appId}:`,
      err instanceof Error ? err.message : err,
    );
    return entry;
  }
}

export interface ResolvedGitHubAppPermissions {
  /** `null` when no App is configured or `GET /app` failed. */
  permissions: Record<string, string> | null;
  /** Names from `REQUIRED_GITHUB_APP_PERMISSIONS` the App lacks. Empty when unknown. */
  missing: string[];
}

export async function resolveGitHubAppPermissions(): Promise<ResolvedGitHubAppPermissions> {
  const identity = resolveAppIdentity();
  if (!identity) return { permissions: null, missing: [] };
  const { permissions } = await readGitHubApp(identity);
  return { permissions, missing: permissions ? missingGitHubAppPermissions(permissions) : [] };
}

export async function resolveGitHubAppSlug(): Promise<ResolvedGitHubAppSlug> {
  const identity = resolveAppIdentity();
  if (!identity) return { slug: null, source: 'none' };

  const derived = (await readGitHubApp(identity)).slug;

  if (derived) {
    const configured = identity.configuredSlug;
    if (configured && configured !== derived && !slugMismatchLogged.has(identity.appId)) {
      slugMismatchLogged.add(identity.appId);
      console.warn(
        `[github-app] configured slug "${configured}" does not match the App's own slug "${derived}" ` +
          `(appId ${identity.appId}); using the derived one`,
      );
    }
    return { slug: derived, source: 'derived' };
  }

  const configured = identity.configuredSlug;
  if (configured) return { slug: configured, source: 'configured' };
  return { slug: null, source: 'none' };
}

function signGitHubAppStatePayload(payload: string) {
  const secret = githubAppStateSecret();
  if (!secret) {
    throw new Error('GitHub App install state secret is not configured');
  }
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface GitHubAppInstallState {
  accountId: string;
  nonce?: string;
  purpose?: 'account_link' | 'platform_setup';
  frontendOrigin?: string;
  issuedAt: number;
}

export function normalizeGitHubFrontendOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
      return undefined;
    }
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function buildGitHubAppInstallState(
  accountId: string,
  options: {
    nonce?: string;
    purpose?: 'account_link' | 'platform_setup';
    frontendOrigin?: string;
  } = {},
  nowMs = Date.now(),
) {
  const payload = Buffer.from(JSON.stringify({
    account_id: accountId,
    nonce: options.nonce,
    purpose: options.purpose,
    frontend_origin: normalizeGitHubFrontendOrigin(options.frontendOrigin),
    iat: Math.floor(nowMs / 1000),
  })).toString('base64url');
  return `v1.${payload}.${signGitHubAppStatePayload(payload)}`;
}

export function verifyGitHubAppInstallStatePayload(
  state: string | undefined | null,
  nowMs = Date.now(),
): GitHubAppInstallState | null {
  // Defensive against bare/missing `state` query params — the install-callback
  // route (apps/api/src/http/platform/github-app.ts) calls this with
  // `query.state`, which is `string | undefined` (zod schema marks it
  // `optional()`). Without this guard, `undefined.split('.')` throws a
  // TypeError that surfaces as a 500 on a bare GET /install-callback hit —
  // observed live on staging (ke2e GHA-2). Mirrors verifyManifestStartState's
  // own null-on-non-string-input contract. Every real GitHub redirect always
  // includes a `state` param, so this is a robustness fix, not a security
  // change — a missing state was always meant to be rejected (→ null → 302
  // redirect), just not by crashing.
  if (typeof state !== 'string' || state.length === 0) return null;
  const parts = state.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const payload = parts[1]!;
  const signature = parts[2]!;
  let expected: string;
  try {
    expected = signGitHubAppStatePayload(payload);
  } catch {
    return null;
  }
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      account_id?: unknown;
      nonce?: unknown;
      purpose?: unknown;
      frontend_origin?: unknown;
      iat?: unknown;
    };
    const accountId = typeof decoded.account_id === 'string' ? decoded.account_id : '';
    const nonce = typeof decoded.nonce === 'string' ? decoded.nonce : undefined;
    const purpose =
      decoded.purpose === 'account_link' || decoded.purpose === 'platform_setup'
        ? decoded.purpose
        : undefined;
    const frontendOrigin = normalizeGitHubFrontendOrigin(decoded.frontend_origin);
    const issuedAt = typeof decoded.iat === 'number' ? decoded.iat : 0;
    const now = Math.floor(nowMs / 1000);
    if (!accountId || issuedAt < now - 30 * 60 || issuedAt > now + 60) return null;
    return { accountId, nonce, purpose, frontendOrigin, issuedAt };
  } catch {
    return null;
  }
}

/**
 * The App's install URL. Never emitted for a slug that was not derived from
 * `GET /app` or explicitly configured — a guessed slug is a permanent 404 on
 * github.com, which is what production served until 2026-09-16.
 */
export async function buildGitHubAppInstallUrl(
  accountId?: string | null,
  nonce?: string,
  purpose: 'account_link' | 'platform_setup' = 'account_link',
  frontendOrigin?: string,
): Promise<string | null> {
  const { slug } = await resolveGitHubAppSlug();
  if (!slug) return null;
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  if (accountId) {
    try {
      url.searchParams.set(
        'state',
        buildGitHubAppInstallState(accountId, { nonce, purpose, frontendOrigin }),
      );
    } catch {
      return null;
    }
  }
  return url.toString();
}

function normalizeGitHubPrivateKey(value: string) {
  // Strip surrounding quotes (a secret stored as "...PEM..." double-encodes the
  // quotes into the value) and \n-escapes, so a quoted secret can never produce
  // OpenSSL NO_START_LINE. Then normalize escaped newlines to real ones.
  return value
    .trim()
    .replace(/^\s*(['"])([\s\S]*)\1\s*$/, '$2')
    .trim()
    .replace(/\\n/g, '\n');
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Sign a GitHub App JWT for an EXPLICIT (appId, privateKey) pair — split out
 * of `createGitHubAppJwt` so the "paste an existing App" setup route
 * (http/platform/github-app.ts's POST /app) can validate credentials a user
 * just typed in *before* they're stored as the platform's active config
 * (`createGitHubAppJwt` below only ever signs for whatever is ALREADY
 * configured).
 */
export function signGitHubAppJwt(appId: string, privateKey: string, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  });
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(normalizeGitHubPrivateKey(privateKey)).toString('base64url');
  return `${unsigned}.${signature}`;
}

export function createGitHubAppJwt(nowMs = Date.now()) {
  const appId = githubAppId()?.trim();
  const privateKey = githubAppPrivateKey();
  if (!appId || !privateKey) {
    throw new Error('GitHub App is not configured (set KORTIX_GITHUB_APP_ID and KORTIX_GITHUB_APP_PRIVATE_KEY)');
  }
  return signGitHubAppJwt(appId, privateKey, nowMs);
}

