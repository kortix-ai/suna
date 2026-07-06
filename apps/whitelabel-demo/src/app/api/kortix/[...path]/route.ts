/**
 * The wrapper-mode BFF proxy: `${origin}/api/kortix/*` → `${KORTIX_UPSTREAM}/*`.
 *
 * This is the one place in the app that talks to Kortix with a raw `fetch`
 * instead of `@kortix/sdk` — by design (see AGENTS.md: transport code inside
 * `src/server/` + `app/api/` is exempt from the "SDK only" rule; it's what the
 * SDK itself talks to). Everything else in the app still goes through
 * `@kortix/sdk`, just pointed at THIS route as its `backendUrl` in wrapper
 * mode (`src/lib/kortix.ts#configureWrapperMode`).
 *
 * Order of operations, each one able to short-circuit with an error response:
 *   1. `KORTIX_API_KEY` must be configured (wrapper mode must actually be on).
 *   2. The caller must carry a valid Lumen app session (bearer or cookie).
 *   3. Per-user rate limit.
 *   4. `evaluatePolicy` — the explicit allow/deny table in `server/policy.ts`.
 *   5. Forward to upstream with the Kortix API key substituted in for
 *      Authorization — the end user's own session token NEVER reaches Kortix.
 *
 * Streaming: the response body is passed straight through
 * (`new Response(upstreamRes.body, …)`) for everything except the two routes
 * that need a tiny JSON rewrite (`filterProjectsList`, `recordProvisionOwner`)
 * — those bodies are small, one-shot JSON, never SSE/long-lived, so buffering
 * them is safe. Nothing else is buffered: this is what keeps the SSE event
 * stream and long-lived sandbox-runtime GETs working.
 */

import { getRequestSession } from '@/server/auth';
import { evaluatePolicy } from '@/server/policy';
import { consumeRateLimit } from '@/server/rate-limit';
import { addOwnedProject, isOwner, listOwnedProjects } from '@/server/users';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(/\/+$/, '');
}

function jsonError(status: number, error: string, extraHeaders?: HeadersInit) {
  return Response.json({ error }, { status, headers: extraHeaders });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'Wrapper mode is not enabled on this server (KORTIX_API_KEY is unset).');
  }

  const session = getRequestSession(req);
  if (!session) return jsonError(401, 'Not authenticated');

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) {
    return jsonError(429, 'Rate limit exceeded', {
      'Retry-After': String(Math.ceil((limited.retryAfterMs ?? 1000) / 1000)),
    });
  }

  const { path = [] } = await ctx.params;
  const upstreamPath = path.join('/');

  const policy = evaluatePolicy(req.method, upstreamPath, (projectId) =>
    isOwner(session.userId, projectId),
  );
  if (!policy.allow) return jsonError(policy.status, policy.reason);

  const url = new URL(req.url);
  const upstreamUrl = `${upstreamBase()}/${upstreamPath}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('cookie'); // the app session cookie is ours, never upstream's
  headers.set('authorization', `Bearer ${apiKey}`);

  // Buffer the request body instead of streaming it (`body: req.body,
  // duplex: 'half'`): a streamed body has no Content-Length, so undici sends
  // it with `Transfer-Encoding: chunked` — and the sandbox proxy's inner load
  // balancer (AWS ALB fronting the Daytona runtime) rejects chunked request
  // bodies with a bare HTML 400. Every request body on this surface is small
  // JSON (or a modest FormData upload), so buffering is safe; RESPONSE bodies
  // below still stream untouched, which is what SSE and long-lived runtime
  // GETs actually need.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: 'manual',
    ...(hasBody ? { body: await req.arrayBuffer() } : {}),
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, init);
  } catch {
    return jsonError(502, 'Upstream request failed');
  }

  // Buffered post-processing — only for the two ownership-tracking routes.
  if (policy.filterProjectsList || policy.recordProvisionOwner) {
    const text = await upstreamRes.text();
    let body: unknown;
    let isJson = true;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      isJson = false;
    }

    if (!isJson) {
      // Upstream didn't return JSON (e.g. an error page) — pass the raw text
      // through unchanged rather than risk mangling it.
      return new Response(text, {
        status: upstreamRes.status,
        headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'text/plain' },
      });
    }

    if (policy.recordProvisionOwner && upstreamRes.ok) {
      const projectId = (body as { project_id?: string } | null)?.project_id;
      if (projectId) addOwnedProject(session.userId, projectId);
    }

    if (policy.filterProjectsList && Array.isArray(body)) {
      const owned = new Set(listOwnedProjects(session.userId));
      body = body.filter((item) => owned.has((item as { project_id?: string })?.project_id ?? ''));
    }

    return Response.json(body, { status: upstreamRes.status });
  }

  // Everything else — stream straight through, unbuffered.
  const outHeaders = new Headers(upstreamRes.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  outHeaders.delete('set-cookie'); // upstream's own cookies are meaningless on our origin

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: outHeaders });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
