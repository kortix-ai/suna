/**
 * Pipedream Connect — the 1-click connector path (kept as the primary onboarding
 * for SaaS apps). Adapted from the pre-refactor provider (commit 9078f28e).
 *
 * Model fit: a connector with provider="pipedream" declares `app` + `account` in
 * kortix.yaml. The OAuth lives on Pipedream's side; we store only the connected
 * **account id** as a `scope='connector'` project secret (the binding) — so it's
 * shareable like any connector credential and never injected into the sandbox.
 * The catalog (app actions) is fetched from Pipedream and normalized. Execution
 * goes through the Connect `actions/run` API. See docs/specs/connector.md §5.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { upsertCredential, upsertConnectionCredential } from './credentials';
import type { ExecResult } from './call';
import { isCatalogApp } from './pipedream-catalog';
import {
  getCatalogSnapshot,
  type CatalogCategory,
  type CatalogPageFetcher,
} from './pipedream-index';
import { pageOf, rankApps, type CatalogApp } from './pipedream-search';
import type { PipedreamActionLike } from './types';

export { isCatalogApp } from './pipedream-catalog';
export type { CatalogCategory } from './pipedream-index';

const PD_BASE = 'https://api.pipedream.com';

/**
 * Pipedream's catalogue includes internal WORKFLOW UTILITIES (schedule, http,
 * pipedream_utils, formatting, helper_functions, data stores, …) alongside real
 * third-party apps. Discover uses Pipedream only where it adds unique value:
 * managed OAuth. API-key apps connect directly through their real API instead
 * of adding an intermediary. Utilities and native Kortix apps are excluded too.
 */

export function pipedreamConfigured(): boolean {
  return !!(config.PIPEDREAM_CLIENT_ID && config.PIPEDREAM_CLIENT_SECRET && config.PIPEDREAM_PROJECT_ID);
}

/**
 * Stable external_user_id per connector — connector-wide (`projectId:slug`),
 * since every connector resolves the one shared credential (`per_user`, which
 * scoped this per-member via a trailing `:userId`, was removed 2026-07-05).
 * `userId` stays an optional param for call-site/back-compat stability, but
 * every caller now passes `null`. The webhook still tolerates the legacy
 * 3-part `projectId:slug:userId` shape on parse.
 */
function externalUserId(projectId: string, slug: string, userId?: string | null): string {
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
      success_redirect_uri: redirects?.success || `${origin}/connections?connected=true`,
      error_redirect_uri: redirects?.error || `${origin}/connections?error=true`,
    };
    if (app) body.app_slug = app;
    if (config.KORTIX_URL && config.PIPEDREAM_WEBHOOK_SECRET) {
      const sig = createHmac('sha256', config.PIPEDREAM_WEBHOOK_SECRET).update(extUserId).digest('hex');
      body.webhook_uri = `${config.KORTIX_URL.replace(/\/+$/, '')}/v1/connectors/webhook/pipedream?sig=${sig}`;
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

  /**
   * One raw page of Pipedream's app catalogue, mapped but **not filtered**.
   *
   * Filtering is the caller's job, and there are two callers with different
   * needs: the catalogue index applies `isCatalogApp` while crawling, and the
   * icon lookup in `sync.ts` must be able to find an app whose connector
   * already exists even if it would not be offered in the catalogue today.
   *
   * `hasMore` is driven by Pipedream's cursor, NOT `apps.length` — any filter a
   * caller applies would otherwise shrink a page below `limit` and stop paging
   * early.
   */
  async listApps(query?: string, limit = 48, cursor?: string): Promise<{ apps: PipedreamApp[]; total?: number; nextCursor?: string; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('limit', String(limit));
    if (cursor) params.set('after', cursor);
    if (!query) { params.set('sort_key', 'featured_weight'); params.set('sort_direction', 'desc'); }
    const data = await this.api<{
      page_info: { total_count: number; count: number; end_cursor?: string };
      data: Array<{ name_slug: string; name: string; description?: string; img_src?: string; auth_type?: string; categories: string[]; has_actions?: boolean; has_triggers?: boolean; featured_weight?: number }>;
    }>('GET', `/v1/connect/${this.projectId}/apps?${params.toString()}`);
    const apps = (data.data || []).map((a) => ({
      slug: a.name_slug, name: a.name, description: a.description ?? null, imgSrc: a.img_src ?? null,
      authType: a.auth_type ?? null, categories: a.categories || [],
      hasActions: a.has_actions === true, hasTriggers: a.has_triggers === true,
      featuredWeight: typeof a.featured_weight === 'number' ? a.featured_weight : 0,
    }));
    return {
      apps,
      total: data.page_info?.total_count,
      nextCursor: data.page_info?.end_cursor,
      hasMore: !!data.page_info?.end_cursor,
    };
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

  /**
   * actionKey → the component's account-selector prop NAME. Components name
   * their app prop with an arbitrary variable, NOT the app slug — salesforce
   * components use `salesforce` (slug `salesforce_rest_api`), google_drive
   * uses `googleDrive`. Binding the credential under the slug lands on a
   * nonexistent prop, so the component runs with an EMPTY $auth and crashes
   * deep in its own code (e.g. salesforce `_subdomain()` TypeError) — that was
   * the prod-wide named-action 502 incident of 2026-06-11.
   */
  private appPropNames = new Map<string, string>();

  private async resolveAppPropName(actionKey: string, app: string): Promise<string> {
    const cached = this.appPropNames.get(actionKey);
    if (cached) return cached;
    let name = app; // last-resort fallback: the slug (correct for e.g. gmail)
    try {
      const res = await this.api<{ data?: { configurable_props?: Array<{ name?: string; type?: string }> } }>(
        'GET', `/v1/connect/${this.projectId}/components/${encodeURIComponent(actionKey)}`,
      );
      const props = res.data?.configurable_props ?? [];
      const appProp = props.find((p) => p?.type === 'app' && p.name);
      if (appProp?.name) name = appProp.name;
    } catch { /* keep the slug fallback — never block the call on metadata */ }
    this.appPropNames.set(actionKey, name);
    return name;
  }

  async runAction(extUserId: string, app: string, actionKey: string, props: Record<string, unknown>, providerAccountId: string): Promise<unknown> {
    const appProp = await this.resolveAppPropName(actionKey, app);
    const data = await this.api<Record<string, unknown>>('POST', `/v1/connect/${this.projectId}/actions/run`, {
      id: actionKey,
      external_user_id: extUserId,
      // Spread the agent's args FIRST so the account-selector binding (under the
      // component's REAL app-prop name) always wins — a stray same-named arg can
      // never overwrite the credential.
      configured_props: { ...props, [appProp]: { authProvisionId: providerAccountId } },
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
  redirects?: { success?: string; error?: string },
): Promise<{ connectUrl?: string; token: string; expiresAt: string }> {
  return getProvider().createConnectToken(externalUserId(projectId, slug, userId), app, redirects);
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

/** Finalize a session-selectable connection using the exact external-user
 * identity minted by the connection route. */
export async function finalizePipedreamConnectionAuthorization(opts: {
  projectId: string;
  slug: string;
  app: string;
  connectorId: string;
  connectionId: string;
  createdBy: string | null;
}): Promise<{ connected: boolean; accountId?: string }> {
  const accounts = await getProvider().listAccounts(
    externalUserId(opts.projectId, opts.slug, opts.connectionId),
  );
  const match = accounts.find((account) => account.app === opts.app) ?? accounts[0];
  if (!match) return { connected: false };
  await upsertConnectionCredential({
    projectId: opts.projectId,
    connectorId: opts.connectorId,
    connectionId: opts.connectionId,
    value: match.id,
    kind: 'connection',
    createdBy: opts.createdBy,
  });
  return { connected: true, accountId: match.id };
}

/** Verify the webhook signature (HMAC of external_user_id with the webhook secret). */
export function verifyWebhookSig(extUserId: string, sig: string | null): boolean {
  if (!config.PIPEDREAM_WEBHOOK_SECRET || !sig) return false;
  const expected = createHmac('sha256', config.PIPEDREAM_WEBHOOK_SECRET).update(extUserId).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(sig, 'hex');
  if (expectedBuf.length !== sigBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

/** Fetch the app's action catalog (raw, for normalizePipedream). */
export async function pipedreamCatalog(app: string): Promise<PipedreamActionLike[]> {
  return getProvider().listActions(app);
}

/** List the connected accounts for an external user id (used by finalize + live e2e). */
export async function pipedreamListAccounts(extUserId: string): Promise<Array<{ id: string; app: string; appName: string }>> {
  return getProvider().listAccounts(extUserId);
}

/**
 * One catalogue app.
 *
 * `authType` is a free string, not `'oauth'`. It was narrowed to the literal
 * when the catalogue was OAuth-only, which is the filter that hid 79% of
 * Pipedream's apps — see `pipedream-catalog.ts`. Nothing in `apps/web` or
 * `packages/sdk` reads this field to gate behaviour; it is descriptive.
 */
export type PipedreamApp = CatalogApp;

/** Page size for both the live fallback and the index-backed catalogue. */
const CATALOG_PAGE_SIZE = 48;

/** Fetch one crawl page, bound to the configured provider. */
const crawlPage: CatalogPageFetcher = async (limit, cursor) => {
  const page = await getProvider().listApps(undefined, limit, cursor);
  return { apps: page.apps, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
};

/**
 * Browse the Pipedream app catalogue live, one page at a time.
 *
 * The fallback path, used only while the index is still warming, and by
 * `sync.ts` to resolve one app's icon by slug. Applies `isCatalogApp` so a
 * warming page and a warm page offer the same apps.
 */
export async function browsePipedreamApps(query?: string, cursor?: string): Promise<{ apps: PipedreamApp[]; total?: number; nextCursor?: string; hasMore: boolean }> {
  const page = await getProvider().listApps(query, CATALOG_PAGE_SIZE, cursor);
  return { ...page, apps: page.apps.filter(isCatalogApp) };
}

/** Resolve one app's icon by exact slug, unfiltered — a connector may already
 *  exist for an app the catalogue would not offer today. */
export async function pipedreamAppIcon(slug: string): Promise<string | null> {
  const page = await getProvider().listApps(slug, CATALOG_PAGE_SIZE);
  return page.apps.find((app) => app.slug === slug)?.imgSrc ?? null;
}

export interface PipedreamCatalogPage {
  apps: PipedreamApp[];
  categories: CatalogCategory[];
  total: number;
  nextCursor?: string;
  hasMore: boolean;
  /**
   * Whether the answer came from the complete catalogue index.
   *
   * `false` means the index is still crawling and this page came from the live
   * API: `categories` is empty and `category` was ignored. The client shows its
   * own client-side grouping for that render and re-queries once the index
   * lands.
   */
  indexReady: boolean;
  /**
   * Apps that match the query but publish no actions, and so are not in the
   * catalogue.
   *
   * Only meaningful while searching, and it exists for exactly one sentence of
   * copy: `q=SAP` matches `sap_s_4hana_cloud` and `sap_s_4hana_cloud_sandbox`,
   * both `has_actions: false`. Reporting "No matches for SAP" over that is
   * wrong twice — the apps exist, and the reason they are absent is one we can
   * state.
   */
  excludedNoActions: number;
}

/**
 * A page of the catalogue, filtered by query and/or category.
 *
 * Category filtering exists **only** here. Pipedream's `/apps` endpoint accepts
 * `?category=` and ignores it (verified: `total_count` is 3238 with and
 * without), so a category is meaningless against the live API and honest only
 * against the full snapshot.
 */
export async function pipedreamCatalogPage(input: {
  q?: string;
  category?: string;
  cursor?: string;
  limit?: number;
}): Promise<PipedreamCatalogPage> {
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : CATALOG_PAGE_SIZE;
  const { snapshot } = getCatalogSnapshot(crawlPage);

  if (!snapshot) {
    const live = await browsePipedreamApps(input.q, input.cursor);
    return {
      apps: live.apps,
      categories: [],
      total: live.total ?? live.apps.length,
      ...(live.nextCursor ? { nextCursor: live.nextCursor } : {}),
      hasMore: live.hasMore,
      indexReady: false,
      excludedNoActions: 0,
    };
  }

  const scoped = input.category
    ? (snapshot.byCategory.get(input.category) ?? [])
    : snapshot.apps;
  const ranked = rankApps(scoped, input.q ?? '');
  const page = pageOf(ranked, input.cursor, limit);

  // Counted only for a search. While browsing, "1,264 apps you cannot use" is
  // a number with nowhere to go.
  const excludedNoActions = input.q ? rankApps(snapshot.withoutActions, input.q).length : 0;

  return {
    apps: page.items,
    categories: snapshot.categories,
    total: page.total,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
    indexReady: true,
    excludedNoActions,
  };
}

export interface PipedreamCatalogSection {
  key: string;
  label: string;
  /** The category's TRUE size, not the length of `apps`. This is what lets a
   *  section heading state a count the page can honour. */
  total: number;
  apps: PipedreamApp[];
}

/**
 * The browse page: the top `perCategory` apps of each of the largest
 * categories, in one request.
 *
 * This is what makes the Discovery sections stop growing as the user scrolls.
 * Each section is a fixed slice of a complete category, chosen by prominence,
 * with the category's real total beside it — rather than "whatever the four
 * pages loaded so far happened to contain", which changed under the reader on
 * every landed page.
 */
export async function pipedreamCatalogSections(input?: {
  perCategory?: number;
  maxCategories?: number;
}): Promise<{ sections: PipedreamCatalogSection[]; categories: CatalogCategory[]; indexReady: boolean }> {
  const perCategory = input?.perCategory && input.perCategory > 0 ? Math.min(input.perCategory, 24) : 6;
  const maxCategories = input?.maxCategories && input.maxCategories > 0 ? Math.min(input.maxCategories, 40) : 12;
  const { snapshot } = getCatalogSnapshot(crawlPage);

  if (!snapshot) return { sections: [], categories: [], indexReady: false };

  const sections = snapshot.categories.slice(0, maxCategories).map((category) => ({
    key: category.key,
    label: category.label,
    total: category.count,
    apps: (snapshot.byCategory.get(category.key) ?? []).slice(0, perCategory),
  }));

  return { sections, categories: snapshot.categories, indexReady: true };
}

/** Build the catalogue index now. Called at boot so the first user request
 *  finds it warm; failures are logged and retried on demand. */
export function warmPipedreamCatalog(): void {
  if (!pipedreamConfigured()) return;
  getCatalogSnapshot(crawlPage);
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
