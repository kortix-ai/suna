/**
 * The same-origin proxy: `${origin}/api/kortix/*` → `${KORTIX_UPSTREAM}/*`.
 *
 * 1. `resolveMember` turns the Better Auth cookie + `Bearer ws.<workspaceId>`
 *    into the member's project-scoped Kortix token (Convex checks membership).
 * 2. The path must be literal segments (`buildUpstreamPath`).
 * 3. Writes a Lumen member must not make are refused (`blockedReason`).
 * 4. `forwardKortixRequest` forwards with the member token and streams the
 *    response (REST, SSE, runtime routes alike).
 * 5. A new session gets Lumen's tags and becomes a Lumen thread
 *    (`createSession`), whichever screen created it.
 *
 * Kortix enforces the tenant boundary: the member token is rejected on every
 * other project, on `GET /projects` and on account routes. The deny list
 * exists because a project-scoped token carries its minter's role on that
 * project (owner), which is more than a Lumen member gets.
 */

import { fetchAuthMutation } from '@/server/auth-server';
import { type Member, resolveMember } from '@/server/member';
import { SESSION_CREATE, blockedReason } from '@/server/proxy-policy';
import { buildUpstreamPath, upstreamBase } from '@/server/upstream-path';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { lumenSessionTags } from '@convex/tags';
import { forwardKortixRequest } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const resolved = await resolveMember(req);
  if ('error' in resolved) return resolved.error;

  const { path = [] } = await ctx.params;
  const built = buildUpstreamPath(path);
  if (!built.ok) return Response.json({ error: `Invalid request path: ${built.reason}` }, { status: 400 });

  const blocked = blockedReason(req.method, built.path);
  if (blocked) return Response.json({ error: blocked }, { status: 403 });

  const upstreamUrl = `${upstreamBase()}/${built.path}${new URL(req.url).search}`;
  if (req.method === 'POST' && SESSION_CREATE.test(built.path)) {
    return createSession(req, upstreamUrl, resolved.member);
  }
  return forwardKortixRequest({ request: req, upstreamUrl, token: resolved.member.token });
}

async function createSession(req: NextRequest, upstreamUrl: string, member: Member) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const tags = lumenSessionTags(member, member.workspaceId);
  const labels = Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string') : [];
  const tagged = {
    ...body,
    labels: [...new Set([...labels, ...tags.labels])].slice(0, 20),
    metadata: { ...(body.metadata as Record<string, unknown> | undefined), ...tags.metadata },
  };
  const res = await forwardKortixRequest({
    request: new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(tagged) }),
    upstreamUrl,
    token: member.token,
  });
  if (!res.ok) return res;
  const text = await res.text();
  const session = JSON.parse(text) as { session_id?: string; name?: string | null };
  if (session.session_id) {
    await fetchAuthMutation(api.threads.recordFromProxy, {
      workspaceId: member.workspaceId as Id<'workspaces'>,
      kortixSessionId: session.session_id,
      title: session.name ?? (typeof body.name === 'string' ? body.name : ''),
      proxySecret: process.env.LUMEN_PROXY_SECRET ?? '',
    });
  }
  return new Response(text, { status: res.status, headers: res.headers });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
