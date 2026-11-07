/**
 * Workspace route names, and the fallback to the legacy names for an older API.
 *
 * The SDK calls the canonical `/v1/workspaces` names. The API keeps every old
 * name mounted permanently, so a current server answers both:
 *
 * | Canonical                                   | Legacy                                   |
 * |---------------------------------------------|------------------------------------------|
 * | `/v1/workspaces[/…]`                        | `/v1/projects[/…]`                       |
 * | `/v1/workspaces/:workspaceId/<family>[/…]`  | `/v1/accounts/:workspaceId/<family>[/…]` |
 * | `/v1/me[/…]`                                | `/v1/accounts/me[/…]`                    |
 * | `/v1/invites[/…]`                           | `/v1/account-invites[/…]`                |
 * | `/v1/connectors/workspaces/:workspaceId/…`  | `/v1/connectors/projects/:workspaceId/…` |
 * | `/scim/v2/workspaces/:workspaceId/…`        | `/scim/v2/accounts/:workspaceId/…`       |
 * | `/v1/workspaces/:workspaceId/audit/events`  | `/v1/projects/:workspaceId/audit`        |
 * | `/v1/webhooks/workspaces/:workspaceId/…`    | `/v1/webhooks/projects/:workspaceId/…`   |
 *
 * The map is a copy of `@kortix/shared/workspace-routes`: this package is
 * published and cannot depend on the private `@kortix/shared`.
 * `workspace-routes.test.ts` holds the two equal.
 *
 * A server that predates the workspace mount (a self-host API older than
 * 2026-11-05) answers a canonical name with the framework's unknown-route 404
 * (`app.notFound` in `apps/api/src/http-errors.ts`). {@link withWorkspaceRouteFallback}
 * then sends the same request once more on the legacy name and remembers, in
 * memory, per API base, to send the legacy names from then on. A handler 404
 * (a resource that does not exist) carries another body and is returned as is.
 *
 * Internal: not exported from the package root.
 */

/** Account-key route families served under `/v1/workspaces/:workspaceId/<family>`. */
export const WORKSPACE_ACCOUNT_FAMILIES = [
  'audit',
  'automations',
  'branding',
  'capture',
  'iam',
  'invites',
  'leave',
  'members',
  'secret-resources',
  'subscription-connections',
  'keys',
  'tokens',
  'top-up-requests',
] as const;

const FAMILY_SET: ReadonlySet<string> = new Set(WORKSPACE_ACCOUNT_FAMILIES);

function isFamily(segment: string | undefined): boolean {
  return segment !== undefined && FAMILY_SET.has(segment);
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function swapPrefix(path: string, from: string, to: string): string {
  return `${to}${path.slice(from.length)}`;
}

/** The project audit slice, `/v1/projects/<id>/audit` ↔ `/v1/workspaces/<id>/audit/events`. */
const PROJECT_AUDIT = /^\/v1\/projects\/([^/]+)\/audit$/;
const WORKSPACE_AUDIT_EVENTS = /^\/v1\/workspaces\/([^/]+)\/audit\/events$/;

/** The canonical name of a legacy workspace path, or `null`. Same as `@kortix/shared`. */
export function canonicalWorkspaceRoute(path: string): string | null {
  const audit = PROJECT_AUDIT.exec(path);
  if (audit) return `/v1/workspaces/${audit[1]}/audit/events`;
  if (path.startsWith('/v1/webhooks/projects/')) {
    return swapPrefix(path, '/v1/webhooks/projects/', '/v1/webhooks/workspaces/');
  }
  if (under(path, '/v1/projects')) return swapPrefix(path, '/v1/projects', '/v1/workspaces');
  if (under(path, '/v1/accounts/me')) return swapPrefix(path, '/v1/accounts/me', '/v1/me');
  if (under(path, '/v1/account-invites')) return swapPrefix(path, '/v1/account-invites', '/v1/invites');
  if (path.startsWith('/v1/connectors/projects/')) {
    return swapPrefix(path, '/v1/connectors/projects/', '/v1/connectors/workspaces/');
  }
  if (path.startsWith('/scim/v2/accounts/')) return swapPrefix(path, '/scim/v2/accounts/', '/scim/v2/workspaces/');
  const scoped = /^\/v1\/accounts\/[^/]+\/([^/]+)/.exec(path);
  if (scoped && isFamily(scoped[1])) return swapPrefix(path, '/v1/accounts/', '/v1/workspaces/');
  return null;
}

/** The legacy name of a canonical workspace path, or `null`. Same as `@kortix/shared`. */
export function legacyWorkspaceRoute(path: string): string | null {
  const audit = WORKSPACE_AUDIT_EVENTS.exec(path);
  if (audit) return `/v1/projects/${audit[1]}/audit`;
  if (path.startsWith('/v1/webhooks/workspaces/')) {
    return swapPrefix(path, '/v1/webhooks/workspaces/', '/v1/webhooks/projects/');
  }
  if (under(path, '/v1/workspaces')) {
    const family = /^\/v1\/workspaces\/[^/]+\/([^/]+)/.exec(path)?.[1];
    return isFamily(family)
      ? swapPrefix(path, '/v1/workspaces/', '/v1/accounts/')
      : swapPrefix(path, '/v1/workspaces', '/v1/projects');
  }
  if (under(path, '/v1/me')) return swapPrefix(path, '/v1/me', '/v1/accounts/me');
  if (under(path, '/v1/invites')) return swapPrefix(path, '/v1/invites', '/v1/account-invites');
  if (path.startsWith('/v1/connectors/workspaces/')) {
    return swapPrefix(path, '/v1/connectors/workspaces/', '/v1/connectors/projects/');
  }
  if (path.startsWith('/scim/v2/workspaces/')) return swapPrefix(path, '/scim/v2/workspaces/', '/scim/v2/accounts/');
  return null;
}

/**
 * Legacy routes with no canonical name (same as `WORKSPACE_LEGACY_ONLY_ROUTES`
 * in `@kortix/shared`, method-free): the current API serves them on
 * `/v1/projects` only. An unknown-route 404 on their canonical spelling says
 * nothing about the server's age, so the fallback retries them once without
 * remembering the base.
 */
const LEGACY_ONLY_PATHS: readonly RegExp[] = [
  /^\/v1\/projects\/(provision|provision-stream|quota)$/,
];

function isLegacyOnly(legacyUrl: string): boolean {
  const path = legacyUrl.replace(/[?#].*$/, '');
  const v1 = path.indexOf('/v1/');
  if (v1 === -1) return false;
  return LEGACY_ONLY_PATHS.some((re) => re.test(path.slice(v1)));
}

// ── The fallback ────────────────────────────────────────────────────────────

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * API bases (the URL up to `/v1` or `/scim/v2`) that answered a canonical name
 * with the unknown-route 404. In memory only: a restarted process asks again,
 * one extra request per base.
 */
const legacyBases = new Set<string>();

/** Forget every remembered legacy base. For tests. */
export function resetWorkspaceRouteMemory(): void {
  legacyBases.clear();
}

interface SplitUrl {
  /** Everything before the API path: `http://host`, `/_kortix/api`. */
  base: string;
  /** The legacy URL of the same request. */
  legacyUrl: string;
}

/**
 * The API base and the legacy URL of a canonical workspace URL, or `null`.
 * The API path is the first `/v1/` (or `/scim/v2/`) segment of the URL, so a
 * sandbox proxy path (`/v1/p/<ext>/<port>/v1/me`) is never rewritten. A URL
 * with no such segment is read against `apiBase`, the configured `backendUrl`
 * of a host that proxies the API under another path (`/api/kortix`).
 */
function splitCanonical(url: string, apiBase?: string): SplitUrl | null {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? '' : url.slice(cut);
  const v1 = path.indexOf('/v1/');
  const scim = path.indexOf('/scim/v2/');
  const start = v1 === -1 ? scim : scim === -1 ? v1 : Math.min(v1, scim);
  if (start !== -1) {
    const legacy = legacyWorkspaceRoute(path.slice(start));
    return legacy === null ? null : { base: path.slice(0, start), legacyUrl: `${path.slice(0, start)}${legacy}${suffix}` };
  }
  const base = apiBase?.replace(/\/+$/, '');
  if (!base || !path.startsWith(`${base}/`)) return null;
  const legacy = legacyWorkspaceRoute(`/v1${path.slice(base.length)}`);
  return legacy === null ? null : { base, legacyUrl: `${base}${legacy.slice('/v1'.length)}${suffix}` };
}

/** True when a 404 is the framework's unknown-route answer, not a handler's. */
async function isUnknownRoute(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const body = (await response.clone().json()) as Record<string, unknown> | null;
    return body !== null && body.error === true && body.message === 'Not found' && body.code === undefined;
  } catch {
    return false;
  }
}

/** The same request on another URL. The body was copied before the first send. */
function retarget(input: RequestInfo | URL, init: RequestInit | undefined, url: string, body?: ArrayBuffer | null) {
  if (input instanceof Request) {
    return {
      input: new Request(url, {
        method: input.method,
        headers: input.headers,
        body: body ?? undefined,
        signal: input.signal,
        credentials: input.credentials,
        redirect: input.redirect,
      }),
      init,
    };
  }
  return { input: url, init };
}

/**
 * Wrap a `fetch` so a canonical workspace URL reaches an older API too: on the
 * unknown-route 404 the request is sent once more on the legacy name, and the
 * base is remembered. Any other URL and any other answer pass through.
 * `apiBase`: the configured `backendUrl`, for a URL with no `/v1/` segment.
 */
export function withWorkspaceRouteFallback(fetchImpl: Fetch, apiBase?: string): Fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const split = splitCanonical(url, apiBase);
    if (!split) return fetchImpl(input, init);

    const hasBody = input instanceof Request ? input.body !== null : init?.body != null;
    const bodyCopy = input instanceof Request && hasBody ? await input.clone().arrayBuffer() : null;
    if (legacyBases.has(split.base)) {
      const next = retarget(input, init, split.legacyUrl, bodyCopy);
      return fetchImpl(next.input, next.init);
    }
    // A stream body is read by the first send and cannot be sent again.
    const oneShot = typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream;
    const response = await fetchImpl(input, init);
    if (oneShot || !(await isUnknownRoute(response))) return response;

    if (!isLegacyOnly(split.legacyUrl)) legacyBases.add(split.base);
    const next = retarget(input, init, split.legacyUrl, bodyCopy);
    return fetchImpl(next.input, next.init);
  };
}
