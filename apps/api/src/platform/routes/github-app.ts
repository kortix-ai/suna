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
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors, auth } from '../../openapi';
import { supabaseAuth } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/require-admin';
import { config } from '../../config';
import { resolveBaseUrl } from '../../channels/slack-manifest';
import {
  buildGitHubAppInstallUrl,
  getGitHubAppInstallation,
  githubAppSlug,
  isGithubAppConfigured,
  verifyGitHubAppInstallStatePayload,
} from '../../projects/github';
import { githubBackend, managedGithubInstallId, managedGithubOwner } from '../../projects/git-backends/github';
import {
  managedGithubAppConfig,
  refreshManagedGithubAppConfig,
  updateManagedGithubAppConfig,
} from '../services/managed-github-app';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
  hook_attributes: { active: boolean };
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
    hook_attributes: { active: false },
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
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is not configured — cannot sign GitHub App manifest state');
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
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ManifestStartState;
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
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-api' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub manifest conversion failed (${res.status}): ${detail || res.statusText}`);
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
      return c.json({ error: true, message: err instanceof Error ? err.message : String(err), status: 500 }, 500);
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
    summary: 'GitHub manifest-flow redirect target — exchanges the code, stores App creds, redirects to install',
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
      });

      const installUrl = buildGitHubAppInstallUrl(parsedState.accountId, parsedState.nonce);
      if (!installUrl) {
        return c.redirect(accountRedirect(accountId, 'error', 'install_url_unavailable'), 302);
      }
      return c.redirect(installUrl, 302);
    } catch (err) {
      console.error('[github-app] manifest-callback exchange failed', err instanceof Error ? err.message : err);
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
    summary: 'GitHub App install redirect target — resolves the installation owner, stores it, redirects to the frontend',
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
      const installation = await getGitHubAppInstallation(installationId);
      const owner = installation.account?.login;
      if (!owner) {
        return c.redirect(accountRedirect(accountId, 'error', 'owner_unresolved'), 302);
      }

      await updateManagedGithubAppConfig({ owner, installationId });
      return c.redirect(accountRedirect(accountId, 'connected'), 302);
    } catch (err) {
      console.error('[github-app] install-callback resolve failed', err instanceof Error ? err.message : err);
      return c.redirect(accountRedirect(accountId, 'error', 'resolve_failed'), 302);
    }
  },
);

// ─── GET /status ──────────────────────────────────────────────────────────────

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
          source: z.enum(['db', 'env', 'none']),
        }),
        'Managed GitHub App status',
      ),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const configured = await githubBackend.isConfigured();
    const owner = managedGithubOwner();
    const slug = githubAppSlug();
    const installationId = managedGithubInstallId();

    const dbConfig = managedGithubAppConfig();
    const source: 'db' | 'env' | 'none' = dbConfig.appId
      ? 'db'
      : isGithubAppConfigured() || owner
        ? 'env'
        : 'none';

    return c.json({
      configured,
      owner,
      slug,
      installation_id: installationId,
      source,
    });
  },
);
