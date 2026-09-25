/** Agent questions: the sandbox `turn-question` relay and the session question read/answer routes. */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { QuestionInfo } from '../../channels/slack-webhook';
import { relayTurnQuestion } from '../../channels/turn-relay';
import { channelOfSessionMetadata, releaseChannelQuestion } from '../../channels/question-release';
import { PROJECT_ACTIONS } from '../../iam';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { continueSession } from '../session-lifecycle';
import {
  getOpenQuestion,
  recordPendingQuestion,
  renderAnswerPrompt,
  resolvePendingQuestion,
} from '../lib/pending-questions';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
import { readBody } from '../lib/serializers';

// POST /v1/projects/:projectId/turn-question
// Sandbox-to-apps/api relay for opencode's `question.asked` event. The
// sandbox subscribes to opencode's SSE stream; when the agent calls the
// built-in `question` tool, the sandbox relays the QuestionInfo[] here.
// We post a Block Kit form, block on Submit, return `answers: string[][]`,
// and the sandbox POSTs the same payload to opencode's
// /question/{requestID}/reply so the tool resumes.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/turn-question',
    tags: ['projects'],
    summary: 'POST /:projectId/turn-question',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');

    // The session this credential is BOUND to, when it is a sandbox token.
    // Null for a human caller.
    let callerSandboxSessionId: string | null = null;

    if (isSessionSandboxCredential(c)) {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'turn-question requires a sandbox token' }, 403);
      }
      const [sandbox] = await db
        .select({
          sandboxId: sessionSandboxes.sandboxId,
          sessionId: sessionSandboxes.sessionId,
        })
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
      callerSandboxSessionId = sandbox.sessionId ?? sandbox.sandboxId;
    } else {
      // A question card finalizes and re-posts a LIVE turn, so it is a
      // mutation of that session — 'read' is too weak. The sibling turn-stream
      // route already requires more than read for the same reason.
      const loaded = await loadProjectForUser(c, projectId, 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
    }

    let body: {
      session_id?: string;
      request_id?: string;
      questions?: unknown[];
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const sessionId = body.session_id?.trim();
    if (!sessionId) {
      return c.json({ error: 'session_id is required' }, 400);
    }

    // session_id is caller-supplied. Scoping it to :projectId closes the
    // cross-TENANT hole, but a sandbox token acts for exactly ONE session, so
    // project scope still let sandbox A finalize and repost session B's live
    // turn. sandbox_id == session_id by construction — bind to it.
    if (
      callerSandboxSessionId !== null &&
      !sandboxTokenMayActOnSession(callerSandboxSessionId, sessionId)
    ) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }

    const [turnQuestionSession] = await db
      .select({ sessionId: projectSessions.sessionId, metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!turnQuestionSession) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      return c.json({ error: 'at least one question is required' }, 400);
    }

    // Validate + coerce to QuestionInfo[]. Tolerate the v2 SDK schema variants.
    const questions: QuestionInfo[] = [];
    for (const q of body.questions) {
      if (!q || typeof q !== 'object') continue;
      const obj = q as Record<string, unknown>;
      const question = String(obj.question ?? '').trim();
      if (!question) continue;
      const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
      const options = optionsRaw
        .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>) : null))
        // opencode's QuestionInfo carries `value` (required) + optional `label`. The
        // harness `question` tool uses `label`. Accept EITHER so an option that only
        // has `value` still renders a button instead of silently vanishing.
        .filter(
          (o): o is Record<string, unknown> =>
            !!o && (typeof o.label === 'string' || typeof o.value === 'string'),
        )
        .map((o) => ({
          label: String(o.label ?? o.value),
          description: typeof o.description === 'string' ? String(o.description) : undefined,
        }));
      questions.push({
        question,
        header: obj.header ? String(obj.header) : undefined,
        options,
        multiple: !!obj.multiple,
        custom: obj.custom === false ? false : true,
      });
    }
    if (questions.length === 0) {
      return c.json({ error: 'no valid questions provided' }, 400);
    }

    // PERSIST FIRST, and independently of any channel.
    //
    // A waiting turn makes no gateway LLM calls, earns no deadline extension,
    // and its box is parked on schedule — correct, and the bounded-lifetime
    // invariant depends on it. What parking used to destroy is the question
    // itself: opencode restarts cold, so the user returned to a session that had
    // forgotten what it asked. Storing it out here lets the box die on time and
    // the conversation survive it. See lib/pending-questions.ts.
    //
    // Deliberately does NOT touch the deadline. A box that could keep itself
    // alive by reporting "still waiting" is the self-renewal this design
    // deleted.
    const resolvedAccountId = (c as any).get('accountId') as string | undefined;
    if (resolvedAccountId) {
      await recordPendingQuestion({
        accountId: resolvedAccountId,
        projectId,
        sessionId,
        requestId: body.request_id?.trim() || `q-${sessionId}`,
        opencodeSessionId: (body as { opencode_session_id?: string }).opencode_session_id ?? null,
        questions,
      }).catch((err) => {
        // Never fail the relay on a bookkeeping error — the agent is blocked and
        // the channel render is still worth attempting.
        console.warn('[turn-question] could not persist pending question:', err);
        return null;
      });
    }

    // Non-blocking: post the question(s) into the thread and return immediately
    // with sentinel `answers`. The agent does NOT wait for an inline answer — the
    // user's in-thread reply arrives as a follow-up turn. Returning `answers` keeps
    // BOTH the new sandbox (ignores them, uses its own sentinel) and an old sandbox
    // image (resumes opencode from them) unblocked.
    //
    // A session with no channel has nothing to post to. That is not an error now
    // that the question is durable: it is the ordinary web case, and failing here
    // would make the relay look broken for every non-Slack session.
    const result = await relayTurnQuestion(sessionId, questions);

    // Release the runtime's BLOCKING `question` call for a chat-channel session
    // — see channels/question-release.ts. Keyed on the session's own metadata,
    // not the live-turn row, and only with a real runtime question id: the
    // `q-<session>` fallback above names nothing the runtime can answer.
    // A dashboard session is left alone; its UI answers the question itself.
    const channel = channelOfSessionMetadata(turnQuestionSession.metadata);
    const runtimeRequestId = body.request_id?.trim();
    if (channel && runtimeRequestId) {
      await releaseChannelQuestion({
        sessionId,
        requestId: runtimeRequestId,
        questionCount: questions.length,
        channel,
        posted: result.ok,
      });
    }

    if (!result.ok) {
      return c.json({ ok: true, persisted: true, answers: [], channel_error: result.error });
    }
    return c.json({ ok: true, persisted: true, answers: result.answers });
  },
);

// GET  /v1/projects/:projectId/sessions/:sessionId/question
// POST /v1/projects/:projectId/sessions/:sessionId/question
//
// The restore half of park-and-restore. The ask survives its sandbox (see
// lib/pending-questions.ts); these two close the loop.
//
// GET returns the open question so a resumed session can render what it is
// waiting on, instead of showing a conversation that mysteriously stopped.
//
// POST answers it. The answer CANNOT go back to the call that blocked — that
// opencode process was parked and restarted cold, so its request id no longer
// exists and nothing is waiting on it. It is delivered as a FOLLOW-UP TURN,
// which is exactly how the channel path has always worked ("the user's
// in-thread reply arrives as a follow-up turn", above), and continueSession
// already owns waking a parked box and queueing until it is ready.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/question',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/question',
    ...auth,
    request: { params: z.object({ projectId: z.string(), sessionId: z.string() }) },
    responses: { 200: json(AnyObject, 'Open question, or null'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // The question text is session CONTENT, so it sits behind the same leaf the
    // other session-content reads use (projects/routes/project-sessions.ts). `loadProjectForUser(…, 'read')`
    // is only the coarse project floor: a caller whose custom role or scoped
    // token has `project.session.read` revoked still clears it.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      c.get('sessionId') ?? null,
      callerKortixSessionId(c),
    );
    if (!visible) return c.json({ error: 'Not found' }, 404);
    return c.json({ question: await getOpenQuestion(sessionId) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/question',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/question',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(AnyObject, 'Answer delivered'), ...errors(400, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    // The `question` tool exists so the agent YIELDS TO A HUMAN. An
    // agent-session token is scoped to its own session, which is precisely the
    // session holding the question it just asked — so if it could POST here it
    // would answer itself and resume, and the tool would be decorative.
    //
    // Denied outright rather than scope-gated: `assertAgentScope(…
    // PROJECT_SESSION_START)` is the usual bar for starting a turn, but that
    // leaf ships in the default agent preset (accounts/iam/role-presets.ts), so
    // it would admit the self-answer on a stock grant. Answering is a human
    // operation. Same shape as the token-minting guard in project-credentials.ts.
    if (isProjectSessionPrincipal(c)) {
      return c.json({ error: 'Agent-session tokens cannot answer their own question' }, 403);
    }
    // Answering resumes a parked box and starts a turn, so this is a mutation
    // of the session — the same bar the question relay itself uses.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      c.get('sessionId') ?? null,
      callerKortixSessionId(c),
    );
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const body = await readBody(c);
    const answers = (body as { answers?: unknown }).answers;
    if (!Array.isArray(answers) || answers.length === 0) {
      return c.json({ error: 'answers must be a non-empty array' }, 400);
    }

    const open = await getOpenQuestion(sessionId);
    if (!open) return c.json({ error: 'no open question for this session' }, 409);

    const requestId = (body as { request_id?: string }).request_id?.trim() || open.request_id;
    // CAS: closing the question is what claims the right to deliver it. Two
    // clients answering at once must produce ONE follow-up turn, not two.
    const claimed = await resolvePendingQuestion({ sessionId, requestId, answers });
    if (!claimed) {
      return c.json({ error: 'question was already answered', code: 'ALREADY_ANSWERED' }, 409);
    }

    const outcome = await continueSession({
      source: 'ui',
      sessionId,
      text: renderAnswerPrompt(open.questions, answers),
      userId: loaded.userId,
    });

    // 'pending' is success: the box is parked and continueSession has queued the
    // turn for when it is back. Reporting that as failure would invite a retry
    // that the CAS above would refuse, stranding the answer.
    return c.json({ ok: outcome === 'delivered' || outcome === 'pending', delivery: outcome });
  },
);
