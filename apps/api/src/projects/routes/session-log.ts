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

/** One appended mutation. `item` is the worker's own LogItem, stored verbatim. */
const LogItemSchema = z.object({
  seq: z.number().int().min(0),
  item: z.record(z.unknown()),
});

const LogPageSchema = z.object({
  session_id: z.string(),
  items: z.array(z.record(z.unknown())),
  next_seq: z.number().int(),
});

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
      204: { description: 'Appended, or already present with identical content' },
      400: errors[400],
      401: errors[401],
      403: errors[403],
      404: errors[404],
      409: { description: 'That seq already holds a different item' },
      413: { description: 'Item exceeds the per-append size limit' },
    },
  }),
  async (c: any) => {
    const gate = await authorizeLogCall(c, PROJECT_ACTIONS.SESSION_START);
    if (gate.kind === 'error') return gate.response;
    const { seq, item } = c.req.valid('json');
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) {
      return c.json({ error: 'log item too large' }, 413);
    }
    // Idempotent on replay: the worker awaits every append, so a retry after a
    // network failure must not become a second entry at the same seq.
    const existing = await db
      .select({ item: sessionWorkerLog.item })
      .from(sessionWorkerLog)
      .where(and(eq(sessionWorkerLog.sessionId, gate.sessionId), eq(sessionWorkerLog.seq, seq)))
      .limit(1);
    if (existing.length > 0) {
      const same = JSON.stringify(existing[0].item) === JSON.stringify(item);
      return same ? c.body(null, 204) : c.json({ error: 'seq already written' }, 409);
    }
    await db.insert(sessionWorkerLog).values({ sessionId: gate.sessionId, seq, item });
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
      query: z.object({ after: z.coerce.number().int().min(-1).optional() }),
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
    const after = c.req.valid('query').after ?? -1;
    const rows = await db
      .select({ seq: sessionWorkerLog.seq, item: sessionWorkerLog.item })
      .from(sessionWorkerLog)
      .where(and(eq(sessionWorkerLog.sessionId, gate.sessionId), gt(sessionWorkerLog.seq, after)))
      .orderBy(asc(sessionWorkerLog.seq));
    return c.json({
      session_id: gate.sessionId,
      items: rows.map((r) => r.item),
      // Where a resuming reader continues from; -1 when the log is empty, which
      // is the same value a first-time reader passes.
      next_seq: rows.length > 0 ? rows[rows.length - 1].seq : after,
    });
  },
);
