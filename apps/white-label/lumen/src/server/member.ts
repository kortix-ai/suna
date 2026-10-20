/**
 * Who is calling, for which matter, with which Kortix credential.
 *
 * The browser sends `Authorization: Bearer matter.<matterId>` (not a secret)
 * and the Better Auth cookie (identity). Convex checks firm membership and
 * matter access (a restricted matter is refused to a lawyer who is not on it)
 * and returns the member's project-scoped Kortix token for the firm. This
 * server never holds the operator credential.
 */

import { api } from '@convex/_generated/api';
import { createScopedKortix } from '@kortix/sdk/server';
import { fetchAuthAction, fetchAuthQuery, getToken } from './auth-server';
import { upstreamBase } from './upstream-path';

export interface Member {
  matterId: string;
  firmId: string;
  /** The firm's Kortix project, resolved by Convex. Never taken from the client. */
  projectId: string;
  /** The member's project-scoped Kortix token. Never sent to the browser. */
  token: string;
  /** Better Auth ids, for tagging what the member creates. */
  userId: string;
  orgId: string;
}

// Convex ids: lowercase base32, 32 characters today.
const MATTER_BEARER = /^Bearer matter\.([a-z0-9]{16,64})$/;
// One access check per (user JWT, matter) per minute. A removed member
// loses access within MEMBER_CACHE_MS.
const MEMBER_CACHE_MS = 60_000;
// replica-local: a cache miss costs one Convex action, the token itself is stored in Convex.
const cache = new Map<string, { member: Member; until: number }>();
// replica-local: a page load fires ~10 calls at once; they share one Convex call instead of minting ~10 tokens.
const inflight = new Map<string, Promise<{ member: Member } | { error: Response }>>();

function failure(status: number, error: string) {
  return { error: Response.json({ error }, { status }) };
}

/** Status code from a Convex error message such as "403: not a member of this organization". */
function convexStatus(err: unknown): number {
  const m = /\b(4\d\d|5\d\d): /.exec(String((err as Error)?.message ?? ''));
  return m ? Number(m[1]) : 502;
}

export async function resolveMember(req: Request): Promise<{ member: Member } | { error: Response }> {
  const matterId = MATTER_BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!matterId) return failure(400, 'A matter bearer (matter.<id>) is required');
  const jwt = await getToken();
  if (!jwt) return failure(401, 'Not authenticated');

  const key = `${jwt}:${matterId}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return { member: hit.member };

  let pending = inflight.get(key);
  if (!pending) {
    pending = mintMember(key, matterId).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const result = await pending;
  // A shared error Response body can be read once; hand each caller its own copy.
  return 'error' in result ? { error: result.error.clone() } : result;
}

async function mintMember(key: string, matterId: string): Promise<{ member: Member } | { error: Response }> {
  const proxySecret = process.env.LUMEN_PROXY_SECRET;
  if (!proxySecret) return failure(500, 'LUMEN_PROXY_SECRET is not set');
  try {
    const minted = await fetchAuthAction(api.kortix.memberToken, { matterId, proxySecret });
    const member = { matterId, ...minted };
    const now = Date.now();
    if (cache.size > 1000) for (const [k, v] of cache) if (v.until < now) cache.delete(k);
    cache.set(key, { member, until: Math.min(now + MEMBER_CACHE_MS, minted.expiresAt - 60_000) });
    return { member };
  } catch (err) {
    const status = convexStatus(err);
    return failure(status, status === 409 ? 'The firm workspace is still being set up' : 'Matter access denied');
  }
}

/** A server SDK client acting as the member (project scope only). */
export function memberKortix(member: Member) {
  return createScopedKortix({ backendUrl: upstreamBase(), getToken: async () => member.token });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a session id before it reaches an SDK path. */
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * The member plus a check that the client's project id is the firm's
 * project. The id from the client is never used to pick a credential.
 */
export async function resolveMemberFor(
  req: Request,
  projectId: string,
): Promise<{ member: Member } | { error: Response }> {
  const resolved = await resolveMember(req);
  if ('error' in resolved) return resolved;
  if (projectId !== resolved.member.projectId) {
    return { error: Response.json({ error: 'Not found' }, { status: 404 }) };
  }
  return resolved;
}

const MATTER_CACHE_MS = 60_000;
// replica-local: a cache miss costs one Convex query; the thread row in Convex is the source of truth.
const sessionMatter = new Map<string, number>();

/**
 * A session belongs to the matter in the bearer. The member token reaches
 * every session of the firm's project, so without this a lawyer with access
 * to one matter could read, prompt, re-model or preview a thread of another
 * (restricted) matter. Every route that takes a session id calls it.
 */
export async function sessionInMatter(member: Member, kortixSessionId: string): Promise<boolean> {
  const key = `${member.userId}:${member.matterId}:${kortixSessionId}`;
  if ((sessionMatter.get(key) ?? 0) > Date.now()) return true;
  const row = await fetchAuthQuery(api.threads.bySession, { kortixSessionId }).catch(() => null);
  if (row?.matterId !== member.matterId) return false;
  // Only a yes is cached: a session recorded a moment later is not refused for a minute.
  if (sessionMatter.size > 5000) sessionMatter.clear();
  sessionMatter.set(key, Date.now() + MATTER_CACHE_MS);
  return true;
}

/** resolveMemberFor plus sessionInMatter: 404 for a session of another matter, as the proxy answers. */
export async function resolveMemberForSession(
  req: Request,
  projectId: string,
  sessionId: string,
): Promise<{ member: Member } | { error: Response }> {
  const resolved = await resolveMemberFor(req, projectId);
  if ('error' in resolved) return resolved;
  if (!(await sessionInMatter(resolved.member, sessionId))) {
    return { error: Response.json({ error: 'Not found' }, { status: 404 }) };
  }
  return resolved;
}
