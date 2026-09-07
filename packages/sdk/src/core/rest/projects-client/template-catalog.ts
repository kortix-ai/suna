// Templates — the anonymous template catalog
// (`/v1/public/templates[/:slug]`) and the per-project install
// (`/v1/projects/:id/templates/install-session`).
//
// A template is a public GitHub repository whose `kortix.yaml` declares agents,
// skills, connectors and triggers. Installing one MERGES that declaration into a
// project through an agent-driven session that lands a change request — so
// `createTemplateInstallSession` returns a SESSION to open, never a finished
// install. Nothing records what a project has installed: the change request is
// the record, and reverting it is the uninstall.
//
// The catalog reads are NOT built on `backendApi`, deliberately. That client
// wraps every call in the authenticated fetch path, which for a visitor with no
// token synthesizes a failure WITHOUT making the network call. The public routes
// take no auth at all (like `./public-session-shares`), so no Authorization
// header is sent and no `configureKortix()` call is required — `getBackendUrl()`
// degrades to a localhost default when unconfigured. That is what lets a server
// render of `/templates` read the catalog with `getToken: () => null`.

import { backendApi } from '../../http/api-client';
import { getBackendUrl } from '../../session/server-store/url-helpers';
import { unwrap } from './shared';

/** One agent a template contributes. */
export interface TemplateAgent {
  name: string;
  description: string | null;
}

/** One trigger a template contributes — the cadence its card advertises. */
export interface TemplateTrigger {
  slug: string;
  name: string;
  type: string;
  cron: string | null;
  agent: string;
  enabled: boolean;
}

/** One connector a template NEEDS. A requirement list, not a connection state. */
export interface TemplateConnector {
  slug: string;
  provider: string;
  app: string | null;
}

/** One template in the template catalog. */
export interface Template {
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
  agents: TemplateAgent[];
  triggers: TemplateTrigger[];
  connectors: TemplateConnector[];
  skills: string[];
  env_required: string[];
}

export interface TemplateListing {
  templates: Template[];
}

export interface ListTemplateCatalogOptions {
  /** Free-text match over title, description, repo and slug. */
  q?: string;
}

export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

function catalogUrl(path = '', options?: ListTemplateCatalogOptions): string {
  const params = new URLSearchParams();
  const q = options?.q?.trim();
  if (q) params.set('q', q);
  const query = params.size > 0 ? `?${params}` : '';
  return `${getBackendUrl()}/public/templates${path}${query}`;
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
    throw new TemplateError(message, res.status);
  }
  return body as T;
}

/** The template catalog, readable with no account and no token. */
export async function listTemplateCatalog(
  options?: ListTemplateCatalogOptions,
): Promise<TemplateListing> {
  return getJson<TemplateListing>(catalogUrl('', options));
}

/**
 * One template by slug — the `/templates/[slug]` page's read.
 *
 * Throws a {@link TemplateError} with `status: 404` for a slug that is not in
 * the catalog.
 */
export async function getTemplateBySlug(slug: string): Promise<Template> {
  const body = await getJson<{ template: Template }>(
    catalogUrl(`/${encodeURIComponent(slug)}`),
  );
  return body.template;
}

/** One readable file in a template's repository, at its pinned commit. */
export interface TemplateFile {
  /** Repo-relative path, e.g. `.kortix/opencode/agents/sre.md`. */
  path: string;
  /** Bytes. */
  size: number;
}

/** A template's file tree, plus the file its page should open on. */
export interface TemplateFileListing {
  files: TemplateFile[];
  /** The README, else the manifest, else the first file. `null` when empty. */
  default_path: string | null;
}

/**
 * Every readable file in the template's repository, at the commit its card was
 * derived from.
 *
 * Binary files are absent by construction — the listing only carries what
 * {@link readTemplateFile} can return as text, so anything listed can be
 * opened. An empty list is a normal answer (an unreachable repo, a rate limit),
 * not an error: the catalog already carries what the template declares.
 */
export async function listTemplateFiles(slug: string): Promise<TemplateFileListing> {
  return getJson<TemplateFileListing>(
    catalogUrl(`/${encodeURIComponent(slug)}/files`),
  );
}

/**
 * One file's text.
 *
 * Only a path from {@link listTemplateFiles} resolves; anything else throws a
 * {@link TemplateError} with `status: 404`, because the listing is the
 * allowlist rather than a hint.
 */
export async function readTemplateFile(slug: string, path: string): Promise<string> {
  const body = await getJson<{ path: string; content: string }>(
    `${catalogUrl(`/${encodeURIComponent(slug)}/file`)}?path=${encodeURIComponent(path)}`,
  );
  return body.content;
}

/**
 * Start the agent-driven install of one template and return the session to
 * open.
 *
 * The install itself happens inside that session: the agent reads both
 * manifests, merges, and opens a change request. Nothing is committed by this
 * call. Behind the `templates` feature flag — `403 feature_disabled` while it
 * is off.
 */
export async function createTemplateInstallSession(
  projectId: string,
  slug: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${encodeURIComponent(projectId)}/templates/install-session`,
      { slug },
    ),
  );
}
