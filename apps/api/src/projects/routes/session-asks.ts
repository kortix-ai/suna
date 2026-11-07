/**
 * Session asks: the one list of everything an agent waits on a person for, and
 * the one place to decide it (lib/session-asks.ts has the model).
 *
 * GET  /v1/projects/:projectId/asks                  open asks the caller may decide
 * POST /v1/projects/:projectId/asks/:askId/answer    answer a question, decide a permission ask
 *
 * A connector approval is listed here and decided over `POST /approvals/:executionId`.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { logger } from '../../lib/logger';
import { readJsonObject } from '../../shared/http-body';
import { hiddenSpaceIds } from '../../shared/space-access';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { AnyObject, projectsApp } from '../lib/app';
import { loadProjectForUser } from '../lib/access';
import { approvalCallerOf } from '../lib/http-approval-caller';
import { mayResolveApproval, type ApprovalCaller } from '../lib/approval-authority';
import { listOpenAsks, parseAskId, type SessionAsk } from '../lib/session-asks';
import { readAskSessions, type AskSessionRow } from '../lib/session-ask-sessions';
import {
  decidePendingPermission,
  getPendingPermission,
  markPermissionConsumed,
  renderPermissionDecisionPrompt,
  type PermissionDecision,
} from '../lib/pending-permissions';
import { getPendingQuestionById, renderAnswerPrompt, resolvePendingQuestion, dismissPendingQuestion } from '../lib/pending-questions';
import { releaseRuntimeQuestion } from '../session-lifecycle/release-runtime-question';
import { rejectRuntimeQuestion, replyRuntimePermission } from '../session-lifecycle/runtime-asks';
import { deliverThroughQueue } from '../session-lifecycle';
import { workspaceIdParam } from '../../shared/route-params';

/** May this caller decide asks of `session`, or of the session a person opens for it? */
function mayDecide(caller: ApprovalCaller, sessions: Map<string, AskSessionRow>, ask: Pick<SessionAsk, 'session_id' | 'surface_session_id'>): boolean {
  for (const id of new Set([ask.session_id, ask.surface_session_id])) {
    const row = sessions.get(id);
    if (!row) continue;
    const verdict = mayResolveApproval({ ...caller, targetSessionOrigin: row.origin, targetSessionCreatedBy: row.createdBy });
    if (verdict.allowed) return true;
  }
  return false;
}

/**
 * An ask whose thread sits in a private channel the caller is not in does not
 * exist for them, a manager included: the decision writes into that thread.
 */
function askInHiddenSpace(sessions: Map<string, AskSessionRow>, ask: { sessionId: string; surfaceSessionId: string | null }, hidden: ReadonlySet<string>): boolean {
  const row = sessions.get(ask.surfaceSessionId ?? ask.sessionId) ?? sessions.get(ask.sessionId);
  return !!row?.spaceId && hidden.has(row.spaceId);
}

export function registerSessionAsksRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/asks',
      tags: ['sessions'],
      summary: 'List the open asks that wait on a person',
      description:
        'Questions, permission asks and connector approvals that wait on a person, newest first. ' +
        'Only asks the caller may decide: a project manager sees every session, a member the sessions they launched. ' +
        '`surface_session_id` keeps the asks shown on that session (a hidden worker\'s asks show on its root).',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({ surface_session_id: z.string().optional(), limit: z.string().optional() }),
      },
      responses: { 200: json(AnyObject, 'Open asks'), ...errors(404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const surface = c.req.query('surface_session_id')?.trim() || undefined;
      const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
      const asks = await listOpenAsks({ projectId, surfaceSessionId: surface, limit: Number.isFinite(limit) ? limit : undefined });
      if (asks.length === 0) return c.json({ asks: [], total: 0 });

      const caller = await approvalCallerOf(c, loaded, projectId);
      const sessions = await readAskSessions(projectId, asks.flatMap((a) => [a.session_id, a.surface_session_id]));
      const hidden = await hiddenSpaceIds(projectId, loaded.userId, callerKortixSessionId(c));
      const visible = asks.filter((ask) => {
        const surfaceRow = sessions.get(ask.surface_session_id) ?? sessions.get(ask.session_id);
        if (surfaceRow?.spaceId && hidden.has(surfaceRow.spaceId)) return false;
        return mayDecide(caller, sessions, ask);
      });
      return c.json({
        asks: visible.map((ask) => ({ ...ask, session_title: sessions.get(ask.surface_session_id)?.title ?? null })),
        total: visible.length,
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/asks/{askId}/answer',
      tags: ['sessions'],
      summary: 'Answer a question or decide a permission ask',
      description:
        'A question takes `{ answers: string[][] }` (one list per question) or `{ dismiss: true }`. ' +
        'A permission ask takes `{ reply: "once" | "always" | "reject" }`. ' +
        'A call that still waits live gets the decision at once; a parked one hears it as a new message in the session that asked. ' +
        'A connector approval is decided over POST /approvals/:executionId.',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), askId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(AnyObject, 'Decided'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const parsed = parseAskId(c.req.param('askId'));
      if (!parsed) return c.json({ error: 'Unknown ask id' }, 400);
      if (parsed.kind === 'approval') {
        return c.json({ error: 'Decide a connector approval over POST /approvals/:executionId', code: 'USE_APPROVALS_ROUTE' }, 400);
      }
      // An ask exists so the agent yields to a person: its own token never answers it.
      if (isProjectSessionPrincipal(c)) {
        return c.json({ error: 'An agent cannot answer its own ask — a person must', code: 'ASK_REQUIRES_HUMAN' }, 403);
      }
      const loaded = await loadProjectForUser(c, projectId, 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const body = await readJsonObject(c);
      const caller = await approvalCallerOf(c, loaded, projectId);

      if (parsed.kind === 'permission') {
        const ask = await getPendingPermission(projectId, parsed.id);
        if (!ask) return c.json({ error: 'Not found' }, 404);
        const reply = body.reply;
        if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
          return c.json({ error: "reply must be 'once', 'always' or 'reject'" }, 400);
        }
        const sessions = await readAskSessions(projectId, [ask.sessionId, ask.surfaceSessionId ?? ask.sessionId]);
        if (askInHiddenSpace(sessions, ask, await hiddenSpaceIds(projectId, loaded.userId, callerKortixSessionId(c)))) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (!mayDecide(caller, sessions, { session_id: ask.sessionId, surface_session_id: ask.surfaceSessionId ?? ask.sessionId })) {
          return c.json({ error: 'Only a workspace manager or the session launcher can decide this' }, 403);
        }
        const result = await decidePermission({ ask, reply, userId: loaded.userId });
        return c.json(result.code ? { error: 'This ask was already decided', ...result } : result, result.code ? 409 : 200);
      }

      const question = await getPendingQuestionById(projectId, parsed.id);
      if (!question) return c.json({ error: 'Not found' }, 404);
      const sessions = await readAskSessions(projectId, [question.sessionId, question.surfaceSessionId ?? question.sessionId]);
      if (askInHiddenSpace(sessions, question, await hiddenSpaceIds(projectId, loaded.userId, callerKortixSessionId(c)))) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (!mayDecide(caller, sessions, { session_id: question.sessionId, surface_session_id: question.surfaceSessionId ?? question.sessionId })) {
        return c.json({ error: 'Only a workspace manager or the session launcher can answer this' }, 403);
      }
      if (body.dismiss === true) {
        const dismissed = await dismissPendingQuestion(question.sessionId, question.requestId);
        if (!dismissed) return c.json({ error: 'question was already answered', code: 'ALREADY_ANSWERED' }, 409);
        // A question that still waits live resolves as dismissed; a parked one is only closed.
        await rejectRuntimeQuestion(question.sessionId, question.requestId);
        return c.json({ ok: true, delivery: 'dismissed' });
      }
      const answers = body.answers;
      if (!Array.isArray(answers) || answers.length === 0 || !answers.every((a) => Array.isArray(a) && a.every((v) => typeof v === 'string'))) {
        return c.json({ error: 'answers must be a non-empty array of string arrays' }, 400);
      }
      // CAS: closing the question claims the right to deliver it, so two people answering at once produce one message.
      const claimed = await resolvePendingQuestion({ sessionId: question.sessionId, requestId: question.requestId, answers });
      if (!claimed) return c.json({ error: 'question was already answered', code: 'ALREADY_ANSWERED' }, 409);
      const released = await releaseRuntimeQuestion(question.sessionId, question.requestId, answers as string[][]);
      if (released === 'released') return c.json({ ok: true, delivery: 'delivered' });
      const outcome = await deliverThroughQueue({
        source: 'ui',
        idempotencyKey: `question:${question.sessionId}:${question.requestId}`,
        sessionId: question.sessionId,
        text: renderAnswerPrompt(question.questions, answers),
        // Harness context, not the person's words: the transcript draws it as the answered question.
        parts: [{ type: 'text', text: renderAnswerPrompt(question.questions, answers), synthetic: true }],
        userId: loaded.userId,
      }, { wait: false });
      return c.json({ ok: outcome === 'delivered' || outcome === 'queued', delivery: outcome });
    },
  );
}

/**
 * Decide a permission ask. The runtime takes it live when the call still waits;
 * otherwise the decision is stored (an approval waits for the agent's re-run of
 * the same call) and the agent hears it as a new message.
 */
async function decidePermission(input: {
  ask: NonNullable<Awaited<ReturnType<typeof getPendingPermission>>>;
  reply: PermissionDecision;
  userId: string;
}): Promise<{ ok: boolean; delivery: string; code?: string }> {
  const { ask, reply, userId } = input;
  const decided = await decidePendingPermission({ id: ask.id, decision: reply, decidedBy: userId });
  if (!decided) return { ok: false, delivery: 'none', code: 'ALREADY_DECIDED' };
  const live = await replyRuntimePermission(ask.sessionId, ask.requestId, reply);
  if (live === 'released') {
    await markPermissionConsumed(ask.id);
    return { ok: true, delivery: 'delivered' };
  }
  // A denial needs no re-run to consume it.
  if (reply === 'reject') await markPermissionConsumed(ask.id);
  const outcome = await deliverThroughQueue({
    source: 'ui',
    idempotencyKey: `permission:${ask.sessionId}:${ask.requestId}`,
    sessionId: ask.sessionId,
    text: renderPermissionDecisionPrompt(ask, reply),
    // Harness context: the re-run call (or the agent's reply) is what the transcript shows.
    parts: [{ type: 'text', text: renderPermissionDecisionPrompt(ask, reply), synthetic: true }],
    userId,
  }, { wait: false }).catch((err) => {
    logger.warn('[asks] permission decision not delivered', { sessionId: ask.sessionId, error: err instanceof Error ? err.message : String(err) });
    return 'failed' as const;
  });
  return { ok: outcome === 'delivered' || outcome === 'queued', delivery: outcome };
}
