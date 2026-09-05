// The marketplace — the anonymous template catalog
// (`/v1/public/marketplace/templates[/:slug]`) and the per-project install
// (`/v1/projects/:id/marketplace/install-session`).
//
// A template is a public GitHub repository whose `kortix.yaml` declares agents,
// skills, connectors and triggers. Installing one MERGES that declaration into a
// project through an agent-driven session that lands a change request — so
// `createMarketplaceInstallSession` returns a SESSION to open, never a finished
// install. Nothing records what a project has installed: the change request is
// the record, and reverting it is the uninstall.
//
// The catalog reads are NOT built on `backendApi`, deliberately. That client
// wraps every call in the authenticated fetch path, which for a visitor with no
// token synthesizes a failure WITHOUT making the network call. The public routes
// take no auth at all (like `./public-session-shares`), so no Authorization
// header is sent and no `configureKortix()` call is required — `getBackendUrl()`
// degrades to a localhost default when unconfigured. That is what lets a server
// render of `/marketplace` read the catalog with `getToken: () => null`.

import { backendApi } from '../../http/api-client';
import { getBackendUrl } from '../../session/server-store/url-helpers';
import { unwrap } from './shared';

/** One agent a template contributes. */
export interface MarketplaceTemplateAgent {
  name: string;
  description: string | null;
}

/** One trigger a template contributes — the cadence its card advertises. */
export interface MarketplaceTemplateTrigger {
  slug: string;
  name: string;
  type: string;
  cron: string | null;
  agent: string;
  enabled: boolean;
}

/** One connector a template NEEDS. A requirement list, not a connection state. */
export interface MarketplaceTemplateConnector {
  slug: string;
  provider: string;
  app: string | null;
}

/** One template in the marketplace. */
export interface MarketplaceTemplate {
  slug: string;
  title: string;
  description: string | null;
  /** `owner/repo`. */
  repo: string;
  repo_owner: string;
  repo_name: string;
  /** The branch or tag pinned, or null for the default branch. */
  git_ref: string | null;
  /** The commit the card was derived from and the install reads. */
  resolved_sha: string;
  agents: MarketplaceTemplateAgent[];
  triggers: MarketplaceTemplateTrigger[];
  connectors: MarketplaceTemplateConnector[];
  skills: string[];
  env_required: string[];
}

export interface MarketplaceTemplateListing {
  templates: MarketplaceTemplate[];
}

export interface ListMarketplaceTemplatesOptions {
  /** Free-text match over title, description, repo and slug. */
  q?: string;
}

export class MarketplaceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

function marketplaceUrl(path = '', options?: ListMarketplaceTemplatesOptions): string {
  const params = new URLSearchParams();
  const q = options?.q?.trim();
  if (q) params.set('q', q);
  const query = params.size > 0 ? `?${params}` : '';
  return `${getBackendUrl()}/public/marketplace/templates${path}${query}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — fall through to the generic error message below.
  }
  if (!res.ok) {
    const message =
      (body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null) ||
      res.statusText ||
      `HTTP ${res.status}`;
    throw new MarketplaceError(message, res.status);
  }
  return body as T;
}

/** The template catalog, readable with no account and no token. */
export async function listMarketplaceTemplates(
  options?: ListMarketplaceTemplatesOptions,
): Promise<MarketplaceTemplateListing> {
  return getJson<MarketplaceTemplateListing>(marketplaceUrl('', options));
}

/**
 * One template by slug — the `/marketplace/[slug]` page's read.
 *
 * Throws a {@link MarketplaceError} with `status: 404` for a slug that is not in
 * the catalog.
 */
export async function getMarketplaceTemplate(slug: string): Promise<MarketplaceTemplate> {
  const body = await getJson<{ template: MarketplaceTemplate }>(
    marketplaceUrl(`/${encodeURIComponent(slug)}`),
  );
  return body.template;
}

/**
 * Start the agent-driven install of one template and return the session to
 * open.
 *
 * The install itself happens inside that session: the agent reads both
 * manifests, merges, and opens a change request. Nothing is committed by this
 * call. Behind the `marketplace` feature flag — `403 feature_disabled` while it
 * is off.
 */
export async function createMarketplaceInstallSession(
  projectId: string,
  slug: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/marketplace/install-session`,
      { slug },
    ),
  );
}
