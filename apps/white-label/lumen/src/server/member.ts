/**
 * Who is calling, for which workspace, with which Kortix credential.
 *
 * The browser sends `Authorization: Bearer ws.<workspaceId>` (not a secret)
 * and the Better Auth cookie (identity). Convex checks org membership and
 * returns the member's project-scoped Kortix token for that workspace. This
 * server never holds the operator credential.
 */

import { api } from '@convex/_generated/api';
import { createScopedKortix } from '@kortix/sdk/server';
import { fetchAuthAction, getToken } from './auth-server';
import { upstreamBase } from './upstream-path';

export interface Member {
  workspaceId: string;
  /** The workspace's Kortix project, resolved by Convex. Never taken from the client. */
  projectId: string;
  /** The member's project-scoped Kortix token. Never sent to the browser. */
  token: string;
  /** Better Auth ids, for tagging what the member creates. */
  userId: string;
  orgId: string;
}

// Convex ids: lowercase base32, 32 characters today.
const WORKSPACE_BEARER = /^Bearer ws\.([a-z0-9]{16,64})$/;
// One membership check per (user JWT, workspace) per minute. A removed member
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
  const workspaceId = WORKSPACE_BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!workspaceId) return failure(400, 'A workspace bearer (ws.<id>) is required');
  const jwt = await getToken();
  if (!jwt) return failure(401, 'Not authenticated');

  const key = `${jwt}:${workspaceId}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return { member: hit.member };

  let pending = inflight.get(key);
  if (!pending) {
    pending = mintMember(key, workspaceId).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const result = await pending;
  // A shared error Response body can be read once; hand each caller its own copy.
  return 'error' in result ? { error: result.error.clone() } : result;
}

async function mintMember(key: string, workspaceId: string): Promise<{ member: Member } | { error: Response }> {
  const proxySecret = process.env.LUMEN_PROXY_SECRET;
  if (!proxySecret) return failure(500, 'LUMEN_PROXY_SECRET is not set');
  try {
    const minted = await fetchAuthAction(api.kortix.memberToken, {
      workspaceId,
      proxySecret,
    });
    const member = { workspaceId, ...minted };
    const now = Date.now();
    if (cache.size > 1000) for (const [k, v] of cache) if (v.until < now) cache.delete(k);
    cache.set(key, { member, until: Math.min(now + MEMBER_CACHE_MS, minted.expiresAt - 60_000) });
    return { member };
  } catch (err) {
    const status = convexStatus(err);
    return failure(status, status === 409 ? 'The workspace is still being set up' : 'Workspace access denied');
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
 * The member plus a check that the client's project id is the workspace's
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
