/**
 * The wrapper-mode BFF proxy: `${origin}/api/kortix/*` → `${KORTIX_UPSTREAM}/*`.
 *
 * The SDK owns the upstream HTTP transport. This route owns wrapper
 * authentication, authorization policy, and ownership bookkeeping.
 *
 * Order of operations, each one able to short-circuit with an error response:
 *   1. `KORTIX_API_KEY` must be configured (wrapper mode must actually be on).
 *   2. The caller must carry a valid Lumen app session (bearer or cookie).
 *   3. Per-user rate limit.
 *   4. `evaluatePolicy` — the explicit allow/deny table in `server/policy.ts`.
 *   5. Forward to upstream with the Kortix API key substituted in for
 *      Authorization — the end user's own session token NEVER reaches Kortix.
 *
 * Streaming: the response body passes straight through
 * (`new Response(upstreamRes.body, …)`) for everything except the two routes
 * that need a tiny JSON rewrite (`filterProjectsList`, `recordProvisionOwner`)
 * — those bodies are small one-shot JSON responses. Buffering them is safe.
 * Nothing else is buffered. Long-lived session streams remain active.
 */

import { getRequestSession } from '@/server/auth';
import { buildUpstreamPath } from '@/server/upstream-path';
import { evaluatePolicy } from '@/server/policy';
import { consumeRateLimit } from '@/server/rate-limit';
import {
  recordRuntimeProject,
  resolveRuntimeProject,
} from '@/server/runtime-access';
import { addOwnedProject, isOwner, listOwnedProjects } from '@/server/users';
import { forwardKortixRequest } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(
    /\/+$/,
    '',
  );
}

function jsonError(status: number, error: string, extraHeaders?: HeadersInit) {
  return Response.json({ error }, { status, headers: extraHeaders });
}

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    return jsonError(
      500,
      'Wrapper mode is not enabled on this server (KORTIX_API_KEY is unset).',
    );
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
  // Next hands back DECODED segments, so `%2F..%2F` arrives as a real `..` and a
  // naive join lets the POLICY and the UPSTREAM disagree about which project is
  // being addressed. Refuse before anything reads the path.
  const built = buildUpstreamPath(path);
  if (!built.ok) return jsonError(400, `Invalid request path: ${built.reason}`);
  const upstreamPath = built.path;

  const policy = evaluatePolicy(
    req.method,
    upstreamPath,
    (workspaceId) => isOwner(session.userId, workspaceId),
    resolveRuntimeProject,
  );
  if (!policy.allow) return jsonError(policy.status, policy.reason);

  const upstreamUrl = `${upstreamBase()}/${upstreamPath}${new URL(req.url).search}`;

  const upstreamRes = await forwardKortixRequest({
    request: req,
    upstreamUrl,
    token: apiKey,
  });

  // Buffer only responses that update or filter wrapper ownership state.
  if (
    policy.filterProjectsList ||
    policy.recordProvisionOwner ||
    policy.recordRuntimeProjectId
  ) {
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
        headers: {
          'content-type':
            upstreamRes.headers.get('content-type') ?? 'text/plain',
        },
      });
    }

    if (policy.recordProvisionOwner && upstreamRes.ok) {
      const workspaceId = (body as { project_id?: string } | null)?.project_id;
      if (workspaceId) addOwnedProject(session.userId, workspaceId);
    }

    if (policy.recordRuntimeProjectId && upstreamRes.ok) {
      const runtimeId = (body as { sandbox?: { external_id?: string } } | null)
        ?.sandbox?.external_id;
      if (runtimeId)
        recordRuntimeProject(runtimeId, policy.recordRuntimeProjectId);
    }

    if (policy.filterProjectsList && Array.isArray(body)) {
      const owned = new Set(listOwnedProjects(session.userId));
      body = body.filter((item) =>
        owned.has((item as { project_id?: string })?.project_id ?? ''),
      );
    }

    return Response.json(body, { status: upstreamRes.status });
  }

  // The SDK returns a sanitized, streaming response.
  return upstreamRes;
}

export {
  handle as DELETE,
  handle as GET,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
