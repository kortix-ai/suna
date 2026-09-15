import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, sql } from 'drizzle-orm';
import { projectSessions, sessionWorkerLog } from '@kortix/db';
import { isDeepStrictEqual } from 'node:util';
import { HTTPException } from 'hono/http-exception';
import {
  PI_STATE_STREAM,
  PiStateConflictError,
} from '../../../../../packages/sdk/src/core/pi/state';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors } from '../../openapi';
import { db } from '../../shared/db';
import { authorizeSessionStorageCall } from '../lib/session-storage-access';
import { validateAgentStateAppend } from '../lib/session-agent-state';
import { projectsApp } from '../lib/app';
import { UUID_V4_REGEX } from '../lib/serializers';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/agent-state',
    tags: ['projects'],
    summary: 'Commit a custom agent state revision without starting compute',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: z.record(z.unknown()) } } },
    },
    responses: {
      204: { description: 'Committed or identical retry' },
      ...errors(400, 401, 403, 404, 409, 413),
    },
  }),
  async (c: any) => {
    const gate = await authorizeSessionStorageCall(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    if (gate.kind === 'error') return gate.response;
    const appendId = c.req.header('idempotency-key')?.trim();
    const item = c.req.valid('json') as Record<string, unknown>;
    if (!appendId || !UUID_V4_REGEX.test(appendId) || item._kortixAppendId !== appendId)
      return c.json({ error: 'agent state requires a matching UUID v4 idempotency key' }, 400);
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > 512 * 1024)
      return c.json({ error: 'agent state item too large' }, 413);
    try {
      await db.transaction(async (tx) => {
        const [session] = await tx
          .select({ metadata: projectSessions.metadata })
          .from(projectSessions)
          .where(eq(projectSessions.sessionId, gate.sessionId))
          .for('no key update');
        if (!session || (session.metadata as Record<string, unknown> | null)?.deletedAt)
          throw new HTTPException(404, { message: 'Not found' });
        const [existing] = await tx
          .select({ item: sessionWorkerLog.item })
          .from(sessionWorkerLog)
          .where(
            and(
              eq(sessionWorkerLog.sessionId, gate.sessionId),
              eq(sessionWorkerLog.appendId, appendId),
            ),
          )
          .limit(1);
        if (existing) {
          if (!isDeepStrictEqual(existing.item, item))
            throw new HTTPException(409, { message: 'idempotency key reused with different item' });
          return;
        }
        const rows = await tx
          .select({ item: sessionWorkerLog.item })
          .from(sessionWorkerLog)
          .where(
            and(
              eq(sessionWorkerLog.sessionId, gate.sessionId),
              sql`${sessionWorkerLog.item}->>'stream' = ${PI_STATE_STREAM}`,
            ),
          )
          .orderBy(asc(sessionWorkerLog.id));
        validateAgentStateAppend(
          rows.map((row) => row.item as Record<string, unknown>),
          item,
        );
        const inserted = await tx
          .insert(sessionWorkerLog)
          .values({ sessionId: gate.sessionId, appendId, item })
          .onConflictDoNothing({ target: [sessionWorkerLog.sessionId, sessionWorkerLog.appendId] })
          .returning({ id: sessionWorkerLog.id });
        if (!inserted.length)
          throw new HTTPException(409, { message: 'state append lost its turn lease fence' });
      });
    } catch (error) {
      if (error instanceof PiStateConflictError)
        return c.json({ error: error.message, code: 'PI_STATE_CONFLICT' }, 409);
      throw error;
    }
    return c.body(null, 204);
  },
);
