/**
 * The same-origin proxy: `${origin}/api/kortix/*` → `${KORTIX_UPSTREAM}/*`.
 *
 * 1. `resolveMember` turns the Better Auth cookie + `Bearer ws.<workspaceId>`
 *    into the member's project-scoped Kortix token (Convex checks membership).
 * 2. The path must be literal segments (`buildUpstreamPath`).
 * 3. Account reads the session UI makes are answered here (`localAnswer`):
 *    the member's identity is Lumen's, not the operator's Kortix user.
 * 4. Anything outside the session surface is refused (`blockedReason`).
 * 5. `forwardKortixRequest` forwards with the member token and streams the
 *    response (REST, SSE, runtime routes alike).
 * 6. A new session gets Lumen's tags and becomes a Lumen thread
 *    (`createSession`), whichever screen created it. A session update keeps
 *    those tags (`patchSession`): a member cannot forge or erase them. A
 *    session delete needs the thread's creator or an org admin, and drops the
 *    thread record (`deleteSession`).
 *
 * Kortix enforces the project boundary: the member token is rejected on
 * every other project, on `GET /projects` and on most account routes. It is
 * NOT rejected on `GET /accounts/me` or on project member lists, and it
 * carries its minter's role on the project (owner). That is why the proxy
 * allowlists paths instead of trusting Kortix's scope check alone.
 */

import { fetchAuthMutation } from '@/server/auth-server';
import { type Member, memberKortix, resolveMember } from '@/server/member';
import { SESSION_CREATE, SESSION_ONE, blockedReason, localAnswer } from '@/server/proxy-policy';
import { buildUpstreamPath, upstreamBase } from '@/server/upstream-path';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { tagSessionCreate, tagSessionPatch } from '@convex/tags';
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

  const search = new URL(req.url).search;
  const body = req.method === 'POST' && built.path.startsWith('accounts/') ? await req.json().catch(() => null) : null;
  const local = localAnswer(req.method, built.path, new URLSearchParams(search), body, resolved.member);
  if (local) return local;

  const blocked = blockedReason(req.method, built.path, new URLSearchParams(search));
  if (blocked) return Response.json({ error: blocked }, { status: 403 });

  const upstreamUrl = `${upstreamBase()}/${built.path}${search}`;
  if (req.method === 'POST' && SESSION_CREATE.test(built.path)) {
    return createSession(req, upstreamUrl, resolved.member);
  }
  const one = SESSION_ONE.exec(built.path);
  if (one && req.method === 'DELETE') return deleteSession(req, upstreamUrl, resolved.member, one[2]);
  if (one && req.method !== 'GET' && req.method !== 'HEAD') {
    return patchSession(req, upstreamUrl, resolved.member, one[1], one[2]);
  }
  return forwardKortixRequest({ request: req, upstreamUrl, token: resolved.member.token });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function forwardJson(req: NextRequest, upstreamUrl: string, member: Member, body: unknown) {
  return forwardKortixRequest({
    request: new Request(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(body) }),
    upstreamUrl,
    token: member.token,
  });
}

async function createSession(req: NextRequest, upstreamUrl: string, member: Member) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: 'Invalid request body' }, { status: 400 });
  const res = await forwardJson(req, upstreamUrl, member, tagSessionCreate(body, member, member.workspaceId));
  if (!res.ok) return res;
  const text = await res.text();
  // The session exists now. A failed thread record must not turn it into a
  // 500: a client retry would create a second session. The record is retried
  // (threads.recordFromProxy is idempotent per session); after the last
  // attempt the session keeps its Lumen labels and the failure is logged.
  const session = JSON.parse(text) as { session_id?: string; name?: string | null };
  for (let attempt = 1; session.session_id && attempt <= 3; attempt++) {
    try {
      await fetchAuthMutation(api.threads.recordFromProxy, {
        workspaceId: member.workspaceId as Id<'workspaces'>,
        kortixSessionId: session.session_id,
        title: session.name ?? (typeof body.name === 'string' ? body.name : ''),
        proxySecret: process.env.LUMEN_PROXY_SECRET ?? '',
      });
      break;
    } catch (err) {
      if (attempt === 3) process.stderr.write(`lumen: session ${session.session_id} not recorded as a thread: ${String(err)}\n`);
      else await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  return new Response(text, { status: res.status, headers: res.headers });
}

function deleteCheck(member: Member, sessionId: string, remove: boolean) {
  return fetchAuthMutation(api.threads.deleteFromProxy, {
    workspaceId: member.workspaceId as Id<'workspaces'>,
    kortixSessionId: sessionId,
    proxySecret: process.env.LUMEN_PROXY_SECRET ?? '',
    remove,
  });
}

/** Convex errors carry their status as a `403:` / `404:` prefix. */
function convexStatus(err: unknown): number {
  const m = /\b(40[134])\b:/.exec(String(err));
  return m ? Number(m[1]) : 500;
}

async function deleteSession(req: NextRequest, upstreamUrl: string, member: Member, sessionId: string) {
  try {
    await deleteCheck(member, sessionId, false);
  } catch (err) {
    const status = convexStatus(err);
    return Response.json({ error: status === 403 ? "Only the thread's creator or an admin may delete it" : 'Not found' }, { status });
  }
  const res = await forwardKortixRequest({ request: req, upstreamUrl, token: member.token });
  if (!res.ok && res.status !== 404) return res;
  // The session is gone on Kortix. A failed record delete leaves a thread row
  // that points at a deleted session, and is logged.
  await deleteCheck(member, sessionId, true).catch((err) =>
    process.stderr.write(`lumen: thread for session ${sessionId} not removed: ${String(err)}\n`),
  );
  return res;
}

async function patchSession(req: NextRequest, upstreamUrl: string, member: Member, projectId: string, sessionId: string) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: 'Invalid request body' }, { status: 400 });
  let current: readonly string[] = [];
  if ('labels' in body) {
    // Kortix replaces the label list, so the current Lumen labels come from the session itself.
    const session = await memberKortix(member).session(projectId, sessionId).get().catch(() => null);
    if (!session) return Response.json({ error: 'Not found' }, { status: 404 });
    current = session.labels ?? [];
  }
  return forwardJson(req, upstreamUrl, member, tagSessionPatch(body, current));
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
