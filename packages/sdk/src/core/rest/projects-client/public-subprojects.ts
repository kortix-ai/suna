// Anonymous, read-only subproject catalogue — `/v1/public/subprojects` and
// `/v1/public/subprojects/:slug` (apps/api/src/public-subprojects/index.ts).
// Backs the logged-out `/marketplace` and `/marketplace/[slug]` SEO pages.
//
// Two differences from `./subprojects`, both deliberate:
//
//  1. **No auth, ever.** Like `./public-session-shares`, this is NOT built on
//     `backendApi`: that client wraps every call in the authenticated fetch
//     path, which for a visitor with no token synthesizes a failure WITHOUT
//     making the network call. No Authorization header is sent, and no
//     `configureKortix()` call is required — `getBackendUrl()` degrades to a
//     localhost default when unconfigured.
//  2. **`public` + `active` only, keyed by SLUG.** The narrowing lives in the
//     API's WHERE clause, not here, so nothing a caller passes can widen it.
//     A non-public slug answers 404, never 403 — to an anonymous visitor a
//     private subproject and a nonexistent one are the same thing.
//
// Nothing here reports INSTALLED state. Installed-ness is a property of a
// project, and there is no project in an anonymous request.

import { getBackendUrl } from '../../session/server-store/url-helpers';
import type { ListSubprojectsOptions, Subproject, SubprojectListing } from './subprojects';

export class PublicSubprojectError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PublicSubprojectError';
  }
}

function publicSubprojectUrl(path = '', options?: ListSubprojectsOptions): string {
  const params = new URLSearchParams();
  const q = options?.q?.trim();
  if (q) params.set('q', q);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.size > 0 ? `?${params}` : '';
  return `${getBackendUrl()}/public/subprojects${path}${query}`;
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
    throw new PublicSubprojectError(message, res.status);
  }
  return body as T;
}

/**
 * The curated global catalogue, readable with no account and no token.
 *
 * Same page shape as {@link listSubprojects}, and the server clamps `limit` to
 * 100 exactly as the authenticated route does.
 */
export async function listPublicSubprojects(
  options?: ListSubprojectsOptions,
): Promise<SubprojectListing> {
  return getJson<SubprojectListing>(publicSubprojectUrl('', options));
}

/**
 * One public subproject by slug — the `/marketplace/[slug]` page's read.
 *
 * Keyed on slug rather than id because the slug is the URL. Throws a
 * {@link PublicSubprojectError} with `status: 404` for a slug that is not
 * public and active.
 */
export async function getPublicSubproject(slug: string): Promise<Subproject> {
  const body = await getJson<{ subproject: Subproject }>(
    publicSubprojectUrl(`/${encodeURIComponent(slug)}`),
  );
  return body.subproject;
}
