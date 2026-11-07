/**
 * Workspace route names for kortixd's calls to the Kortix API, and the
 * fallback to the legacy names for an API that predates `/v1/workspaces`.
 *
 * kortixd calls the canonical names (`/v1/workspaces/:id/…`, `/v1/me`, …).
 * The API keeps every legacy name mounted permanently, so a daemon released
 * before the rename keeps working. An API older than the rename (a self-host
 * API before 2026-11-05) answers a canonical name with the framework's
 * unknown-route 404 (`app.notFound` in apps/api/src/http-errors.ts:
 * `{ error: true, message: 'Not found', status: 404 }`). Then
 * {@link withWorkspaceRouteFallback} sends the same request once more on the
 * legacy name and remembers, in memory, per API base, to send the legacy names
 * from then on. A handler 404 (a session that does not exist) is returned as is.
 *
 * The map is a copy of `@kortix/shared/workspace-routes`: kortixd is built
 * standalone and does not resolve `@kortix/shared` (see tsconfig.json).
 * workspace-routes.test.ts holds the two equal. Pure except for the fetch.
 */

const WORKSPACE_ACCOUNT_FAMILIES: ReadonlySet<string> = new Set([
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
  'tokens',
  'top-up-requests',
])

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function swapPrefix(path: string, from: string, to: string): string {
  return `${to}${path.slice(from.length)}`
}

/** The legacy name of a canonical workspace path, or `null`. Same as `@kortix/shared`. */
export function legacyWorkspaceRoute(path: string): string | null {
  // The project audit slice: `/v1/workspaces/:id/audit` is the workspace audit log.
  const audit = /^\/v1\/workspaces\/([^/]+)\/audit\/events$/.exec(path)
  if (audit) return `/v1/projects/${audit[1]}/audit`
  if (path.startsWith('/v1/webhooks/workspaces/')) {
    return swapPrefix(path, '/v1/webhooks/workspaces/', '/v1/webhooks/projects/')
  }
  if (under(path, '/v1/workspaces')) {
    const family = /^\/v1\/workspaces\/[^/]+\/([^/]+)/.exec(path)?.[1]
    return family !== undefined && WORKSPACE_ACCOUNT_FAMILIES.has(family)
      ? swapPrefix(path, '/v1/workspaces/', '/v1/accounts/')
      : swapPrefix(path, '/v1/workspaces', '/v1/projects')
  }
  if (under(path, '/v1/me')) return swapPrefix(path, '/v1/me', '/v1/accounts/me')
  if (under(path, '/v1/invites')) return swapPrefix(path, '/v1/invites', '/v1/account-invites')
  if (path.startsWith('/v1/connectors/workspaces/')) {
    return swapPrefix(path, '/v1/connectors/workspaces/', '/v1/connectors/projects/')
  }
  if (path.startsWith('/scim/v2/workspaces/')) return swapPrefix(path, '/scim/v2/workspaces/', '/scim/v2/accounts/')
  return null
}

// replica-local: API bases that answered a canonical name with the unknown-route 404.
const legacyBases = new Set<string>()

/** Forget every remembered legacy base. For tests. */
export function resetWorkspaceRouteMemory(): void {
  legacyBases.clear()
}

/** The API base and the legacy URL of a canonical workspace URL, or `null`. */
function splitCanonical(url: string): { base: string; legacyUrl: string } | null {
  const cut = url.search(/[?#]/)
  const path = cut === -1 ? url : url.slice(0, cut)
  const suffix = cut === -1 ? '' : url.slice(cut)
  const v1 = path.indexOf('/v1/')
  const scim = path.indexOf('/scim/v2/')
  const start = v1 === -1 ? scim : scim === -1 ? v1 : Math.min(v1, scim)
  if (start === -1) return null
  const legacy = legacyWorkspaceRoute(path.slice(start))
  return legacy === null ? null : { base: path.slice(0, start), legacyUrl: `${path.slice(0, start)}${legacy}${suffix}` }
}

async function isUnknownRoute(response: Response): Promise<boolean> {
  if (response.status !== 404) return false
  try {
    const body = (await response.clone().json()) as Record<string, unknown> | null
    return body !== null && body.error === true && body.message === 'Not found' && body.code === undefined
  } catch {
    return false
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Wrap a `fetch` so a canonical workspace URL reaches an older API too. Any
 * other URL, and any other answer, pass through. A `Request` input keeps its
 * method and headers on the retry; its body is copied before the first send.
 */
export function withWorkspaceRouteFallback(fetchImpl: Fetch): typeof fetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const split = splitCanonical(url)
    if (!split) return fetchImpl(input, init)
    const bodyCopy = input instanceof Request && input.body !== null ? await input.clone().arrayBuffer() : null
    const retarget = (): [string | URL | Request, RequestInit | undefined] =>
      input instanceof Request
        ? [new Request(split.legacyUrl, { method: input.method, headers: input.headers, body: bodyCopy ?? undefined, signal: input.signal, redirect: input.redirect }), init]
        : [split.legacyUrl, init]
    if (legacyBases.has(split.base)) return fetchImpl(...retarget())
    // A stream body is read by the first send and cannot be sent again.
    const oneShot = init?.body instanceof ReadableStream
    const response = await fetchImpl(input, init)
    if (oneShot || !(await isUnknownRoute(response))) return response
    legacyBases.add(split.base)
    return fetchImpl(...retarget())
  }
  return wrapped as typeof fetch
}

/** `fetch` to the Kortix API with the legacy-name fallback. Reads `globalThis.fetch` per call. */
export const kortixApiFetch: Fetch = (input, init) => withWorkspaceRouteFallback(globalThis.fetch)(input, init)
