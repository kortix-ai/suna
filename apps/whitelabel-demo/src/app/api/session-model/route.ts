/**
 * Provider-neutral session model control.
 *
 * The wire field is named after the runtime, which reference-app CLIENT code
 * must not know about (see scripts/sdk-boundary.mjs `provider-term`). This route
 * is the translation seam: the browser speaks `{ model }`, and the runtime's
 * field name stays server-side.
 *
 * GET  → the session's current model.
 * PUT  → change it; `applied_live` reports whether a running session took it now
 *        or whether it applies at next start. Those are different outcomes and
 *        the client must be able to say which.
 */
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isOwner, isValidProjectId } from '@/server/users';
import { createScopedKortix } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function upstreamBase(): string {
  // KORTIX_UPSTREAM first, like the proxy and every other server route. Reading
  // only KORTIX_API_URL sent the model control to the PUBLIC api on any
  // deployment that configures the documented variable, so every change 404'd.
  return (
    process.env.KORTIX_UPSTREAM ??
    process.env.KORTIX_API_URL ??
    'https://api.kortix.com/v1'
  ).replace(/\/+$/, '');
}

async function scoped(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) return { error: Response.json({ error: 'Wrapper mode is off' }, { status: 500 }) };

  const session = getRequestSession(req);
  if (!session) return { error: Response.json({ error: 'Not authenticated' }, { status: 401 }) };

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return { error: Response.json({ error: 'Rate limited' }, { status: 429 }) };

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const sessionId = url.searchParams.get('sessionId') ?? '';
  // Validate before interpolating into an upstream path, and check ownership
  // before touching anything — both are house rules for this boundary.
  if (!isValidProjectId(projectId) || !UUID.test(sessionId)) {
    return { error: Response.json({ error: 'Invalid identifiers' }, { status: 400 }) };
  }
  if (!isOwner(session.userId, projectId)) {
    return { error: Response.json({ error: 'Not found' }, { status: 404 }) };
  }

  return {
    kortix: createScopedKortix({ backendUrl: upstreamBase(), getToken: async () => apiKey }),
    projectId,
    sessionId,
  };
}

export async function GET(req: NextRequest) {
  const ctx = await scoped(req);
  if ('error' in ctx) return ctx.error;

  try {
    const session = await ctx.kortix.session(ctx.projectId, ctx.sessionId).get();
    const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
    const model = metadata.opencode_model;
    return Response.json({ model: typeof model === 'string' ? model : null });
  } catch {
    return Response.json({ model: null });
  }
}

export async function PUT(req: NextRequest) {
  const ctx = await scoped(req);
  if ('error' in ctx) return ctx.error;

  let model = '';
  try {
    const body = (await req.json()) as { model?: unknown };
    model = typeof body?.model === 'string' ? body.model.trim() : '';
  } catch {
    model = '';
  }
  if (!model) return Response.json({ error: 'model is required' }, { status: 400 });

  try {
    const result = await ctx.kortix.session(ctx.projectId, ctx.sessionId).changeModel(model);
    // `pushFailed` rides through: the write succeeded (hence 200), but a
    // REQUIRED live push may not have. Dropping it here is what made the UI
    // report a half-applied change as saved. See classifyModelChange.
    return Response.json({
      model: result.opencode_model,
      appliedLive: result.applied_live,
      ...(result.push_failed ? { pushFailed: true } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not change the model';
    return Response.json({ error: message }, { status: 400 });
  }
}
