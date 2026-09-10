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
 * The database assigns append order. The worker supplies an idempotency key so
 * a response lost after commit can be retried without duplicating a mutation.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt } from 'drizzle-orm';
import { sessionWorkerLog } from '@kortix/db';
import { isDeepStrictEqual } from 'node:util';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { authorizeSessionStorageCall as authorizeLogCall } from '../lib/session-storage-access';
import { projectsApp } from '../lib/app';
import { UUID_V4_REGEX } from '../lib/serializers';
import { PI_STATE_STREAM } from '../../../../../packages/sdk/src/core/pi/state';

/**
 * The wire shape is the WORKER's, not ours: it POSTs the bare mutation and
 * expects a bare array back (apps/kortix-worker/src/session-store.ts —
 * `RemoteSessionLog`). That contract is already proven by the Phase 0 spike and
 * its benches, so the server matches it rather than the other way round.
 *
 * Ordering is arrival order, assigned by the database. The worker adds one
 * UUID `Idempotency-Key` per append and reuses it across transport retries.
 * This keeps a response lost after COMMIT from duplicating the mutation.
 * Missing keys remain accepted while older workers drain during rollout.
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
      ...errors(400, 401, 403, 404),
      409: { description: 'Idempotency key was already used for different content' },
      413: { description: 'Item exceeds the per-append size limit' },
    },
  }),
  async (c: any) => {
    const gate = await authorizeLogCall(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    if (gate.kind === 'error') return gate.response;
    const item = c.req.valid('json') as Record<string, unknown>;
    if (item.stream === PI_STATE_STREAM)
      return c.json({ error: 'agent state writes require the agent-state endpoint' }, 400);
    const appendId = c.req.header('idempotency-key')?.trim() || null;
    if (appendId && !UUID_V4_REGEX.test(appendId)) {
      return c.json({ error: 'idempotency-key must be a UUID v4' }, 400);
    }
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) {
      return c.json({ error: 'log item too large' }, 413);
    }
    if (!appendId) {
      await db.insert(sessionWorkerLog).values({ sessionId: gate.sessionId, appendId: null, item });
      return c.body(null, 204);
    }

    const inserted = await db
      .insert(sessionWorkerLog)
      .values({ sessionId: gate.sessionId, appendId, item })
      .onConflictDoNothing({ target: [sessionWorkerLog.sessionId, sessionWorkerLog.appendId] })
      .returning({ item: sessionWorkerLog.item });
    if (inserted.length > 0) return c.body(null, 204);

    const [existing] = await db
      .select({ item: sessionWorkerLog.item })
      .from(sessionWorkerLog)
      .where(
        and(
          eq(sessionWorkerLog.sessionId, gate.sessionId),
          eq(sessionWorkerLog.appendId, appendId),
        ),
      )
      .limit(1);
    if (!existing || !isDeepStrictEqual(existing.item, item)) {
      return c.json({ error: 'idempotency key reused with different item' }, 409);
    }
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
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const gate = await authorizeLogCall(c, PROJECT_ACTIONS.PROJECT_SESSION_READ);
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
