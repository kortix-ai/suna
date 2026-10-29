import { createRoute, z } from '@hono/zod-openapi';
import { privateSpaceMemberIds } from '../../shared/space-access';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json, lenientBody } from '../../openapi';
import {
  DEFAULT_PREVIEW_CANDIDATES,
  createPublicShare,
  getLiveResponseShare,
  listPublicSharesForSession,
  revokePublicShare,
  revokeResponseShare,
  serializeTurnShare,
  upsertResponseShare,
} from '../../shared/session-public-shares';
import { buildResponseSnapshot } from '../lib/response-snapshot';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { guardSession, guardSessionSharing, guardTurnPublish, guardTurnRevoke, sessionAccessDenied } from '../lib/http-session-access';
import { isUuid } from '../../shared/validate';
import { readJsonObject } from '../../shared/http-body';
import { sessionHasPersonalConnectorBinding } from '../lib/session-connector-bindings';
import { sessionPersonOnlyPlaintextSecrets } from '../lib/secret-audience';

const TurnShareSchema = z.object({
  share_id: z.string(),
  turn_id: z.string().openapi({ description: 'The user message id that starts the turn.' }),
  token: z.string(),
  url: z.string().openapi({ description: 'The public web page of the response.' }),
  created_at: z.string(),
  snapshot_at: z.string(),
  stale: z.boolean().openapi({ description: 'The live response text differs from the published snapshot.' }),
  include_prompt: z.boolean().openapi({ description: 'The snapshot also publishes the prompt text.' }),
});
const TurnParams = z.object({ projectId: z.string(), sessionId: z.string(), turnId: z.string().min(1).max(200) });

/**
 * A public link must never carry a member's PERSONAL data: a session bound to a
 * personal connector, or holding person-only plaintext secrets, is refused with
 * 409. One check for every public share kind (preview/file and response).
 */
async function personalDataRefusal(input: { accountId: string; projectId: string; sessionId: string }) {
  if (await sessionHasPersonalConnectorBinding(input)) {
    return {
      error: 'Sessions using a personal connection cannot be shared publicly',
      code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
    };
  }
  const held = await sessionPersonOnlyPlaintextSecrets(input);
  if (held.length > 0) {
    return {
      error: `This session holds ${held.join(', ')}, shared only with you, and cannot be shared publicly. Start a new session to share.`,
      code: 'PERSONAL_SECRET_REQUIRES_PRIVATE_SESSION',
      secrets: held,
    };
  }
  return null;
}

export function registerPublicSharesRoutes(): void {
  // GET /v1/projects/:projectId/sessions/:sessionId/previews
  // Human-friendly preview candidates. The frontend should pass the active
  // browser/preview tab when it has one; this endpoint is a fallback list.

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/previews',
      tags: ['sessions'],
      summary: 'List preview URLs of a session',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
      responses: {
        200: json(z.any(), 'Preview candidates'),
        ...errors(400, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const guard = await guardSession(c, loaded, sessionId, 'read');
      if (!guard.ok) return sessionAccessDenied(c, guard);

      return c.json({
        candidates: DEFAULT_PREVIEW_CANDIDATES.map((candidate) => ({
          ...candidate,
          status: 'unknown',
        })),
      });
    },
  );

  // GET /v1/projects/:projectId/sessions/:sessionId/public-shares

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/public-shares',
      tags: ['sessions'],
      summary: 'List public shares of a session',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
      responses: {
        200: json(z.any(), 'Public shares'),
        ...errors(400, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const guard = await guardSessionSharing(c, loaded, sessionId, 'list');
      if (!guard.ok) return sessionAccessDenied(c, guard);

      return c.json({ shares: await listPublicSharesForSession(sessionId) });
    },
  );

  // POST /v1/projects/:projectId/sessions/:sessionId/public-shares

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/public-shares',
      tags: ['sessions'],
      summary: 'Create a public share of a session',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            preview_id: z.string().optional().openapi({ description: 'Share a session preview by id (from the previews list).' }),
            file: z.record(z.string(), z.any()).optional().openapi({ description: 'Share a workspace file: { path }.' }),
            mode: z.string().optional().openapi({ description: 'Access mode of the link.' }),
            label: z.string().optional().openapi({ description: 'Label of the link.' }),
            expires_at: z.string().optional().openapi({ description: 'ISO-8601 expiry.' }),
          }) } } },
      },
      responses: {
        201: json(z.any(), 'Public share'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

      const body = await readJsonObject(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Minting, not revoking: a public share link is unauthenticated, so this is
      // the owner's call. A manager who cannot read the session cannot mint one
      // and read it through the link instead.
      const guard = await guardSessionSharing(c, loaded, sessionId, 'mint');
      if (!guard.ok) return sessionAccessDenied(c, guard);
      const visible = guard.session;
      // A member of a private channel may publish one of its threads; an
      // agent does not decide that.
      if (callerKortixSessionId(c) !== null && (await privateSpaceMemberIds(visible.row.spaceId)) !== null) {
        return c.json({ error: 'An agent cannot publish a private channel\'s thread. A member must do it.', code: 'session_bound_caller' }, 403);
      }
      const personal = await personalDataRefusal({ accountId: visible.row.accountId, projectId, sessionId });
      if (personal) return c.json(personal, 409);

      const result = await createPublicShare(body, {
        sessionId,
        projectId,
        accountId: visible.row.accountId,
        userId: loaded.userId,
      });
      if (!result.ok) return c.json({ error: result.error }, result.status as any);
      return c.json({ share: result.share }, 201);
    },
  );

  // DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/sessions/{sessionId}/public-shares/{shareId}',
      tags: ['sessions'],
      summary: 'Revoke a public session share',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string(), shareId: z.string() }),
      },
      responses: {
        200: json(z.any(), 'Revoked'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      const shareId = c.req.param('shareId');
      if (!isUuid(sessionId) || !isUuid(shareId)) {
        return c.json({ error: 'Invalid id' }, 400);
      }

      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Revoking only ever REMOVES access, so it stays manager-tier: a project
      // manager must be able to kill a leaking link without owning the session.
      const guard = await guardSessionSharing(c, loaded, sessionId, 'revoke');
      if (!guard.ok) return sessionAccessDenied(c, guard);

      const share = await revokePublicShare(sessionId, shareId);
      if (!share) return c.json({ error: 'Not found' }, 404);
      return c.json({ share });
    },
  );

  // ── Response shares: one assistant response (one turn), by its user message id ──

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/turns/{turnId}/share',
      tags: ['sessions'],
      summary: 'Read the public share of one assistant response',
      ...auth,
      request: { params: TurnParams },
      responses: {
        200: json(z.object({ share: TurnShareSchema.nullable() }), 'The live share, or null'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      const { projectId, sessionId, turnId } = c.req.valid('param');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // The PUT rule (mayPublishTurn): only someone who could publish sees the token and URL.
      const guard = await guardTurnPublish(c, loaded, sessionId);
      if (!guard.ok) return c.json({ error: guard.error }, guard.status);

      const row = await getLiveResponseShare(sessionId, turnId);
      if (!row) return c.json({ share: null }, 200);
      const live = await buildResponseSnapshot({ sessionId, projectId, turnId, includePrompt: false });
      return c.json({ share: serializeTurnShare(row, live.ok ? live.snapshot.markdown : null) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/sessions/{sessionId}/turns/{turnId}/share',
      tags: ['sessions'],
      summary: 'Share one assistant response publicly, or refresh its snapshot',
      description:
        'Publishes the text of the response as an immutable snapshot built from the stored session log. A second call re-snapshots the same share: the URL does not change. `include_prompt: true` also publishes the prompt text (default false; every call sets it anew). Reasoning, tool calls and files are never published.',
      ...auth,
      request: {
        params: TurnParams,
        body: {
          required: false,
          content: { 'application/json': { schema: lenientBody({
            include_prompt: z.boolean().optional().openapi({ description: 'Also publish the prompt text. Default false.' }),
          }) } },
        },
      },
      responses: {
        200: json(z.object({ share: TurnShareSchema }), 'The live share'),
        ...errors(400, 403, 404, 409, 413),
      },
    }),
    async (c) => {
      const { projectId, sessionId, turnId } = c.req.valid('param');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Owner or project manager, human, and able to read the session (mayPublishTurn).
      const guard = await guardTurnPublish(c, loaded, sessionId);
      if (!guard.ok) return c.json({ error: guard.error }, guard.status);
      const personal = await personalDataRefusal({ accountId: guard.session.row.accountId, projectId, sessionId });
      if (personal) return c.json(personal, 409);

      const body = await readJsonObject(c);
      const built = await buildResponseSnapshot({ sessionId, projectId, turnId, includePrompt: body.include_prompt === true });
      if (!built.ok) return c.json({ error: built.error }, built.status);
      const row = await upsertResponseShare({
        sessionId,
        projectId,
        accountId: guard.session.row.accountId,
        userId: loaded.userId,
        turnId,
        snapshot: built.snapshot,
      });
      return c.json({ share: serializeTurnShare(row, built.snapshot.markdown) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/sessions/{sessionId}/turns/{turnId}/share',
      tags: ['sessions'],
      summary: 'Revoke the public share of one assistant response',
      ...auth,
      request: { params: TurnParams },
      responses: {
        200: json(z.object({ share: z.null() }), 'Revoked'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      const { projectId, sessionId, turnId } = c.req.valid('param');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Human owner or project manager; no read check (revoking only removes access).
      const guard = await guardTurnRevoke(c, loaded, sessionId);
      if (!guard.ok) return c.json({ error: guard.error }, guard.status);

      await revokeResponseShare(sessionId, turnId);
      return c.json({ share: null }, 200);
    },
  );
}
