import { acpSessionEnvelopes, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, asc, eq, gt } from 'drizzle-orm';

import { db } from '../../shared/db';
import { loadProjectForUser, loadVisibleSession } from '../lib/access';
import { projectsApp } from '../lib/app';
import { sandboxOpencodeEndpoint } from '../opencode-mapping';

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
  const endpoint = await sandboxOpencodeEndpoint(sandbox.externalId, loaded.userId);
  if (!endpoint) return null;
  return { projectId, sessionId, runtimeId: sessionId, endpoint };
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

async function persistSse(
  body: ReadableStream<Uint8Array>,
  target: NonNullable<Awaited<ReturnType<typeof resolveAcpTarget>>>,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    if (done && buffer.trim()) buffer += '\n\n';
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r/g, '');
      buffer = buffer.slice(boundary + 2);
      let eventId: number | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) eventId = Number(line.slice(3).trim());
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (eventId !== null && Number.isSafeInteger(eventId) && data.length) {
        try {
          await appendEnvelope({
            ...target,
            direction: 'agent_to_client',
            streamEventId: eventId,
            envelope: JSON.parse(data.join('\n')) as Envelope,
          });
        } catch (error) {
          console.warn(`[acp] failed to persist SSE event ${eventId} for ${target.sessionId}:`, error);
        }
      }
    }
    if (done) return;
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
  const upstreamUrl = `${target.endpoint.url}/acp/${encodeURIComponent(target.runtimeId)}`;
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
        const [current] = await db.select({ metadata: projectSessions.metadata })
          .from(projectSessions)
          .where(and(
            eq(projectSessions.projectId, target.projectId),
            eq(projectSessions.sessionId, target.sessionId),
          ))
          .limit(1);
        await db.update(projectSessions).set({
          metadata: {
            ...((current?.metadata as Record<string, unknown> | null) ?? {}),
            runtime_protocol: 'acp',
            runtime_id: target.runtimeId,
            acp_session_id: result.sessionId,
          },
          updatedAt: new Date(),
        }).where(and(
          eq(projectSessions.projectId, target.projectId),
          eq(projectSessions.sessionId, target.sessionId),
        ));
      }
    } catch {}
    return new Response(responseBody, { status: upstream.status, headers: upstream.headers });
  }

  if (method === 'GET' && upstream.ok && upstream.body) {
    const [clientBody, persistenceBody] = upstream.body.tee();
    void persistSse(persistenceBody, target);
    return new Response(clientBody, { status: upstream.status, headers: upstream.headers });
  }

  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
});
