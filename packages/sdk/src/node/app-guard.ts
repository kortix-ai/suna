/**
 * One identity resolver for a Kortix App, whichever route proved the viewer.
 *
 * ## The defect this makes unrepresentable
 *
 * An App reached through the Kortix gate gets a signed `x-kortix-app-viewer`
 * header on every request, carrying user id, email AND group ids. The same App
 * set to `public` gets no header at all — the gate deliberately sends nobody —
 * so identity has to come from the App's own Kortix sign-in, which proves WHO
 * and says nothing about group membership.
 *
 * An App that guards on groups therefore stopped guarding the moment somebody
 * changed its access mode, silently, with no error and no failing test. That is
 * not a bug in one App; it is a shape every App would reproduce. So it belongs
 * here, once, rather than in each consumer.
 *
 * This resolver answers with the SAME viewer shape from either source, fetching
 * and caching groups on the path that does not carry them. Callers ask who this
 * is and never learn which mechanism answered.
 *
 * ## Everything fails closed
 *
 * `requireViewer` and `requireGroup` return either a viewer or a Response —
 * there is no third option and no boolean to get backwards. A caller cannot
 * write `if (!viewer) return true`, which is precisely the line that made every
 * dashboard in a `public` App world-readable.
 */

import { readAppViewer } from './app-viewer';
import type { KortixAuth } from './auth';

/** The viewer, identical in shape no matter which route proved them. */
export interface KortixGuardedViewer {
  userId: string;
  email: string | null;
  /** Always populated: from the signed header, or fetched on the sign-in path. */
  groupIds: string[];
  accountId: string;
  /** Which route proved this identity. For diagnostics — never for authorization. */
  source: 'app-gate' | 'kortix-sign-in';
  /** A Kortix token that acts AS this viewer, when one is available. */
  token: string | null;
}

export type KortixAppGuardResult =
  | { viewer: KortixGuardedViewer; response?: undefined }
  | { viewer?: undefined; response: Response };

export interface KortixAppGuardOptions {
  /** Verifies the gate's signed header. Defaults to `KORTIX_APP_VIEWER_SECRET`. */
  secret?: string;
  /** Kortix API base including the version prefix. Needed only for the sign-in path. */
  backendUrl?: string;
  /** The App's own sign-in, from `createKortixAuth`. Omit for a gate-only App. */
  auth?: Pick<KortixAuth, 'viewer' | 'signInUrl'> | null;
  /** How long a fetched group list stays fresh. Default 60s. */
  groupCacheTtlMs?: number;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export interface KortixAppGuard {
  /** The viewer for this request, or null when nobody is signed in. */
  viewer(request: Request): Promise<KortixGuardedViewer | null>;
  /** The viewer, or the redirect to sign-in. Never a bare null to mis-handle. */
  requireViewer(request: Request): Promise<KortixAppGuardResult>;
  /** The viewer when they are in ANY of `groupIds`, otherwise a refusal. */
  requireGroup(request: Request, groupIds: string[]): Promise<KortixAppGuardResult>;
  /** Can this deployment identify anyone at all, by either route? */
  identityConfigured(): boolean;
}

interface CacheEntry {
  groupIds: string[];
  at: number;
}

function envSecret(): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.KORTIX_APP_VIEWER_SECRET : undefined;
  } catch {
    return undefined;
  }
}

export function createKortixAppGuard(options: KortixAppGuardOptions = {}): KortixAppGuard {
  const secret = options.secret ?? envSecret();
  const ttl = options.groupCacheTtlMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const fetchImpl =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const cache = new Map<string, CacheEntry>();

  /**
   * Groups for a viewer on the sign-in path.
   *
   * A failure yields an EMPTY list, never a throw and never a wildcard: the
   * viewer stays authenticated, and anything group-gated denies. Treating an
   * unreadable membership list as "no restriction" is how a transient 500
   * becomes an open door.
   */
  async function fetchGroups(accountId: string, userId: string, token: string): Promise<string[]> {
    const key = `${accountId}:${userId}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.groupIds;
    if (!options.backendUrl) return [];

    try {
      const base = options.backendUrl.replace(/\/+$/, '');
      const res = await fetchImpl(
        `${base}/accounts/${encodeURIComponent(accountId)}/iam/members/${encodeURIComponent(userId)}/groups`,
        { headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return [];
      const body = (await res.json()) as { groups?: Array<{ group_id?: string; groupId?: string }> };
      const ids = (body.groups ?? [])
        .map((g) => g.group_id ?? g.groupId)
        .filter((id): id is string => typeof id === 'string');
      cache.set(key, { groupIds: ids, at: now() });
      return ids;
    } catch {
      return [];
    }
  }

  async function viewer(request: Request): Promise<KortixGuardedViewer | null> {
    // The gate first: one HMAC, no network, and it already carries groups. It is
    // also the only source that proves the viewer for THIS App specifically.
    const gated = await readAppViewer(request, secret ? { secret } : undefined);
    if (gated) {
      return {
        userId: gated.userId,
        email: gated.email,
        groupIds: gated.groupIds ?? [],
        accountId: gated.accountId,
        source: 'app-gate',
        token: gated.token,
      };
    }

    if (!options.auth) return null;
    const signedIn = await options.auth.viewer(request).catch(() => null);
    if (!signedIn) return null;

    const accountId = signedIn.accounts?.[0]?.account_id ?? '';
    return {
      userId: signedIn.userId,
      email: signedIn.email ?? null,
      groupIds: accountId ? await fetchGroups(accountId, signedIn.userId, signedIn.token) : [],
      accountId,
      source: 'kortix-sign-in',
      token: signedIn.token,
    };
  }

  function identityConfigured(): boolean {
    return Boolean(secret) || Boolean(options.auth);
  }

  /** 404, not 403 — "this exists and is not yours" is itself information. */
  function refuse(): Response {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  return {
    viewer,
    identityConfigured,

    async requireViewer(request) {
      const found = await viewer(request);
      if (found) return { viewer: found };
      const signIn = options.auth?.signInUrl?.(new URL(request.url).pathname);
      return {
        response: signIn
          ? Response.redirect(new URL(signIn, request.url).toString(), 302)
          : refuse(),
      };
    },

    async requireGroup(request, groupIds) {
      const found = await viewer(request);
      if (!found) {
        const signIn = options.auth?.signInUrl?.(new URL(request.url).pathname);
        return {
          response: signIn
            ? Response.redirect(new URL(signIn, request.url).toString(), 302)
            : refuse(),
        };
      }
      // An empty required-group list reads as "no restriction" to a careless
      // caller. It means the opposite here, so a config bug that produces `[]`
      // closes the resource instead of opening it to everyone.
      if (groupIds.length === 0) return { response: refuse() };
      const allowed = groupIds.some((id) => found.groupIds.includes(id));
      return allowed ? { viewer: found } : { response: refuse() };
    },
  };
}
