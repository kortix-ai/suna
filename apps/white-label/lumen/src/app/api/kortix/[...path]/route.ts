/**
 * The same-origin proxy: `${origin}/api/kortix/*` → `${KORTIX_UPSTREAM}/*`.
 *
 * 1. `resolveMember` turns the Better Auth cookie + `Bearer matter.<matterId>`
 *    into the firm's Kortix credential and agent (Convex checks matter access).
 * 2. The path must be literal segments (`buildUpstreamPath`).
 * 3. Account reads the session UI makes are answered here (`localAnswer`):
 *    the member's identity is Lumen's, not the operator's Kortix user.
 * 4. Anything outside the session surface is refused (`blockedReason`).
 * 5. `forwardKortixRequest` forwards with the member token and streams the
 *    response (REST, SSE, runtime routes alike). Only the request headers
 *    Kortix needs leave Lumen (`forwardedHeaders`), only the response headers
 *    a browser needs come back (`browserHeaders`), and responses that name
 *    the operator's Kortix user lose those names (`redactIdentity`).
 * 6. A new session runs on the firm's agent, gets Lumen's tags and becomes a
 *    Lumen thread (`createSession`), whichever screen created it. A prompt
 *    carries no agent (`memberPromptBody`). A session update keeps
 *    those tags (`patchSession`): a member cannot forge or erase them. A
 *    session delete needs the thread's creator or an firm admin, and drops the
 *    thread record (`deleteSession`).
 *
 * 7. A session route needs a session of the bearer's matter (`sessionInMatter`),
 *    a runtime route a sandbox of one (`sandboxInMatter`).
 *
 * Kortix enforces the firm boundary: one project serves every firm, and the
 * firm's service account (project role `member`) reaches only the sessions it
 * created and cannot change the project. It can still start a session on any
 * agent of the project, read the project detail (which lists every firm's
 * agent) and its own `accounts/me`. That is why the proxy pins the agent,
 * scopes the detail and allowlists paths instead of trusting Kortix alone.
 */

import { fetchAuthMutation } from '@/server/auth-server';
import { type Member, memberKortix, resolveMember, sandboxInMatter, sessionInMatter } from '@/server/member';
import {
  PROMPT_WRITE,
  SESSION_CREATE,
  SESSION_ONE,
  blockedReason,
  browserHeaders,
  forwardedHeaders,
  localAnswer,
  memberPromptBody,
  memberSessionCreateBody,
  redactError,
  redactIdentity,
  redactsIdentity,
  runtimeSandbox,
} from '@/server/proxy-policy';
import { buildUpstreamPath, upstreamBase } from '@/server/upstream-path';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { tagSessionCreate, tagSessionPatch } from '@convex/tags';
import { forwardKortixRequest } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await ctx.params;
  const built = buildUpstreamPath(path);
  const { res, agent } = await route(req, built);
  const out = !res.ok ? await redactedError(res) : built.ok && redactsIdentity(built.path) ? await redacted(res, built.path, agent) : res;
  // One exit for every path: only the allowlisted response headers reach the browser.
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers: browserHeaders(out.headers) });
}

async function route(req: NextRequest, built: ReturnType<typeof buildUpstreamPath>): Promise<{ res: Response; agent: string }> {
  const resolved = await resolveMember(req);
  if ('error' in resolved) return { res: resolved.error, agent: '' };
  return { res: await routeAs(req, built, resolved.member), agent: resolved.member.agent };
}

async function routeAs(req: NextRequest, built: ReturnType<typeof buildUpstreamPath>, member: Member): Promise<Response> {
  if (!built.ok) return Response.json({ error: `Invalid request path: ${built.reason}` }, { status: 400 });

  const search = new URL(req.url).search;
  const body = req.method === 'POST' && built.path.startsWith('accounts/') ? await req.json().catch(() => null) : null;
  const local = localAnswer(req.method, built.path, new URLSearchParams(search), body, member);
  if (local) return local;

  const blocked = blockedReason(req.method, built.path, new URLSearchParams(search));
  if (blocked) return Response.json({ error: blocked }, { status: 403 });

  const sid = SESSION_PATH.exec(built.path)?.[1];
  if (sid && !(await sessionInMatter(member, sid))) return Response.json({ error: 'Not found' }, { status: 404 });
  const sandbox = runtimeSandbox(built.path);
  if (sandbox && !(await sandboxInMatter(member, sandbox))) return Response.json({ error: 'Not found' }, { status: 404 });

  const upstreamUrl = `${upstreamBase()}/${built.path}${search}`;
  if (req.method === 'POST' && SESSION_CREATE.test(built.path)) {
    return createSession(req, upstreamUrl, member);
  }
  if ((req.method === 'POST' || req.method === 'PATCH') && PROMPT_WRITE.test(built.path)) {
    const prompt = await readJson(req);
    if (!prompt) return Response.json({ error: 'Invalid request body' }, { status: 400 });
    return forwardJson(req, upstreamUrl, member, memberPromptBody(prompt));
  }
  const one = SESSION_ONE.exec(built.path);
  if (one && req.method === 'DELETE') return deleteSession(req, upstreamUrl, member, one[2]);
  if (one && req.method !== 'GET' && req.method !== 'HEAD') {
    return patchSession(req, upstreamUrl, member, one[1], one[2]);
  }
  return forwardKortixRequest({ request: await outbound(req), upstreamUrl, token: member.token });
}

// Every session route: `projects/<pid>/sessions/<sid>` and below.
const SESSION_PATH = /^projects\/[^/]+\/sessions\/([0-9a-f-]{36})(?:\/|$)/i;
/** The request Kortix receives: the browser's method and body, only the allowed headers. */
async function outbound(req: NextRequest, body?: BodyInit): Promise<Request> {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(req.url, {
    method: req.method,
    headers: forwardedHeaders(req.headers),
    body: hasBody ? (body ?? (await req.arrayBuffer())) : undefined,
  });
}

/** A non-2xx body names no platform and carries no diagnostics (`redactError`). Streams and non-JSON pass. */
async function redactedError(res: Response): Promise<Response> {
  if (!res.headers.get('content-type')?.includes('json')) return res;
  const text = await res.text();
  try {
    return new Response(JSON.stringify(redactError(JSON.parse(text))), { status: res.status, headers: res.headers });
  } catch {
    return new Response(text, { status: res.status, headers: res.headers });
  }
}

async function redacted(res: Response, path: string, agent: string): Promise<Response> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, { status: res.status, headers: res.headers });
  }
  return new Response(JSON.stringify(redactIdentity(path, body, agent)), { status: res.status, headers: res.headers });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function forwardJson(req: NextRequest, upstreamUrl: string, member: Member, body: unknown) {
  return outbound(req, JSON.stringify(body)).then((request) =>
    forwardKortixRequest({ request, upstreamUrl, token: member.token }),
  );
}

async function createSession(req: NextRequest, upstreamUrl: string, member: Member) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: 'Invalid request body' }, { status: 400 });
  const res = await forwardJson(req, upstreamUrl, member, tagSessionCreate(memberSessionCreateBody(body, member.agent), member));
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
        matterId: member.matterId as Id<'matters'>,
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
    matterId: member.matterId as Id<'matters'>,
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
  const res = await forwardKortixRequest({ request: await outbound(req), upstreamUrl, token: member.token });
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
  const res = await forwardJson(req, upstreamUrl, member, tagSessionPatch(body, current));
  if (res.ok && typeof body.name === 'string') {
    // The thread list reads Lumen's own title. A failed update leaves the old title and is logged.
    await fetchAuthMutation(api.threads.renameFromProxy, {
      matterId: member.matterId as Id<'matters'>,
      kortixSessionId: sessionId,
      title: body.name,
      proxySecret: process.env.LUMEN_PROXY_SECRET ?? '',
    }).catch((err) => process.stderr.write(`lumen: thread for session ${sessionId} not renamed: ${String(err)}\n`));
  }
  return res;
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
