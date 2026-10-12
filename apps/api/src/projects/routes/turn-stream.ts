/** Sandbox turn relay: `POST /:projectId/turn-stream` (steps, answers, and turn end). */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam';
import { setContextField } from '../../lib/request-context';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import {
  type TurnStreamBody,
  abandonTurn,
  acceptTurn,
  beginTurn,
  claimInitialTurn,
  pinOpencodeSession,
  readSteer,
  relayContent,
  settleTurnEnd,
} from './turn-stream-handlers';
import { normalizeRuntimeRelayBody, TurnStreamRelayBodySchema } from '@kortix/api-contract/runtime-relay';
import { turnStreamKindField, turnStreamKindNeedsConnectorWrite } from './turn-stream-kind';

export function registerTurnStreamRoutes(): void {
  // POST /v1/projects/:projectId/turn-stream
  // Agent-cli relay for the live Slack plan: kind=step appends a checkpoint,
  // kind=answer finalizes the turn's streamed message with the agent's reply.
  //
  // The sleeve owns only what every kind shares: the body parse, the kind
  // normalization, and the two credential scopes. Each `kind` then dispatches to
  // a per-kind handler in turn-stream-handlers.ts.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/turn-stream',
      tags: ['projects'],
      summary: 'Run a turn and stream the reply',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        // Documents the frame; the handler owns validation (its own 400s) and
        // accepts the pre-W3 spellings an older daemon sends.
        body: { content: { 'application/json': { schema: TurnStreamRelayBodySchema.or(AnyObject) } } },
      },
      responses: {
        200: {
          description: 'Relay result',
          content: { 'application/json': { schema: z.any() } },
        },
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      let body: TurnStreamBody;
      try {
        // A daemon built before W3 sends `opencode_session_id` and kind `opencode_session`.
        body = normalizeRuntimeRelayBody((await c.req.json()) as TurnStreamBody);
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      setContextField('kind', turnStreamKindField(body.kind));
      const sessionId = body.session_id?.trim();
      if (!sessionId) {
        return c.json({ error: 'session_id is required' }, 400);
      }

      // Two valid callers: a project/session-scoped PAT (dashboard, operator, or
      // in-sandbox agent CLI) and the session sandbox's own service credential.
      // Each is scoped back to this projectId before a turn event is accepted.
      let authenticatedSandboxId: string | null = null;
      if (isSessionSandboxCredential(c)) {
        const accountId = (c as any).get('accountId') as string | undefined;
        const sandboxId = (c as any).get('sandboxId') as string | undefined;
        if (!accountId || !sandboxId) {
          return c.json({ error: 'turn-stream requires a sandbox token' }, 403);
        }
        // Sandbox images baked before 2026-07-29 still POST the retired
        // `execution_heartbeat` / `execution_lease_*` kinds here. They fall
        // through to the generic relay below and get a harmless `{ ok: false }`;
        // the in-sandbox reporter treated every non-2xx as best-effort anyway.
        const [sandbox] = await db
          .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId })
          .from(sessionSandboxes)
          .where(
            and(
              eq(sessionSandboxes.sandboxId, sandboxId),
              eq(sessionSandboxes.projectId, projectId),
              eq(sessionSandboxes.accountId, accountId),
              inArray(sessionSandboxes.status, ['provisioning', 'active']),
            ),
          )
          .limit(1);
        if (!sandbox) {
          return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
        }
        authenticatedSandboxId = sandbox.sandboxId;
      } else {
        const loaded = await loadProjectForUser(c, projectId, 'read');
        if (!loaded) return c.json({ error: 'Not found' }, 404);
        // Kind-aware capability floor. The connector.write gate protects the
        // CHANNEL-SEND primitives: `step`/`answer` — and any unknown kind — fall
        // through to relayTurnStep/relayTurnAnswer below, which post the agent's
        // content to the project's Slack/Teams. The SANDBOX-reported LIFECYCLE
        // signals carry no content and fan out to no connector: `end`/`turn_end`
        // only shorten this session's idle deadline (LEAST-only — see the comment
        // at the `end` branch below, it can never EXTEND the box's life), and
        // `runtime_session` only persists the root-session pin. Those are exactly
        // what the in-sandbox agent CLI reports over its session/CLI token, which a
        // SCOPED agent grant has no reason to hold connector.write for — gating them
        // 403'd every turn-end report on SampleCo, stranding sandboxes alive for the
        // full idle grace (wasted compute). So exempt the lifecycle kinds and keep
        // the connector gate as the deny-by-default floor for anything that can
        // reach the send path. The IDOR scope (session_id -> projectId) below still
        // applies to every kind, and the `read` floor above still requires
        // membership.
        if (turnStreamKindNeedsConnectorWrite(body.kind)) {
          await assertProjectCapability(
            c,
            loaded.userId,
            loaded.row.accountId,
            projectId,
            PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
          );
        }
      }

      let authenticatedSandboxMetadata: unknown = null;
      if (authenticatedSandboxId) {
        const [ownedSession] = await db
          .select({
            sessionId: sessionSandboxes.sessionId,
            metadata: sessionSandboxes.metadata,
          })
          .from(sessionSandboxes)
          .where(
            and(
              eq(sessionSandboxes.sandboxId, authenticatedSandboxId),
              eq(sessionSandboxes.sessionId, sessionId),
              eq(sessionSandboxes.projectId, projectId),
            ),
          )
          .limit(1);
        if (!ownedSession)
          return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
        authenticatedSandboxMetadata = ownedSession.metadata;
      }

      // session_id is caller-supplied — scope it back to :projectId so a caller
      // authed for their own project can't relay turn events into another
      // tenant's live session (IDOR).
      const [turnStreamSession] = await db
        .select({
          sessionId: projectSessions.sessionId,
          accountId: projectSessions.accountId,
          createdBy: projectSessions.createdBy,
          origin: projectSessions.origin,
          metadata: projectSessions.metadata,
          opencodeSessionId: projectSessions.runtimeSessionId,
        })
        .from(projectSessions)
        .where(
          and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
        )
        .limit(1);
      if (!turnStreamSession) {
        return c.json({ error: 'Not found' }, 404);
      }
      const turnStreamMetadata = (turnStreamSession.metadata ?? {}) as Record<string, unknown>;
      // Coordinator-spawned worker: its idle tail is minutes, not the default
      // grace — the box wakes on demand when the coordinator returns to it.
      const childSession = typeof turnStreamMetadata.spawned_by_session === 'string';

      switch (body.kind) {
        case 'initial_turn_claim':
          return claimInitialTurn(
            c,
            authenticatedSandboxId,
            authenticatedSandboxMetadata,
            turnStreamMetadata,
            turnStreamSession.opencodeSessionId ?? null,
          );
        case 'turn_abandoned':
          return abandonTurn(c, body, authenticatedSandboxId);
        case 'turn_accepted':
          return acceptTurn(c, body, authenticatedSandboxId);
        case 'turn_begin':
          return beginTurn(c, body, authenticatedSandboxId);
        case 'steer_read':
          return readSteer(c, body, sessionId, authenticatedSandboxId);
        case 'end':
        case 'turn_end':
          return settleTurnEnd(c, body, {
            projectId,
            sessionId,
            childSession,
            turnStreamMetadata,
            turnStreamSession: {
              accountId: turnStreamSession.accountId,
              createdBy: turnStreamSession.createdBy,
              origin: turnStreamSession.origin ?? null,
            },
          });
        case 'runtime_session':
          return pinOpencodeSession(c, body, authenticatedSandboxId, projectId, sessionId);
        default:
          return relayContent(c, body, sessionId);
      }
    },
  );
}
