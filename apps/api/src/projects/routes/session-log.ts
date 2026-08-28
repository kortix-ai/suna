/**
 * Session worker transcript log (harness/worker split P1.8 — "history readable
 * with nothing running").
 *
 * The pi worker keeps its conversation in memory and writes every mutation
 * through to this log with its OWN session credential
 * (apps/kortix-worker/src/session-store.ts). Two consequences the design turns
 * on:
 *
 *   - reads during a turn never leave the worker, so the log is not on the hot
 *     path of a running turn — only mutations cross the network;
 *   - the transcript outlives the process, so a stopped session's history is
 *     servable from here instead of by waking its sandbox. That wake is the
 *     "session looks stopped, then a huge delay" bug the plan names.
 *
 * `seq` is the WRITER's ordering and is unique per session. Replay depends on
 * it, so a duplicate is rejected rather than renumbered: silently accepting one
 * would reorder someone's conversation on the next resume.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt } from 'drizzle-orm';
import { projectSessions, sessionWorkerLog } from '@kortix/db';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { UUID_V4_REGEX } from '../lib/serializers';

/**
 * The wire shape is the WORKER's, not ours: it POSTs the bare mutation and
 * expects a bare array back (apps/kortix-worker/src/session-store.ts —
 * `RemoteSessionLog`). That contract is already proven by the Phase 0 spike and
 * its benches, so the server matches it rather than the other way round.
 *
 * There is no client sequence number in it. Ordering is arrival order, assigned
 * by the database, which is safe because exactly one worker writes one session
 * and its turns are serialized.
 */
const LogItemSchema = z.record(z.unknown());
const LogPageSchema = z.array(z.record(z.unknown()));

/**
 * A single append may not be unbounded: one runaway tool result would otherwise
 * put a multi-megabyte row on the replay path of every future resume.
 */
const MAX_ITEM_BYTES = 512 * 1024;

/**
 * Same gate as the session-environment routes: the project loads for the
 * caller, and a SESSION-scoped caller may only touch its own log — a
 * compromised worker must not be able to read or forge a sibling's transcript.
 */
async function authorizeLogCall(
  c: Parameters<Parameters<typeof projectsApp.openapi>[1]>[0],
  action: (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS],
): Promise<{ kind: 'error'; response: Response } | { kind: 'ok'; sessionId: string }> {
  const projectId = c.req.param('projectId') ?? '';
  const sessionId = c.req.param('sessionId') ?? '';
  if (!UUID_V4_REGEX.test(sessionId)) {
    return { kind: 'error', response: c.json({ error: 'Invalid session id' }, 400) };
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { kind: 'error', response: c.json({ error: 'Not found' }, 404) };
  const callerSession = callerKortixSessionId(c);
  if (callerSession && callerSession !== sessionId) {
    return { kind: 'error', response: c.json({ error: 'Forbidden' }, 403) };
  }
  if (!callerSession) {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, action);
  }
  const [session] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session || (session.metadata as Record<string, unknown> | null)?.deletedAt) {
    return { kind: 'error', response: c.json({ error: 'Not found' }, 404) };
  }
  return { kind: 'ok', sessionId };
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/log',
    tags: ['projects'],
    summary: 'POST /:projectId/sessions/:sessionId/log',
    description:
      'Append one worker transcript mutation. Called by the worker with its own session credential.',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: LogItemSchema } } },
    },
    responses: {
      204: { description: 'Appended' },
      400: errors[400],
      401: errors[401],
      403: errors[403],
      404: errors[404],
      413: { description: 'Item exceeds the per-append size limit' },
    },
  }),
  async (c: any) => {
    const gate = await authorizeLogCall(c, PROJECT_ACTIONS.SESSION_START);
    if (gate.kind === 'error') return gate.response;
    const item = c.req.valid('json') as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) {
      return c.json({ error: 'log item too large' }, 413);
    }
    await db.insert(sessionWorkerLog).values({ sessionId: gate.sessionId, item });
    return c.body(null, 204);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/log',
    tags: ['projects'],
    summary: 'GET /:projectId/sessions/:sessionId/log',
    description:
      'Read the worker transcript log in seq order. Served from the database, so it works with no runtime running.',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({ after: z.coerce.number().int().min(0).optional() }),
    },
    responses: {
      200: json(LogPageSchema, 'The session transcript log'),
      400: errors[400],
      401: errors[401],
      403: errors[403],
      404: errors[404],
    },
  }),
  async (c: any) => {
    const gate = await authorizeLogCall(c, PROJECT_ACTIONS.PROJECT_READ);
    if (gate.kind === 'error') return gate.response;
    const after = c.req.valid('query').after ?? 0;
    const rows = await db
      .select({ item: sessionWorkerLog.item })
      .from(sessionWorkerLog)
      .where(and(eq(sessionWorkerLog.sessionId, gate.sessionId), gt(sessionWorkerLog.id, after)))
      .orderBy(asc(sessionWorkerLog.id));
    // A bare array: the worker replays exactly what it appended, in order.
    return c.json(rows.map((r) => r.item));
  },
);
