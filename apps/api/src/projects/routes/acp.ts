import { acpSessionEnvelopes, sessionSandboxes } from '@kortix/db';
import type { SseBlock } from '@kortix/sdk/acp';
import { and, asc, eq, gt } from 'drizzle-orm';

import { db } from '../../shared/db';
import { loadProjectForUser, loadVisibleSession } from '../lib/access';
import { isAcpPromptEnvelope } from '../lib/acp-envelope';
import { persistAcpSessionIdentity } from '../lib/acp-session-identity';
import { createPersistedSseProxy } from '../lib/acp-sse-proxy';
import { projectsApp } from '../lib/app';
import { decodedResponseHeaders } from '../lib/proxy-headers';
import { syncSandboxEnvForPrompt } from '../lib/sandbox-env-sync';
import { inspectSandboxRuntime, sandboxRuntimeEndpoint } from '../runtime-inspection';

type Envelope = Record<string, unknown>;

async function resolveAcpTarget(c: any) {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return null;
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return null;
  const [sandbox] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.sessionId, sessionId),
    ))
    .limit(1);
  if (!sandbox?.externalId) return null;
  const endpoint = await sandboxRuntimeEndpoint(sandbox.externalId, loaded.userId);
  if (!endpoint) return null;
  const health = await inspectSandboxRuntime(sandbox.externalId, loaded.userId);
  return {
    projectId,
    sessionId,
    runtimeId: sessionId,
    harness: health?.acpHarness ?? null,
    externalId: sandbox.externalId,
    endpoint,
  };
}

async function appendEnvelope(input: {
  projectId: string;
  sessionId: string;
  runtimeId: string;
  direction: 'client_to_agent' | 'agent_to_client';
  envelope: Envelope;
  streamEventId?: number | null;
}) {
  await db.insert(acpSessionEnvelopes).values({
    projectId: input.projectId,
    sessionId: input.sessionId,
    runtimeId: input.runtimeId,
    direction: input.direction,
    envelope: input.envelope,
    streamEventId: input.streamEventId ?? null,
  }).onConflictDoNothing();
}

async function persistSseBlock(
  block: SseBlock,
  target: NonNullable<Awaited<ReturnType<typeof resolveAcpTarget>>>,
) {
  try {
    await appendEnvelope({
      ...target,
      direction: 'agent_to_client',
      streamEventId: block.id,
      envelope: JSON.parse(block.data.join('\n')) as Envelope,
    });
  } catch (error) {
    console.warn(`[acp] failed to persist SSE event ${block.id} for ${target.sessionId}:`, error);
  }
}

projectsApp.get('/:projectId/sessions/:sessionId/acp/transcript', async (c: any) => {
  const target = await resolveAcpTarget(c);
  if (!target) return c.json({ error: 'Session runtime not found' }, 404);
  const after = Number(c.req.query('after') ?? 0);
  const rows = await db
    .select({
      ordinal: acpSessionEnvelopes.ordinal,
      direction: acpSessionEnvelopes.direction,
      streamEventId: acpSessionEnvelopes.streamEventId,
      envelope: acpSessionEnvelopes.envelope,
      createdAt: acpSessionEnvelopes.createdAt,
    })
    .from(acpSessionEnvelopes)
    .where(and(
      eq(acpSessionEnvelopes.projectId, target.projectId),
      eq(acpSessionEnvelopes.sessionId, target.sessionId),
      ...(Number.isSafeInteger(after) && after > 0 ? [gt(acpSessionEnvelopes.ordinal, after)] : []),
    ))
    .orderBy(asc(acpSessionEnvelopes.ordinal));
  return c.json({ runtime_id: target.runtimeId, envelopes: rows });
});

projectsApp.on(['GET', 'POST', 'DELETE'], '/:projectId/sessions/:sessionId/acp', async (c: any) => {
  const target = await resolveAcpTarget(c);
  if (!target) return c.json({ error: 'Session runtime not found' }, 404);
  const harnessQuery = target.harness ? `?agent=${encodeURIComponent(target.harness)}` : '';
  const upstreamUrl = `${target.endpoint.url}/acp/${encodeURIComponent(target.runtimeId)}${harnessQuery}`;
  const method = c.req.method.toUpperCase();
  const headers = new Headers(target.endpoint.headers);

  let requestBody: string | undefined;
  if (method === 'POST') {
    const body = await c.req.text();
    requestBody = body;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(body) as Envelope;
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    await appendEnvelope({ ...target, direction: 'client_to_agent', envelope });
    if (isAcpPromptEnvelope(envelope)) {
      try {
        await syncSandboxEnvForPrompt({
          projectId: target.projectId,
          sessionId: target.sessionId,
          serviceKey: target.endpoint.serviceKey,
          previewUrl: target.endpoint.url,
          providerHeaders: target.endpoint.headers,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: 'project env sync failed', detail: message }, 502);
      }
    }
    headers.set('Content-Type', 'application/json');
  }
  const lastEventId = c.req.header('last-event-id');
  if (lastEventId) headers.set('Last-Event-ID', lastEventId);
  if (method === 'GET') headers.set('Accept', 'text/event-stream');

  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body: requestBody,
    signal: c.req.raw.signal,
  });
  const responseHeaders = decodedResponseHeaders(upstream);

  if (method === 'POST' && upstream.ok && upstream.status !== 202 && upstream.body) {
    const responseBody = await upstream.text();
    try {
      const requestEnvelope = JSON.parse(requestBody ?? '{}') as Envelope;
      const responseEnvelope = JSON.parse(responseBody) as Envelope;
      await appendEnvelope({
        ...target,
        direction: 'agent_to_client',
        envelope: responseEnvelope,
      });
      const result = responseEnvelope.result as Record<string, unknown> | undefined;
      if (requestEnvelope.method === 'session/new' && typeof result?.sessionId === 'string') {
        await persistAcpSessionIdentity({ db }, {
          projectSessionId: target.sessionId,
          runtimeId: target.runtimeId,
          acpSessionId: result.sessionId,
        }, { projectId: target.projectId });
      }
    } catch {}
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  }

  if (method === 'GET' && upstream.ok && upstream.body) {
    return new Response(createPersistedSseProxy(upstream.body, {
      sessionId: target.sessionId,
      persistBlock: (block) => persistSseBlock(block, target),
    }), {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
});
