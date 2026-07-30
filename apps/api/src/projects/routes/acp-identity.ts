import { createRoute, z } from '@hono/zod-openapi';
import { HARNESS_IDS, type HarnessId } from '@kortix/shared/harnesses';

import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import {
  AcpSessionIdentityConflictError,
  persistAcpSessionIdentity,
} from '../lib/acp-session-identity';
import { projectsApp } from '../lib/app';
import { UUID_V4_REGEX } from '../lib/serializers';

const AcpSessionIdentitySchema = z.object({
  acp_server_id: z.string().trim().min(1),
  runtime_harness: z.enum(HARNESS_IDS),
  acp_session_id: z.string().trim().min(1),
});

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/acp-identity',
    tags: ['sessions'],
    summary: 'Persist the immutable harness-native ACP session identity',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: AcpSessionIdentitySchema,
          },
        },
      },
    },
    responses: {
      200: json(AcpSessionIdentitySchema, 'Persisted ACP session identity'),
      ...errors(400, 404, 409),
    },
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) {
      return c.json({ error: 'Invalid session id' }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const body = c.req.valid('json');
    try {
      const identity = await persistAcpSessionIdentity(
        { db },
        {
          projectId,
          projectSessionId: sessionId,
          acpServerId: body.acp_server_id,
          runtimeHarness: body.runtime_harness as HarnessId,
          acpSessionId: body.acp_session_id,
        },
      );
      return c.json(identity, 200);
    } catch (error) {
      if (error instanceof AcpSessionIdentityConflictError) {
        const status = error.code === 'ACP_SESSION_NOT_FOUND' ? 404 : 409;
        // A lost session/new race is recoverable: hand the loser the id that
        // won so it adopts that session instead of surfacing a dead-end error.
        // The invariant itself does not bend — the write is still rejected.
        return c.json(
          {
            error: error.message,
            code: error.code,
            ...(error.storedAcpSessionId ? { acp_session_id: error.storedAcpSessionId } : {}),
          },
          status,
        );
      }
      throw error;
    }
  },
);
