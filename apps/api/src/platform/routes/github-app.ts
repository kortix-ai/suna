import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
/**
 * In-app self-host GitHub App setup — the DB-backed replacement for the
 * `.env`-only managed GitHub App config (a web page can't write env vars or
 * restart the container). Ports the CLI's proven manifest flow
 * (apps/cli/src/self-host/connect-github.ts) server-side and stores the
 * resulting creds in kortix.platform_settings (managed-github-app.ts) instead
 * of an env patch.
 *
 * Flow (three hops, two of them unauthenticated browser redirects from
 * GitHub — see the security notes on each route below):
 *
 *   1. POST /manifest-start   (admin-authed) — build the manifest + a signed
 *      state token; the frontend renders an auto-submitting POST form to
 *      GitHub's `apps/new` with it.
 *   2. GET  /manifest-callback (public; GitHub → browser) — exchange the
 *      manifest code for real App creds, store them, then redirect the
 *      browser to the App's own install page — with a signed
 *      account-correlation state (reusing the EXISTING
 *      buildGitHubAppInstallUrl/verifyGitHubAppInstallStatePayload mechanism
 *      in projects/github.ts) so step 3 can find its way back to the
 *      initiating account.
 *   3. GET  /install-callback (public; GitHub → browser) — resolve the
 *      installation's owner, store owner+installationId, redirect to the
 *      frontend.
 *
 * Plus GET /status (admin-authed) for the setup UI to poll.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { resolveBaseUrl } from '../../channels/slack-manifest';
import { config } from '../../config';
import { supabaseAuth } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/require-admin';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import {
  githubBackend,
  managedGithubInstallId,
  managedGithubOwner,
  managedGithubToken,
} from '../../projects/git-backends/github';
import {
  buildGitHubAppInstallUrl,
  getGitHubAppInstallation,
  githubAppSlug,
  isGithubAppConfigured,
  signGitHubAppJwt,
  verifyGitHubAppInstallStatePayload,
} from '../../projects/github';
import type { AppEnv } from '../../types';
import {
  managedGithubAppConfig,
  refreshManagedGithubAppConfig,
  resetManagedGithubAppConfig,
  updateManagedGithubAppConfig,
} from '../services/managed-github-app';

export const githubAppSetupRouter = makeOpenApiApp<AppEnv>();

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface GithubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  /** GitHub's actual manifest field name for the App's permission set — the
   *  task calls it "permissions" informally, but the manifest API (and the
   *  proven CLI implementation this ports) uses `default_permissions`. */
  default_permissions: Record<string, string>;
  default_events: string[];
  /** GitHub REQUIRES `url` inside hook_attributes whenever the object is present
   *  — omit it and the manifest is rejected with the opaque "'url' wasn't
   *  supplied" (it means the WEBHOOK url, not the homepage). We don't use
   *  webhooks, so point it at a valid FQDN and set active:false. */
  hook_attributes: { url: string; active: boolean };
}

export function buildGithubAppManifest(opts: {
  apiBaseUrl: string;
  homepageUrl: string;
  appName?: string;
}): GithubAppManifest {
  // `apiBaseUrl` is where GitHub redirects the BROWSER after create/install, so
  // it must be browser-reachable (http://localhost:<port> on a laptop, the
  // public API origin on a server). `homepageUrl` is the App's cosmetic
  // homepage — GitHub validates it as a public URL and rejects localhost/non-FQDN
  // ("url wasn't supplied"), so it is kept separate and always a valid FQDN.
  const base = opts.apiBaseUrl.replace(/\/+$/, '');
  return {
    name: opts.appName ?? `Kortix Self-Host ${randomBytes(4).toString('hex')}`,
    url: opts.homepageUrl,
    redirect_url: `${base}/v1/platform/github-app/manifest-callback`,
    setup_url: `${base}/v1/platform/github-app/install-callback`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      administration: 'write',
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    },
    default_events: [],
    hook_attributes: { url: opts.homepageUrl, active: false },
  };
}

/** Org-owned apps live under `/organizations/<org>/settings/...`; a personal
 *  account (no org) uses the unscoped `/settings/...` path. No `state` query
 *  is baked in here — the frontend appends `?state=<state>` itself when it
 *  builds the auto-submitting form's `action` (see module docblock). */
export function buildManifestCreateUrl(org?: string): string {
  const trimmed = org?.trim();
  return trimmed
    ? `https://github.com/organizations/${encodeURIComponent(trimmed)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

// ─── manifest-start state (round-tripped through GitHub's `apps/new` →
//    manifest-callback redirect) ──────────────────────────────────────────────

const MANIFEST_STATE_TTL_MS = 10 * 60 * 1000;

export interface ManifestStartState {
  accountId: string;
  org?: string;
  nonce: string;
  exp: number;
}

function manifestStateSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret)
    throw new Error(
      'SUPABASE_JWT_SECRET is not configured — cannot sign GitHub App manifest state',
    );
  return secret;
}

export function signManifestStartState(
  input: { accountId: string; org?: string },
  nowMs = Date.now(),
): string {
  const state: ManifestStartState = {
    accountId: input.accountId,
    org: input.org,
    nonce: randomBytes(8).toString('hex'),
    exp: nowMs + MANIFEST_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(state)).toString('base64url');
  const mac = createHmac('sha256', manifestStateSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyManifestStartState(
  token: string | undefined | null,
  nowMs = Date.now(),
): ManifestStartState | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  let expected: string;
  try {
    expected = createHmac('sha256', manifestStateSecret()).update(body).digest('base64url');
  } catch {
    return null;
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as ManifestStartState;
    if (typeof parsed.accountId !== 'string' || !parsed.accountId) return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < nowMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── GitHub manifest-conversion API ──────────────────────────────────────────

export interface ManifestConversionResult {
  id: number;
  slug: string;
  pem: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
}

/** `POST /app-manifests/{code}/conversions` — the code is single-use and
 *  expires after 1 hour (GitHub's limit). Ported from the CLI's
 *  `exchangeManifestCode` (apps/cli/src/self-host/connect-github.ts). */
export async function exchangeManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestConversionResult> {
  const res = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-api' },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `GitHub manifest conversion failed (${res.status}): ${detail || res.statusText}`,
    );
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    id: Number(body.id),
    slug: String(body.slug ?? ''),
    pem: String(body.pem ?? ''),
    client_id: String(body.client_id ?? ''),
    client_secret: String(body.client_secret ?? ''),
    webhook_secret: String(body.webhook_secret ?? ''),
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function apiBaseUrl(c: any): string {
  // The public API origin the BROWSER reaches (GitHub redirects the browser to
  // the callback routes under it). Prefer the explicitly-configured public URL
  // (API_PUBLIC_URL on self-host, KORTIX_URL) over the request URL, which behind
  // the Caddy/Kong proxy resolves to an internal host the browser can't reach.
  const configured = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
  if (/^https?:\/\//.test(configured)) return configured;
  const override = config.KORTIX_URL?.startsWith('https://') ? config.KORTIX_URL : undefined;
  return resolveBaseUrl(new URL(c.req.url), override);
}

/** The App's cosmetic homepage URL. GitHub validates it as a public URL and
 *  rejects localhost / non-FQDN values (reported confusingly as "url wasn't
 *  supplied"), so use the configured public frontend URL only when it is an
 *  https FQDN, otherwise a stable fallback. */
function homepageUrl(): string {
  const pub = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (/^https:\/\/[^/.]+\.[^/]+/.test(pub)) return pub;
  return 'https://kortix.ai';
}

function frontendUrl(): string {
  return (config.FRONTEND_URL || '').replace(/\/+$/, '');
}

/** `<FRONTEND_URL>/accounts/<accountId>?tab=git&github=<status>` — falls back
 *  to `<FRONTEND_URL>/` (or just `/`) when the account can't be resolved. */
function accountRedirect(accountId: string | null, status: string, reason?: string): string {
  const base = frontendUrl();
  const qs = reason ? `github=${status}&reason=${encodeURIComponent(reason)}` : `github=${status}`;
  if (accountId) return `${base}/accounts/${encodeURIComponent(accountId)}?tab=git&${qs}`;
  // No account correlation (e.g. a state-less/failed callback) — land on the
  // frontend root rather than guessing a path (spec: "fall back to `/`").
  return `${base || ''}/?${qs}`;
}

// ─── POST /manifest-start ─────────────────────────────────────────────────────

githubAppSetupRouter.openapi(
  createRoute({
    method: 'post',
    path: '/manifest-start',
    tags: ['platform'],
    summary: 'Build a GitHub App manifest + signed state for the self-host setup flow',
    ...auth,
    middleware: [supabaseAuth, requireAdmin] as const,
    request: {
      body: {
        content: { 'application/json': { schema: z.object({ org: z.string().optional() }) } },
        required: false,
      },
    },
    responses: {
      200: json(
        z.object({
          github_create_url: z.string(),
          manifest: z.record(z.string(), z.any()),
          state: z.string(),
        }),
        'Manifest + create URL + signed state — the frontend POSTs the manifest to `${github_create_url}?state=${state}`',
      ),
      ...errors(401, 403, 500),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.get('userId') as string;
      const body = await c.req.json().catch(() => ({}));
      const org = typeof body?.org === 'string' && body.org.trim() ? body.org.trim() : undefined;

      const manifest = buildGithubAppManifest({
        apiBaseUrl: apiBaseUrl(c),
        homepageUrl: homepageUrl(),
      });
      const state = signManifestStartState({ accountId, org });
      const githubCreateUrl = buildManifestCreateUrl(org);

      return c.json({ github_create_url: githubCreateUrl, manifest, state });
    } catch (err) {
      return c.json(
        { error: true, message: err instanceof Error ? err.message : String(err), status: 500 },
        500,
      );
    }
  },
);

// ─── GET /manifest-callback ───────────────────────────────────────────────────
// PUBLIC by necessity — GitHub redirects the browser here with `?code=&state=`
// after the operator submits the manifest form. No Kortix auth header is
// possible on a cross-site browser redirect; the signed `state` (HMAC,
// SUPABASE_JWT_SECRET, ~10min TTL, single-use-in-spirit nonce) is the only
// thing standing between this route and an attacker who guesses the URL — a
// bad/expired/tampered state is rejected outright before any GitHub API call.
// Secrets are stored, never logged.

githubAppSetupRouter.openapi(
  createRoute({
    method: 'get',
    path: '/manifest-callback',
    tags: ['platform'],
    summary:
      'GitHub manifest-flow redirect target — exchanges the code, stores App creds, redirects to install',
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
    },
    responses: {
      302: { description: 'Redirect to the App install page (success) or the frontend (failure)' },
    },
  }),
  async (c: any) => {
    const query = c.req.query();
    const parsedState = verifyManifestStartState(query.state);
    const accountId = parsedState?.accountId ?? null;

    if (query.error) {
      return c.redirect(accountRedirect(accountId, 'error', String(query.error)), 302);
    }
    if (!parsedState) {
      return c.redirect(accountRedirect(null, 'error', 'invalid_state'), 302);
    }
    if (!query.code) {
      return c.redirect(accountRedirect(accountId, 'error', 'missing_code'), 302);
    }

    try {
      const conversion = await exchangeManifestCode(query.code);
      await updateManagedGithubAppConfig({
        appId: String(conversion.id),
        slug: conversion.slug,
        privateKey: conversion.pem,
        clientId: conversion.client_id,
        clientSecret: conversion.client_secret,
        webhookSecret: conversion.webhook_secret,
        stateSecret: managedGithubAppConfig().stateSecret || randomBytes(32).toString('hex'),
        // A GitHub App and a PAT are mutually exclusive managed-git methods —
        // clear any PAT so the active method stays unambiguous (see
        // git-backends/github.ts's DB-first resolution + POST /pat below).
        pat: undefined,
        patOwner: undefined,
      });

      const installUrl = buildGitHubAppInstallUrl(parsedState.accountId, parsedState.nonce);
      if (!installUrl) {
        return c.redirect(accountRedirect(accountId, 'error', 'install_url_unavailable'), 302);
      }
      return c.redirect(installUrl, 302);
    } catch (err) {
      console.error(
        '[github-app] manifest-callback exchange failed',
        err instanceof Error ? err.message : err,
      );
      return c.redirect(accountRedirect(accountId, 'error', 'exchange_failed'), 302);
    }
  },
);

// ─── GET /install-callback ────────────────────────────────────────────────────
// PUBLIC by necessity (GitHub → browser redirect after the operator picks
// repos on the App's install page). Correlated back to the initiating account
// via the SAME signed install-state mechanism the rest of the codebase already
// uses for App installs (buildGitHubAppInstallUrl / verifyGitHubAppInstallStatePayload
// in projects/github.ts) — manifest-callback attaches it when it builds the
// install URL, and GitHub round-trips a `state` query param appended to
// `apps/<slug>/installations/new` back onto the setup_url callback. Storing
// creds here only ever overwrites the single self-host app config (no
// per-user data), so even a state-less hit just (re)confirms the one App this
// instance already created.

githubAppSetupRouter.openapi(
  createRoute({
    method: 'get',
    path: '/install-callback',
    tags: ['platform'],
    summary:
      'GitHub App install redirect target — resolves the installation owner, stores it, redirects to the frontend',
    request: {
      query: z.object({
        installation_id: z.string().optional(),
        setup_action: z.string().optional(),
        state: z.string().optional(),
      }),
    },
    responses: {
      302: { description: 'Redirect to the frontend accounts page (success or failure)' },
    },
  }),
  async (c: any) => {
    const query = c.req.query();
    const state = verifyGitHubAppInstallStatePayload(query.state);
    const accountId = state?.accountId ?? null;
    const installationId = query.installation_id;

    if (!installationId) {
      return c.redirect(accountRedirect(accountId, 'error', 'missing_installation_id'), 302);
    }

    try {
      // Force a fresh read: manifest-callback (which just stored appId/
      // privateKey) may have run on a different replica than this request.
      await refreshManagedGithubAppConfig();
      if (!isGithubAppConfigured()) {
        return c.redirect(accountRedirect(accountId, 'error', 'app_not_configured'), 302);
      }
      // `getGitHubAppInstallation` calls GET /app/installations/{id} signed
      // with THIS app's own JWT — GitHub 404s that call outright if the
      // installation id doesn't belong to this app, so a successful response
      // here already proves the installation-belongs-to-app invariant; no
      // separate check needed before we persist it.
      const installation = await getGitHubAppInstallation(installationId);
      const owner = installation.account?.login;
      if (!owner) {
        return c.redirect(accountRedirect(accountId, 'error', 'owner_unresolved'), 302);
      }
      // GitHub tells us for free whether the install target is an
      // Organization or a personal User account — store it so repo-create
      // routing (git-backends/github.ts) never has to guess (a personal
      // owner needs /user/repos, not /orgs/{owner}/repos, or every managed
      // git operation 404s).
      const ownerType = resolveInstallationOwnerType(installation.account?.type);

      await updateManagedGithubAppConfig({ owner, ownerType, installationId });
      // A fresh install just replaced whatever installationId (if any) was
      // previously cached as healthy/unhealthy — don't let a stale cache
      // entry from before this reconnect answer the next GET /status.
      resetManagedGithubAppInstallationHealthCache();
      return c.redirect(accountRedirect(accountId, 'connected'), 302);
    } catch (err) {
      console.error(
        '[github-app] install-callback resolve failed',
        err instanceof Error ? err.message : err,
      );
      return c.redirect(accountRedirect(accountId, 'error', 'resolve_failed'), 302);
    }
  },
);

// ─── GET /status ──────────────────────────────────────────────────────────────
//
// `source` reports WHICH of the three managed-git methods (see module
// docblock + `docs/specs` self-host git settings work) is active, in this
// precedence order — matching how the accessors themselves resolve
// (App-DB > App-env > PAT, PAT itself DB-first then env):
//   'db'   — a GitHub App created via the in-app manifest flow OR pasted in
//            via POST /app (both write the same DB config).
//   'env'  — a GitHub App configured via KORTIX_GITHUB_APP_*/GITHUB_APP_* env
//            vars (the hosted Kortix deployment's setup).
//   'pat'  — a personal/fine-grained access token, via POST /pat (DB) or
//            MANAGED_GIT_GITHUB_TOKEN (env).
//   'none' — managed-git isn't usable via any method yet.

export type ManagedGitSource = 'db' | 'env' | 'pat' | 'none';

/**
 * GitHub's installation `account.type` is `'User' | 'Organization'` (per
 * their docs) but comes back as a loosely-typed string on the wire — pin it
 * to the two values `resolveDefaultOwner`/`managedAdminAuth` actually branch
 * on, defaulting to `'Organization'` (the historical assumption, still right
 * for every managed-git org install) for anything unexpected. Shared by both
 * places that resolve an installation's owner type (install-callback below,
 * and `verifyPastedGithubAppInstallation`'s "paste an existing App" path) so
 * they can never drift from each other on what counts as a personal account.
 */
export function resolveInstallationOwnerType(
  accountType: string | undefined,
): 'User' | 'Organization' {
  return accountType === 'User' ? 'User' : 'Organization';
}

/**
 * Pure precedence rule behind `GET /status`'s `source` field — split out so
 * it's testable without a Hono context/DB (see unit-github-app-pat.test.ts).
 * Mirrors the accessors' own resolution order: App-DB > App-env > PAT.
 */
export function resolveManagedGitSource(input: {
  dbAppConfigured: boolean;
  envAppConfigured: boolean;
  patConfigured: boolean;
}): ManagedGitSource {
  if (input.dbAppConfigured) return 'db';
  if (input.envAppConfigured) return 'env';
  if (input.patConfigured) return 'pat';
  return 'none';
}

// ─── Torn-config detection ────────────────────────────────────────────────
// A stored config can go "torn": the App half (appId/privateKey) and the
// installation half (owner/installationId) were written by two different
// manifest-flow runs (e.g. an operator re-ran the flow after an earlier
// attempt, creating a second App, but a stale installationId from the first
// App is still sitting in the row) — `isConfigured()` can't see this, it
// only checks that all four fields are non-empty, not that the
// installationId actually belongs to the CURRENT appId+privateKey.
//
// Detected cheaply: `GET /app/installations/{id}` signed with the CURRENT
// app's JWT — GitHub 404s that call outright if the installation doesn't
// belong to this app (same call install-callback already relies on to prove
// the belongs-to-app invariant at write time; here we're just re-checking it
// hasn't drifted since). Cached briefly since this only runs off a
// status-polling endpoint, not a hot path, and only for the 'db' source (env-
// configured Apps and PATs have no "two configs in one row" failure mode).
const INSTALLATION_HEALTH_TTL_MS = 30_000;
let installationHealthCache: { key: string; ok: boolean; at: number } | null = null;

export async function checkManagedGithubAppInstallationHealthy(
  installationId: string,
  opts: { skipCache?: boolean } = {},
): Promise<boolean> {
  if (
    !opts.skipCache &&
    installationHealthCache &&
    installationHealthCache.key === installationId &&
    Date.now() - installationHealthCache.at < INSTALLATION_HEALTH_TTL_MS
  ) {
    return installationHealthCache.ok;
  }
  let ok: boolean;
  try {
    await getGitHubAppInstallation(installationId);
    ok = true;
  } catch {
    ok = false;
  }
  installationHealthCache = { key: installationId, ok, at: Date.now() };
  return ok;
}

/** Test-only escape hatch — the cache is module-level so tests need a way to
 *  force a fresh check between cases. */
export function resetManagedGithubAppInstallationHealthCache(): void {
  installationHealthCache = null;
}

githubAppSetupRouter.openapi(
  createRoute({
    method: 'get',
    path: '/status',
    tags: ['platform'],
    summary: 'Managed GitHub App configuration status',
    ...auth,
    middleware: [supabaseAuth, requireAdmin] as const,
    responses: {
      200: json(
        z.object({
          configured: z.boolean(),
          owner: z.string().nullable(),
          slug: z.string().nullable(),
          installation_id: z.string().nullable(),
          source: z.enum(['db', 'env', 'pat', 'none']),
          reason: z.string().optional(),
        }),
        'Managed GitHub App status',
      ),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    // Reuse the git-backend's own resolution (githubBackend.isConfigured())
    // rather than re-deriving "is managed-git usable" here — it already
    // covers PAT + App-installation, so this route can never drift from what
    // project creation actually does.
    let configured = await githubBackend.isConfigured();
    const owner = managedGithubOwner();
    const slug = githubAppSlug();
    const installationId = managedGithubInstallId();

    const dbConfig = managedGithubAppConfig();
    const source = resolveManagedGitSource({
      dbAppConfigured: Boolean(dbConfig.appId),
      envAppConfigured: isGithubAppConfigured(),
      patConfigured: Boolean(managedGithubToken()),
    });

    let reason: string | undefined;
    if (configured && source === 'db' && installationId) {
      const healthy = await checkManagedGithubAppInstallationHealthy(installationId);
      if (!healthy) {
        configured = false;
        reason = 'installation_not_found_for_app';
      }
    }

    return c.json({
      configured,
      owner,
      slug,
      installation_id: installationId,
      source,
      ...(reason ? { reason } : {}),
    });
  },
);

// ─── POST /app ────────────────────────────────────────────────────────────────
// "Paste an existing GitHub App" — an alternative to the manifest flow for an
// operator who already has an App (created by hand, or shared across
// instances). Validated by signing a JWT with the pasted creds and asking
// GitHub to resolve the installation BEFORE anything is stored, so a typo'd
// key or installation id fails loudly here instead of silently at the first
// project creation.

export async function verifyPastedGithubAppInstallation(
  appId: string,
  privateKey: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ owner: string; ownerType: 'User' | 'Organization' }> {
  let jwt: string;
  try {
    jwt = signGitHubAppJwt(appId, privateKey);
  } catch {
    throw new Error(
      'Could not sign a JWT with that private key — check the PEM was pasted correctly',
    );
  }
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'kortix-api',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      res.status === 401 || res.status === 404
        ? 'GitHub rejected those App credentials or installation id — double-check the App ID, private key, and installation id'
        : `GitHub rejected the App credentials (${res.status}): ${detail || res.statusText}`,
    );
  }
  const body = (await res.json()) as { account?: { login?: string; type?: string } };
  const owner = body.account?.login;
  if (!owner) throw new Error('Could not resolve the installation owner from GitHub');
  return { owner, ownerType: resolveInstallationOwnerType(body.account?.type) };
}

githubAppSetupRouter.openapi(
  createRoute({
    method: 'post',
    path: '/app',
    tags: ['platform'],
    summary: "Configure managed-git by pasting an existing GitHub App's credentials + installation",
    ...auth,
    middleware: [supabaseAuth, requireAdmin] as const,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              app_id: z.string().min(1),
              private_key: z.string().min(1),
              installation_id: z.string().min(1),
              slug: z.string().optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: json(z.object({ ok: z.literal(true), owner: z.string() }), 'App credentials stored'),
      ...errors(400, 401, 403, 500),
    },
  }),
  async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const appId = typeof body?.app_id === 'string' ? body.app_id.trim() : '';
    const privateKey = typeof body?.private_key === 'string' ? body.private_key.trim() : '';
    const installationId =
      typeof body?.installation_id === 'string' ? body.installation_id.trim() : '';
    const slug = typeof body?.slug === 'string' && body.slug.trim() ? body.slug.trim() : undefined;

    if (!appId || !privateKey || !installationId) {
      return c.json(
        {
          error: true,
          message: 'app_id, private_key and installation_id are required',
          status: 400,
        },
        400,
      );
    }

    let owner: string;
    let ownerType: 'User' | 'Organization';
    try {
      const verified = await verifyPastedGithubAppInstallation(appId, privateKey, installationId);
      owner = verified.owner;
      ownerType = verified.ownerType;
    } catch (err) {
      return c.json(
        { error: true, message: err instanceof Error ? err.message : String(err), status: 400 },
        400,
      );
    }

    await updateManagedGithubAppConfig({
      appId,
      privateKey,
      installationId,
      owner,
      ownerType,
      slug,
      stateSecret: managedGithubAppConfig().stateSecret || randomBytes(32).toString('hex'),
      // Mutually exclusive with a PAT — see POST /pat's matching comment.
      pat: undefined,
      patOwner: undefined,
    });
    resetManagedGithubAppInstallationHealthCache();

    return c.json({ ok: true as const, owner });
  },
);

// ─── POST /pat ────────────────────────────────────────────────────────────────
// "Use a token" — the quickest managed-git setup, but deliberately framed
// (here and in the web UI) as a dedicated fine-grained token scoped to the
// repos it needs, NOT an everyday personal token. Validated against GitHub
// before being stored so a bad token fails loudly here instead of at the
// first project creation.

githubAppSetupRouter.openapi(
  createRoute({
    method: 'post',
    path: '/pat',
    tags: ['platform'],
    summary:
      'Configure managed-git via a personal/fine-grained access token instead of a GitHub App',
    ...auth,
    middleware: [supabaseAuth, requireAdmin] as const,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ token: z.string().min(1), owner: z.string().min(1) }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: json(z.object({ ok: z.literal(true) }), 'Token stored'),
      ...errors(400, 401, 403, 500),
    },
  }),
  async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const owner = typeof body?.owner === 'string' ? body.owner.trim() : '';
    if (!token || !owner) {
      return c.json({ error: true, message: 'token and owner are required', status: 400 }, 400);
    }

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'kortix-api',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return c.json(
          {
            error: true,
            message:
              res.status === 401
                ? 'GitHub rejected that token — check it was copied correctly and has not expired'
                : `GitHub rejected the token (${res.status})`,
            status: 400,
          },
          400,
        );
      }
    } catch (err) {
      return c.json(
        {
          error: true,
          message: `Could not reach GitHub to validate the token: ${err instanceof Error ? err.message : String(err)}`,
          status: 400,
        },
        400,
      );
    }

    await updateManagedGithubAppConfig({
      pat: token,
      patOwner: owner,
      // A PAT and a GitHub App are mutually exclusive managed-git methods —
      // clear the App half so isConfigured()/source resolution never has to
      // guess which one is "active" (see git-backends/github.ts).
      appId: undefined,
      slug: undefined,
      privateKey: undefined,
      clientId: undefined,
      clientSecret: undefined,
      webhookSecret: undefined,
      owner: undefined,
      ownerType: undefined,
      installationId: undefined,
    });

    return c.json({ ok: true as const });
  },
);

// ─── DELETE / ─────────────────────────────────────────────────────────────────
// Disconnect managed-git entirely (App AND/OR PAT) so an operator can
// reconfigure from a clean slate instead of the setup card guessing which of
// several half-cleared fields is still "active".

githubAppSetupRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/',
    tags: ['platform'],
    summary: 'Disconnect managed-git — clears the GitHub App and/or PAT configuration',
    ...auth,
    middleware: [supabaseAuth, requireAdmin] as const,
    responses: {
      200: json(z.object({ ok: z.literal(true) }), 'Cleared'),
      ...errors(401, 403, 500),
    },
  }),
  async (c: any) => {
    try {
      await resetManagedGithubAppConfig();
      resetManagedGithubAppInstallationHealthCache();
      return c.json({ ok: true as const });
    } catch (err) {
      return c.json(
        { error: true, message: err instanceof Error ? err.message : String(err), status: 500 },
        500,
      );
    }
  },
);
