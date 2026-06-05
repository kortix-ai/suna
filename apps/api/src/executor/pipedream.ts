/**
 * Pipedream Connect — the 1-click connector path (kept as the primary onboarding
 * for SaaS apps). Adapted from the pre-refactor provider (commit 9078f28e).
 *
 * Model fit: a connector with provider="pipedream" declares `app` + `account` in
 * kortix.toml. The OAuth lives on Pipedream's side; we store only the connected
 * **account id** as a `scope='connector'` project secret (the binding) — so it's
 * shareable like any connector credential and never injected into the sandbox.
 * The catalog (app actions) is fetched from Pipedream and normalized. Execution
 * goes through the Connect `actions/run` API. See docs/specs/executor.md §5.
 */
import { createHmac } from 'node:crypto';
import { config } from '../config';
import { upsertCredential } from './credentials';
import type { PipedreamActionLike } from './types';
import type { ExecResult } from './execute';

const PD_BASE = 'https://api.pipedream.com';

/**
 * Pipedream's catalogue includes internal WORKFLOW UTILITIES (schedule, http,
 * pipedream_utils, formatting, helper_functions, data stores, …) alongside real
 * third-party apps. They aren't connectable — they carry no auth method, so
 * there's nothing to authorize — and only clutter the "connect an app" grid.
 * We hide anything with no auth_type, plus an explicit slug denylist for any
 * that ever ship with a stray auth flag.
 */
const UTILITY_APP_SLUGS = new Set([
  'pipedream_utils', 'schedule', 'http', 'formatting', 'helper_functions',
  'data_stores', 'sse', 'delay', 'filter', 'end', 'throw_error',
  'only_continue', 'code', 'rss', 'pipedream', 'go', 'node', 'python', 'bash',
]);

function isConnectableApp(a: { slug: string; authType: string | null }): boolean {
  if (UTILITY_APP_SLUGS.has(a.slug)) return false;
  return !!a.authType && a.authType !== 'none';
}

export function pipedreamConfigured(): boolean {
  return !!(config.PIPEDREAM_CLIENT_ID && config.PIPEDREAM_CLIENT_SECRET && config.PIPEDREAM_PROJECT_ID);
}

/**
 * Stable external_user_id per connector. For per_user connectors it includes the
 * user so each member's connection is isolated; for shared it's connector-wide.
 * The webhook parses this back as `projectId:slug[:userId]`.
 */
export function externalUserId(projectId: string, slug: string, userId?: string | null): string {
  return userId ? `${projectId}:${slug}:${userId}` : `${projectId}:${slug}`;
}

class PipedreamProvider {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  constructor(
    private clientId: string,
    private clientSecret: string,
    private projectId: string,
    private environment: string,
  ) {}

  private async getApiToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const res = await fetch(`${PD_BASE}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }),
    });
    if (!res.ok) throw new Error(`Pipedream auth failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getApiToken();
    const res = await fetch(`${PD_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-pd-environment': this.environment },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`Pipedream ${method} ${path} (${res.status}): ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async createConnectToken(extUserId: string, app: string | undefined, redirects?: { success?: string; error?: string }): Promise<{ token: string; connectUrl?: string; expiresAt: string }> {
    const base = config.FRONTEND_URL || 'http://localhost:3000';
    let origin = base;
    try { origin = new URL(base).origin; } catch { /* keep */ }
    const body: Record<string, unknown> = {
      external_user_id: extUserId,
      allowed_origins: [origin],
      success_redirect_uri: redirects?.success || `${origin}/connectors?connected=true`,
      error_redirect_uri: redirects?.error || `${origin}/connectors?error=true`,
    };
    if (app) body.app_slug = app;
    if (config.KORTIX_URL && config.PIPEDREAM_WEBHOOK_SECRET) {
      const sig = createHmac('sha256', config.PIPEDREAM_WEBHOOK_SECRET).update(extUserId).digest('hex');
      body.webhook_uri = `${config.KORTIX_URL.replace(/\/+$/, '')}/v1/executor/webhook/pipedream?sig=${sig}`;
    }
    const data = await this.api<{ token: string; expires_at: string; connect_link_url?: string }>(
      'POST', `/v1/connect/${this.projectId}/tokens`, body,
    );
    // The hosted connect link must carry ?app=<slug> — without it Pipedream's
    // overlay errors "Please include the app in the Connect URL".
    let connectUrl = data.connect_link_url;
    if (connectUrl && app && !/[?&]app=/.test(connectUrl)) {
      connectUrl += `${connectUrl.includes('?') ? '&' : '?'}app=${encodeURIComponent(app)}`;
    }
    return { token: data.token, connectUrl, expiresAt: data.expires_at };
  }

  async listAccounts(extUserId: string): Promise<Array<{ id: string; app: string; appName: string }>> {
    const data = await this.api<{ data: Array<{ id: string; app: { name_slug: string; name: string } }> }>(
      'GET', `/v1/connect/${this.projectId}/accounts?external_user_id=${encodeURIComponent(extUserId)}&include_credentials=0`,
    );
    return (data.data || []).map((a) => ({ id: a.id, app: a.app.name_slug, appName: a.app.name }));
  }

  async listApps(query?: string, limit = 48, cursor?: string): Promise<{ apps: PipedreamApp[]; nextCursor?: string; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('limit', String(limit));
    if (cursor) params.set('after', cursor);
    if (!query) { params.set('sort_key', 'featured_weight'); params.set('sort_direction', 'desc'); }
    const data = await this.api<{
      page_info: { total_count: number; count: number; end_cursor?: string };
      data: Array<{ name_slug: string; name: string; description?: string; img_src?: string; auth_type?: string; categories: string[] }>;
    }>('GET', `/v1/connect/${this.projectId}/apps?${params.toString()}`);
    const apps = (data.data || [])
      .map((a) => ({
        slug: a.name_slug, name: a.name, description: a.description ?? null, imgSrc: a.img_src ?? null,
        authType: a.auth_type ?? null, categories: a.categories || [],
      }))
      .filter(isConnectableApp);
    // hasMore is driven by Pipedream's cursor, NOT apps.length — filtering out
    // utility apps would otherwise shrink a page below `limit` and stop paging early.
    return { apps, nextCursor: data.page_info?.end_cursor, hasMore: !!data.page_info?.end_cursor };
  }

  async listActions(app: string, limit = 100): Promise<PipedreamActionLike[]> {
    const params = new URLSearchParams({ app, limit: String(limit) });
    const data = await this.api<{ data: Array<{ key: string; name: string; description?: string; configurable_props?: Array<{ name: string; type: string; optional?: boolean; description?: string }> }> }>(
      'GET', `/v1/connect/${this.projectId}/actions?${params.toString()}`,
    );
    return (data.data || []).map((a) => ({
      key: a.key,
      name: a.name,
      description: a.description,
      // Drop the account-selector prop. Pipedream names it after the app slug
      // (e.g. `gmail`, `google_drive`) with `type: "app"` — NOT literally "app" —
      // so it must be filtered by type. If it leaks into the schema the agent
      // fills it and clobbers the credential binding in `runAction` (empty result).
      params: (a.configurable_props || []).filter((p) => p.type !== 'app').map((p) => ({
        name: p.name, type: p.type, required: !p.optional, description: p.description,
      })),
    }));
  }

  async runAction(extUserId: string, app: string, actionKey: string, props: Record<string, unknown>, providerAccountId: string): Promise<unknown> {
    const data = await this.api<Record<string, unknown>>('POST', `/v1/connect/${this.projectId}/actions/run`, {
      id: actionKey,
      external_user_id: extUserId,
      // Spread the agent's args FIRST so the account-selector binding (keyed by
      // the app slug) always wins — a stray `props[app]` can never overwrite it.
      configured_props: { ...props, [app]: { authProvisionId: providerAccountId } },
    });
    // Pipedream returns HTTP 200 even when the action THREW: the failure is in a
    // top-level `error` and/or an `os` log entry with k:"error". If we don't catch
    // it, `data.exports` ({}) gets returned and the gateway reports a fake
    // `ok:true, data:{}` — masking real errors (expired/broken connection, bad
    // args) as "empty data". Surface it instead.
    const osErr = Array.isArray(data.os)
      ? (data.os as Array<{ k?: string; err?: { message?: string; name?: string } }>).find((o) => o?.k === 'error')?.err
      : undefined;
    const err = (data.error ?? osErr) as { message?: string; name?: string } | undefined;
    if (err && typeof err === 'object') {
      throw new Error(`pipedream action error: ${err.message ?? err.name ?? 'unknown error'}`);
    }
    return data.ret ?? data.exports ?? data.os ?? data;
  }

  /**
   * Connect API Proxy — forward an arbitrary request to the connected app's
   * own API. Pipedream looks up the account's stored credential and injects
   * it, so we never touch the app secret. The target URL is URL-safe base64
   * in the path; method + body pass straight through. Returns the upstream
   * status + parsed body verbatim (errors included — the caller decides).
   * Docs: https://pipedream.com/docs/connect/api-proxy
   */
  async proxyRequest(
    extUserId: string,
    accountId: string,
    req: { method: string; url: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; ok: boolean; data: unknown }> {
    const token = await this.getApiToken();
    const url64 = Buffer.from(req.url, 'utf8').toString('base64url');
    const qs = new URLSearchParams({ external_user_id: extUserId, account_id: accountId });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'x-pd-environment': this.environment,
    };
    // Pass caller headers through, but never let them clobber proxy auth/env.
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!/^(authorization|x-pd-environment)$/i.test(k)) headers[k] = String(v);
    }
    let body: string | undefined;
    if (req.body !== undefined && req.body !== null) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }
    const res = await fetch(`${PD_BASE}/v1/connect/${this.projectId}/proxy/${url64}?${qs.toString()}`, {
      method: req.method.toUpperCase(),
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
    return { status: res.status, ok: res.ok, data };
  }
}

let provider: PipedreamProvider | null = null;
function getProvider(): PipedreamProvider {
  if (!pipedreamConfigured()) throw new Error('Pipedream is not configured (set PIPEDREAM_CLIENT_ID/SECRET/PROJECT_ID)');
  if (!provider) {
    provider = new PipedreamProvider(
      config.PIPEDREAM_CLIENT_ID, config.PIPEDREAM_CLIENT_SECRET, config.PIPEDREAM_PROJECT_ID,
      config.PIPEDREAM_ENVIRONMENT || 'production',
    );
  }
  return provider;
}

/* ─── connector-model API (used by the router + gateway + sync) ───────────── */

/** Mint a connect token + link for a connector, scoped per-user when needed. */
export async function pipedreamConnectUrl(
  projectId: string,
  slug: string,
  app: string,
  userId: string | null,
): Promise<{ connectUrl?: string; token: string; expiresAt: string }> {
  return getProvider().createConnectToken(externalUserId(projectId, slug, userId), app);
}

/**
 * After the user finishes 1-click connect, persist the account-id binding as a
 * credential on the connector — shared (userId null) or that member's own.
 */
export async function finalizePipedreamConnection(opts: {
  projectId: string;
  slug: string;
  app: string;
  connectorId: string;
  userId: string | null;
}): Promise<{ connected: boolean; accountId?: string }> {
  const accounts = await getProvider().listAccounts(externalUserId(opts.projectId, opts.slug, opts.userId));
  const match = accounts.find((a) => a.app === opts.app) ?? accounts[0];
  if (!match) return { connected: false };
  await upsertCredential({ projectId: opts.projectId, connectorId: opts.connectorId, userId: opts.userId, value: match.id, kind: 'connection' });
  return { connected: true, accountId: match.id };
}

/** Verify the webhook signature (HMAC of external_user_id with the webhook secret). */
export function verifyWebhookSig(extUserId: string, sig: string | null): boolean {
  if (!config.PIPEDREAM_WEBHOOK_SECRET || !sig) return false;
  const expected = createHmac('sha256', config.PIPEDREAM_WEBHOOK_SECRET).update(extUserId).digest('hex');
  return expected === sig;
}

/** Fetch the app's action catalog (raw, for normalizePipedream). */
export async function pipedreamCatalog(app: string): Promise<PipedreamActionLike[]> {
  return getProvider().listActions(app);
}

/** List the connected accounts for an external user id (used by finalize + live e2e). */
export async function pipedreamListAccounts(extUserId: string): Promise<Array<{ id: string; app: string; appName: string }>> {
  return getProvider().listAccounts(extUserId);
}

export interface PipedreamApp {
  slug: string;
  name: string;
  description: string | null;
  imgSrc: string | null;
  authType: string | null;
  categories: string[];
}

/** Browse the Pipedream app catalogue (search + paginate) for the "connect an app" UI. */
export async function browsePipedreamApps(query?: string, cursor?: string): Promise<{ apps: PipedreamApp[]; nextCursor?: string; hasMore: boolean }> {
  return getProvider().listApps(query, 48, cursor);
}

/** Execute a Pipedream action via the Connect API. `accountId` is the binding; `userId` scopes the external id. */
export async function runPipedreamAction(
  projectId: string,
  slug: string,
  app: string,
  actionKey: string,
  args: Record<string, unknown>,
  accountId: string,
  userId: string | null = null,
): Promise<ExecResult> {
  try {
    const data = await getProvider().runAction(externalUserId(projectId, slug, userId), app, actionKey, args, accountId);
    return { status: 200, ok: true, data };
  } catch (e) {
    return { status: 502, ok: false, data: (e as Error).message };
  }
}

/**
 * Generic Connect-Proxy request for the `request` tool (binding kind
 * `pipedream_proxy`). `args` carries { method, url, body?, headers? }; the
 * upstream status flows back as the ExecResult status so the agent sees real
 * 4xx/5xx, not a flattened 200.
 */
export async function runPipedreamProxy(
  projectId: string,
  slug: string,
  args: Record<string, unknown>,
  accountId: string,
  userId: string | null = null,
): Promise<ExecResult> {
  const method = typeof args.method === 'string' && args.method.trim() ? args.method : 'GET';
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return { status: 400, ok: false, data: '`url` (full target API URL) is required' };
  if (!/^https?:\/\//i.test(url)) return { status: 400, ok: false, data: '`url` must be an absolute http(s) URL' };
  try {
    const r = await getProvider().proxyRequest(externalUserId(projectId, slug, userId), accountId, {
      method,
      url,
      body: args.body,
      headers: (args.headers && typeof args.headers === 'object' ? args.headers : undefined) as Record<string, string> | undefined,
    });
    return { status: r.status, ok: r.ok, data: r.data };
  } catch (e) {
    return { status: 502, ok: false, data: (e as Error).message };
  }
}
